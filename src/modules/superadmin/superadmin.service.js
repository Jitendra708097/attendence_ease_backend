const { Op } = require('sequelize');
const {  AuditLog, Attendance, Branch, Department, Employee, ImpersonationSession, Organisation, RefreshToken, Shift, sequelize } = require('../../models');
const { compareValue, hashValue, signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/auth');
const { getPagination } = require('../../utils/pagination');
const { redisClient } = require('../../config/redis');
const queues = require('../../queues');
const { queueWelcomeEmail } = require('../notification/notification.service');
const { PLAN_PRICES } = require('../../utils/constants');

const ALLOWED_PLANS = ['trial', 'standard'];


function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getRefreshExpiryDate() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

function deriveOrgStatus(org) {
  if (!org.is_active) {
    return 'suspended';
  }

  if (org.plan === 'trial') {
    return 'trial';
  }

  return 'active';
}

function formatSuperadminProfile(employee) {
  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    role: employee.role,
    orgId: null,
  };
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function buildTempPassword() {
  return `AE${Math.random().toString(36).slice(2, 6).toUpperCase()}!${String(Date.now()).slice(-4)}`;
}

async function issueSuperadminTokens(employee, meta = {}) {
  const payload = {
    id: employee.id,
    orgId: null,
    role: 'superadmin',
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const tokenHash = await hashValue(refreshToken);

  await RefreshToken.create({
    emp_id: employee.id,
    token_hash: tokenHash,
    device_id: meta.deviceId || 'superadmin-web',
    status: 'active',
    expires_at: getRefreshExpiryDate(),
  });

  return { accessToken, refreshToken };
}

async function login({ email, password }) {
  const employee = await Employee.findOne({
    where: {
      email: String(email || '').trim().toLowerCase(),
      role: 'superadmin',
      is_active: true,
    },
  });

  if (!employee || !employee.password_hash) {
    throw createError('AUTH_001', 'Invalid credentials', 401);
  }

  const isValid = await compareValue(password, employee.password_hash);

  if (!isValid) {
    throw createError('AUTH_001', 'Invalid credentials', 401);
  }

  const tokens = await issueSuperadminTokens(employee);

  return {
    ...tokens,
    user: formatSuperadminProfile(employee),
  };
}

async function refresh(refreshToken) {
  const payload = verifyRefreshToken(refreshToken);

  if (payload.role !== 'superadmin') {
    throw createError('AUTH_002', 'Invalid refresh token', 401);
  }

  const employee = await Employee.findOne({
    where: {
      id: payload.id,
      role: 'superadmin',
      is_active: true,
    },
  });

  if (!employee) {
    throw createError('AUTH_002', 'Invalid refresh token', 401);
  }

  const tokens = await RefreshToken.findAll({
    where: {
      emp_id: employee.id,
      status: {
        [Op.in]: ['active', 'used'],
      },
    },
    order: [['created_at', 'DESC']],
  });

  let matchedToken = null;

  for (const tokenRecord of tokens) {
    const isMatch = await compareValue(refreshToken, tokenRecord.token_hash);

    if (isMatch) {
      matchedToken = tokenRecord;
      break;
    }
  }

  if (!matchedToken) {
    throw createError('AUTH_002', 'Invalid refresh token', 401);
  }

  if (matchedToken.status === 'used') {
    await RefreshToken.update(
      { status: 'revoked' },
      {
        where: {
          emp_id: employee.id,
        },
      }
    );

    throw createError('AUTH_007', 'Refresh token reuse detected', 401);
  }

  await matchedToken.update({ status: 'used' });
  return issueSuperadminTokens(employee, { deviceId: matchedToken.device_id });
}

async function logout({ employeeId, refreshToken }) {
  const tokens = await RefreshToken.findAll({
    where: {
      emp_id: employeeId,
      status: 'active',
    },
  });

  for (const tokenRecord of tokens) {
    const isMatch = refreshToken ? await compareValue(refreshToken, tokenRecord.token_hash) : false;

    if (!refreshToken || isMatch) {
      await tokenRecord.update({ status: 'revoked' });
    }
  }

  return { revoked: true };
}

async function getMe(employeeId) {
  const employee = await Employee.findOne({
    where: {
      id: employeeId,
      role: 'superadmin',
    },
  });

  if (!employee) {
    throw createError('HTTP_404', 'Superadmin not found', 404);
  }

  return formatSuperadminProfile(employee);
}

async function buildOrgSummary(org) {
  const [employeeCount, branchCount] = await Promise.all([
    Employee.count({
      where: {
        org_id: org.id,
        role: {
          [Op.ne]: 'superadmin',
        },
      },
    }),
    Branch.count({
      where: {
        org_id: org.id,
      },
    }),
  ]);

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    status: deriveOrgStatus(org),
    isActive: Boolean(org.is_active),
    employeeCount,
    branchCount,
    trialEndsAt: org.trial_ends_at,
    createdAt: org.created_at,
    updatedAt: org.updated_at,
    timezone: org.timezone,
    settings: org.settings || {},
    mrr: employeeCount * (PLAN_PRICES[org.plan] || 0),
  };
}

async function listOrgs(query = {}) {
  const { page, limit, offset } = getPagination(query);
  const search = String(query.search || query.q || '').trim();
  const where = {};

  if (query.plan) {
    where.plan = query.plan;
  }

  if (query.status === 'suspended') {
    where.is_active = false;
  } else if (query.status === 'active' || query.status === 'trial') {
    where.is_active = true;
  }

  if (search) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { slug: { [Op.iLike]: `%${search}%` } },
    ];
  }

  const orderFieldMap = {
    createdAt: 'created_at',
    name: 'name',
    plan: 'plan',
  };

  const orderField = orderFieldMap[query.sortBy] || 'created_at';
  const orderDirection = String(query.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const result = await Organisation.findAndCountAll({
    where,
    limit,
    offset,
    order: [[orderField, orderDirection]],
  });

  const orgs = await Promise.all(result.rows.map(buildOrgSummary));
  const filtered = query.status === 'trial'
    ? orgs.filter((org) => org.status === 'trial')
    : query.status === 'active'
      ? orgs.filter((org) => org.status === 'active')
      : orgs;

  return {
    orgs: filtered,
    total: query.status === 'trial' || query.status === 'active' ? filtered.length : result.count,
    page,
    limit,
  };
}

async function createOrg(payload) {
  const orgName = String(payload.orgName || '').trim();
  const adminFirstName = String(payload.adminFirstName || '').trim();
  const adminLastName = String(payload.adminLastName || '').trim();
  const adminEmail = String(payload.adminEmail || '').trim().toLowerCase();
  const adminPhone = String(payload.adminPhone || '').trim();
  const plan = payload.plan || 'trial';
  const timezone = payload.timezone || 'Asia/Kolkata';

  if (!ALLOWED_PLANS.includes(plan)) {
    throw createError('SA_025', 'Invalid organisation plan', 422, [
      { field: 'plan', message: 'Plan must be trial or standard' },
    ]);
  }

  if (!orgName || !adminFirstName || !adminEmail) {
    throw createError('SA_023', 'Organisation name, admin name, and admin email are required', 422, [
      { field: 'orgName', message: 'Organisation name is required' },
      { field: 'adminFirstName', message: 'Admin first name is required' },
      { field: 'adminEmail', message: 'Admin email is required' },
    ]);
  }

  const existingEmployee = await Employee.findOne({
    where: {
      email: adminEmail,
    },
  });

  if (existingEmployee) {
    throw createError('SA_024', 'An employee with this email already exists', 409);
  }

  const baseSlug = normalizeSlug(orgName) || 'organisation';
  let slug = baseSlug;
  let suffix = 1;

  while (await Organisation.findOne({ where: { slug } })) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  const adminName = [adminFirstName, adminLastName].filter(Boolean).join(' ');
  const tempPassword = buildTempPassword();
  const passwordHash = await hashValue(tempPassword);

  const createdOrg = await sequelize.transaction(async (transaction) => {
    const organisation = await Organisation.create(
      {
        name: orgName,
        slug,
        plan,
        timezone,
        trial_ends_at: plan === 'trial' ? new Date(Date.now() + 15 * 24 * 60 * 60 * 1000) : null,
        is_active: true,
        settings: {
          timezone,
        },
      },
      { transaction }
    );

    const branch = await Branch.create(
      {
        org_id: organisation.id,
        name: 'Head Office',
        address: null,
        geo_fence_polygons: [],
        allowed_bssids: [],
      },
      { transaction }
    );

    const department = await Department.create(
      {
        org_id: organisation.id,
        name: 'Administration',
      },
      { transaction }
    );

    const shift = await Shift.create(
      {
        org_id: organisation.id,
        name: 'General Shift',
        start_time: '09:00:00',
        end_time: '18:00:00',
        crosses_midnight: false,
        work_days: [1, 2, 3, 4, 5],
        grace_minutes_checkin: 15,
        grace_minutes_checkout: 60,
        half_day_after_minutes: 240,
        absent_after_minutes: 120,
        overtime_after_minutes: 480,
        min_overtime_minutes: 30,
        break_minutes: 60,
        min_session_minutes: 30,
        session_cooldown_minutes: 15,
        max_sessions_per_day: 3,
      },
      { transaction }
    );

    await Employee.create(
      {
        org_id: organisation.id,
        branch_id: branch.id,
        department_id: department.id,
        shift_id: shift.id,
        emp_code: `${slug.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'ORG'}-0001`,
        name: adminName,
        email: adminEmail,
        phone: adminPhone || null,
        role: 'admin',
        password_hash: passwordHash,
        trust_score: 'probationary',
        checkin_count: 0,
        leave_balance: {},
        is_active: true,
        temp_password: tempPassword,
        password_changed: false,
      },
      { transaction }
    );

    return organisation;
  });

  let welcomeEmailQueued = false;
  let welcomeEmailError = null;

  try {
    const welcomeEmail = await queueWelcomeEmail({
      email: adminEmail,
      organisationName: orgName,
      employeeName: adminName,
      tempPassword,
    });
    welcomeEmailQueued = Boolean(welcomeEmail && welcomeEmail.queued);
  } catch (error) {
    welcomeEmailError = error.message;
  }

  const detail = await getOrgDetail(createdOrg.id);

  return {
    ...detail,
    adminEmail,
    adminName,
    welcomeEmailQueued,
    welcomeEmailError,
  };
}

async function getOrgDetail(orgId) {
  const org = await Organisation.findOne({
    where: {
      id: orgId,
    },
  });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const [summary, owner] = await Promise.all([
    buildOrgSummary(org),
    Employee.findOne({
      where: {
        org_id: orgId,
        role: 'admin',
      },
      order: [['created_at', 'ASC']],
    }),
  ]);

  return {
    ...summary,
    ownerEmail: owner ? owner.email : null,
  };
}

async function getOrgEmployees(orgId, query = {}) {
  const where = {
    org_id: orgId,
    role: {
      [Op.ne]: 'superadmin',
    },
  };

  if (query.role) {
    where.role = query.role;
  }

  const result = await Employee.findAndCountAll({
    where,
    include: [
      {
        model: Department,
        as: 'department',
        attributes: ['id', 'name'],
      },
    ],
    order: [['created_at', 'DESC']],
    limit: Number(query.limit || 20),
  });

  return {
    employees: result.rows.map((employee) => ({
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      department: employee.department ? { id: employee.department.id, name: employee.department.name } : null,
      status: employee.is_active ? 'active' : 'suspended',
    })),
    total: result.count,
  };
}

async function getOrgAttendanceToday(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await Attendance.findAll({
    where: {
      org_id: orgId,
      date: today,
    },
    attributes: ['status', 'first_check_in', 'last_check_out', 'is_late'],
  });

  const summary = {
    present: 0,
    absent: 0,
    late: 0,
    checkedIn: 0,
  };

  rows.forEach((row) => {
    if (row.status === 'present') {
      summary.present += 1;
    }
    if (row.status === 'absent') {
      summary.absent += 1;
    }
    if (row.is_late) {
      summary.late += 1;
    }
    if (row.first_check_in && !row.last_check_out) {
      summary.checkedIn += 1;
    }
  });

  return summary;
}

async function getOrgBilling(orgId) {
  const org = await getOrgDetail(orgId);

  return {
    invoices: [
      {
        id: `invoice-${org.id}`,
        date: org.updatedAt || org.createdAt,
        amount: org.mrr,
        status: org.status === 'suspended' ? 'overdue' : 'paid',
      },
    ],
  };
}

async function suspendOrg({ orgId }) {
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  await org.update({ is_active: false });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function activateOrg({ orgId }) {
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  await org.update({ is_active: true });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function changePlan({ orgId, plan }) {
  if (!ALLOWED_PLANS.includes(plan)) {
    throw createError('SA_025', 'Invalid organisation plan', 422, [
      { field: 'plan', message: 'Plan must be trial or standard' },
    ]);
  }

  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  await org.update({ plan });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function extendTrial({ orgId, extendByDays }) {
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const current = org.trial_ends_at ? new Date(org.trial_ends_at) : new Date();
  const next = new Date(current.getTime() + Number(extendByDays || 0) * 24 * 60 * 60 * 1000);
  const oldValue = org.toJSON();
  await org.update({ trial_ends_at: next });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const previousMonth = new Date(startOfMonth);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);

  const [orgs, totalEmployees, checkedInNow, newOrgsMTD, newOrgsPrev, totalAttendanceToday] = await Promise.all([
    Organisation.findAll(),
    Employee.count({
      where: {
        role: {
          [Op.ne]: 'superadmin',
        },
      },
    }),
    Attendance.count({
      where: {
        date: today,
        first_check_in: {
          [Op.ne]: null,
        },
        last_check_out: null,
      },
    }),
    Organisation.count({
      where: {
        created_at: {
          [Op.gte]: startOfMonth,
        },
      },
    }),
    Organisation.count({
      where: {
        created_at: {
          [Op.gte]: previousMonth,
          [Op.lt]: startOfMonth,
        },
      },
    }),
    Attendance.count({
      where: {
        date: today,
      },
    }),
  ]);

  const activeOrgs = orgs.filter((org) => org.is_active && org.plan !== 'trial').length;
  const trialOrgs = orgs.filter((org) => org.is_active && org.plan === 'trial').length;
  const totalOrgs = orgs.length;
  const mrr = orgs.reduce((sum, org) => sum + (PLAN_PRICES[org.plan] || 0), 0);

  const recentSignups = await Promise.all(
    orgs
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map(async (org) => {
        const employeeCount = await Employee.count({
          where: {
            org_id: org.id,
            role: {
              [Op.ne]: 'superadmin',
            },
          },
        });

        return {
          id: org.id,
          name: org.name,
          plan: org.plan,
          employeeCount,
          createdAt: org.created_at,
        };
      })
  );

  const alerts = orgs
    .filter((org) => org.plan === 'trial' && org.trial_ends_at)
    .sort((a, b) => new Date(a.trial_ends_at) - new Date(b.trial_ends_at))
    .slice(0, 5)
    .map((org) => ({
      type: 'trial_expiring',
      orgId: org.id,
      orgName: org.name,
      detail: `Trial ends on ${new Date(org.trial_ends_at).toISOString().slice(0, 10)}`,
      createdAt: org.updated_at || org.created_at,
    }));

  const months = Array.from({ length: 6 }).map((_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (5 - index));
    return date;
  });

  const mrrTrend = months.map((date) => ({
    month: date.toISOString().slice(0, 7),
    value: mrr,
  }));

  const orgGrowth = await Promise.all(
    months.map(async (date) => {
      const start = new Date(date);
      const end = new Date(date);
      end.setUTCMonth(end.getUTCMonth() + 1);

      const count = await Organisation.count({
        where: {
          created_at: {
            [Op.gte]: start,
            [Op.lt]: end,
          },
        },
      });

      return {
        month: start.toISOString().slice(0, 7),
        value: count,
      };
    })
  );

  const queueHealth = await Promise.all(
    Object.entries(queues).map(async ([name, queue]) => {
      const counts = await queue.getJobCounts();
      return {
        name,
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
      };
    })
  );

  return {
    stats: {
      totalOrgs,
      activeOrgs,
      trialOrgs,
      totalEmployees,
      checkedInNow,
      mrr,
      newOrgsMTD,
      newOrgsPrev,
      orgTrend: newOrgsMTD >= newOrgsPrev ? 'up' : 'down',
      orgTrendValue: `${Math.abs(newOrgsMTD - newOrgsPrev)}`,
      employeeTrend: 'up',
      employeeTrendValue: `${totalEmployees}`,
      mrrTrend: 'up',
      mrrTrendValue: `${mrr}`,
    },
    mrrTrend,
    orgGrowth,
    alerts,
    recentSignups,
    health: {
      database: 'healthy',
      redis: redisClient.status === 'ready' ? 'healthy' : 'degraded',
      api: 'healthy',
      uptime: process.uptime(),
      dbLatency: 0,
      redisLatency: 0,
      queues: queueHealth,
      failedJobs: [],
      metrics: {
        responseTime: months.map((date) => ({ time: date.toISOString().slice(5, 7), p95: 120 })),
        errorRate: months.map((date) => ({ time: date.toISOString().slice(5, 7), rate: 0.2 })),
        requests: months.map((date) => ({ time: date.toISOString().slice(5, 7), count: totalAttendanceToday })),
      },
    },
  };
}

async function getAuditLogs(query = {}) {
  const { page, limit, offset } = getPagination(query);
  const where = {};

  if (query.orgId) {
    where.org_id = query.orgId;
  }

  if (query.action) {
    where.action = query.action;
  }

  if (query.startDate || query.endDate) {
    where.created_at = {};

    if (query.startDate) {
      where.created_at[Op.gte] = new Date(query.startDate);
    }

    if (query.endDate) {
      where.created_at[Op.lte] = new Date(query.endDate);
    }
  }

  const result = await AuditLog.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  const orgIds = [...new Set(result.rows.map((row) => row.org_id).filter(Boolean))];
  const actorIds = [...new Set(result.rows.map((row) => row.actor_id).filter(Boolean))];

  const [orgs, actors] = await Promise.all([
    orgIds.length > 0
      ? Organisation.findAll({ where: { id: { [Op.in]: orgIds } }, attributes: ['id', 'name', 'slug'] })
      : [],
    actorIds.length > 0
      ? Employee.findAll({ where: { id: { [Op.in]: actorIds } }, attributes: ['id', 'name', 'email'] })
      : [],
  ]);

  const orgMap = Object.fromEntries(orgs.map((org) => [org.id, org]));
  const actorMap = Object.fromEntries(actors.map((actor) => [actor.id, actor]));

  return {
    logs: result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      createdAt: row.created_at,
      orgId: row.org_id,
      orgName: row.org_id && orgMap[row.org_id] ? orgMap[row.org_id].name : null,
      orgSlug: row.org_id && orgMap[row.org_id] ? orgMap[row.org_id].slug : null,
      performedByName: row.actor_id && actorMap[row.actor_id] ? actorMap[row.actor_id].name : null,
      ipAddress: row.ip_address,
      impersonatedBy: row.impersonated_by,
      metadata: {
        entityType: row.entity_type,
        entityId: row.entity_id,
        oldValue: row.old_value,
        newValue: row.new_value,
        actorRole: row.actor_role,
        userAgent: row.user_agent,
      },
    })),
    total: result.count,
    page,
    limit,
  };
}

async function startImpersonation({ superAdminId, orgId, adminId, reason }) {
  const targetOrg = await Organisation.findOne({ where: { id: orgId } });

  if (!targetOrg) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const targetAdmin = await Employee.findOne({
    where: {
      id: adminId,
      org_id: orgId,
      role: 'admin',
      is_active: true,
    },
  });

  if (!targetAdmin) {
    throw createError('HTTP_404', 'Admin employee not found for this organisation', 404);
  }

  await ImpersonationSession.update(
    { ended_at: new Date() },
    {
      where: {
        super_admin_id: superAdminId,
        ended_at: null,
      },
    }
  );

  const session = await ImpersonationSession.create({
    super_admin_id: superAdminId,
    target_org_id: orgId,
    target_emp_id: targetAdmin.id,
    reason,
    started_at: new Date(),
  });

  const token = signAccessToken({
    id: targetAdmin.id,
    orgId,
    role: 'admin',
    impersonatedBy: superAdminId,
  });

  return {
    id: session.id,
    orgId,
    orgName: targetOrg.name,
    adminId: targetAdmin.id,
    adminName: targetAdmin.name,
    adminEmail: targetAdmin.email,
    token,
    startedAt: session.started_at,
    reason: session.reason,
  };
}

async function endImpersonation({ superAdminId, sessionId }) {
  const where = {
    super_admin_id: superAdminId,
    ended_at: null,
  };

  if (sessionId) {
    where.id = sessionId;
  }

  const session = await ImpersonationSession.findOne({ where });

  if (!session) {
    throw createError('HTTP_404', 'Active impersonation session not found', 404);
  }

  await session.update({ ended_at: new Date() });
  return { ended: true, id: session.id };
}

async function getActiveImpersonation(superAdminId) {
  const session = await ImpersonationSession.findOne({
    where: {
      super_admin_id: superAdminId,
      ended_at: null,
    },
    order: [['started_at', 'DESC']],
  });

  if (!session) {
    return null;
  }

  const [org, admin] = await Promise.all([
    Organisation.findOne({ where: { id: session.target_org_id } }),
    Employee.findOne({ where: { id: session.target_emp_id } }),
  ]);

  return {
    id: session.id,
    orgId: session.target_org_id,
    orgName: org ? org.name : null,
    adminName: admin ? admin.name : null,
    adminEmail: admin ? admin.email : null,
    startedAt: session.started_at,
    endedAt: session.ended_at,
  };
}

async function getImpersonationHistory(superAdminId, query = {}) {
  const { page, limit, offset } = getPagination(query);
  const result = await ImpersonationSession.findAndCountAll({
    where: {
      super_admin_id: superAdminId,
    },
    order: [['started_at', 'DESC']],
    limit,
    offset,
  });

  const orgIds = [...new Set(result.rows.map((row) => row.target_org_id).filter(Boolean))];
  const adminIds = [...new Set(result.rows.map((row) => row.target_emp_id).filter(Boolean))];

  const [orgs, admins] = await Promise.all([
    orgIds.length > 0
      ? Organisation.findAll({ where: { id: { [Op.in]: orgIds } }, attributes: ['id', 'name', 'slug'] })
      : [],
    adminIds.length > 0
      ? Employee.findAll({ where: { id: { [Op.in]: adminIds } }, attributes: ['id', 'name', 'email'] })
      : [],
  ]);

  const orgMap = Object.fromEntries(orgs.map((org) => [org.id, org]));
  const adminMap = Object.fromEntries(admins.map((admin) => [admin.id, admin]));

  return {
    sessions: result.rows.map((row) => ({
      id: row.id,
      orgId: row.target_org_id,
      orgName: row.target_org_id && orgMap[row.target_org_id] ? orgMap[row.target_org_id].name : null,
      orgSlug: row.target_org_id && orgMap[row.target_org_id] ? orgMap[row.target_org_id].slug : null,
      adminName: row.target_emp_id && adminMap[row.target_emp_id] ? adminMap[row.target_emp_id].name : null,
      adminEmail: row.target_emp_id && adminMap[row.target_emp_id] ? adminMap[row.target_emp_id].email : null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      reason: row.reason,
    })),
    total: result.count,
    page,
    limit,
  };
}

module.exports = {
  login,
  refresh,
  logout,
  getMe,
  createOrg,
  listOrgs,
  getOrgDetail,
  getOrgEmployees,
  getOrgAttendanceToday,
  getOrgBilling,
  suspendOrg,
  activateOrg,
  changePlan,
  extendTrial,
  getStats,
  getAuditLogs,
  startImpersonation,
  endImpersonation,
  getActiveImpersonation,
  getImpersonationHistory,
};
