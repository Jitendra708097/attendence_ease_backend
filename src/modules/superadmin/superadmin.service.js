const { Op } = require('sequelize');
const {  AuditLog, Attendance, Branch, Department, Employee, ImpersonationSession, Organisation, PaymentRecord, RefreshToken, Shift, sequelize } = require('../../models');
const { compareValue, hashValue, signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/auth');
const { getPagination } = require('../../utils/pagination');
const { redisClient } = require('../../config/redis');
const env = require('../../config/env');
const queues = require('../../queues');
const { queueWelcomeEmail, queueBillingAlertEmail } = require('../notification/notification.service');
const { PLAN_PRICES } = require('../../utils/constants');

const ALLOWED_PLANS = ['trial', 'standard'];
const BILLING_ALERT_TYPES = [
  'payment_due',
  'payment_overdue',
  'payment_failed',
  'suspension_warning',
  'organisation_suspended',
  'trial_expiring',
];
const FEATURE_FLAGS = [
  'wifi_bssid_verification',
  'rekognition_liveness',
  'payroll_webhook',
  'multi_challenge_liveness',
  'texture_antispoofing',
  'ble_beacon_accuracy',
  'beta_dashboard',
];


function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getFeatureFlagRedisKey(flagKey) {
  return `feature_flag:${flagKey}:global`;
}

function normalizeOrgFeatureSettings(settings = {}) {
  const currentSettings = settings && typeof settings === 'object' ? settings : {};
  const featureFlags = currentSettings.featureFlags && typeof currentSettings.featureFlags === 'object'
    ? currentSettings.featureFlags
    : {};
  const overrides = featureFlags.overrides && typeof featureFlags.overrides === 'object'
    ? featureFlags.overrides
    : {};

  return {
    ...currentSettings,
    featureFlags: {
      ...featureFlags,
      overrides: { ...overrides },
    },
  };
}

function startOfUtcWeek(dateInput = new Date()) {
  const date = new Date(dateInput);
  date.setUTCHours(0, 0, 0, 0);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

function addUtcDays(dateInput, days) {
  const date = new Date(dateInput);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function startOfUtcMonth(dateInput = new Date()) {
  return new Date(Date.UTC(dateInput.getUTCFullYear(), dateInput.getUTCMonth(), 1));
}

function addUtcMonths(dateInput, months) {
  const date = new Date(dateInput);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatWeekLabel(dateInput) {
  const date = new Date(dateInput);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatMonthLabel(dateInput) {
  const date = new Date(dateInput);
  return date.toISOString().slice(0, 7);
}

function getOrgMonthlyMrr(org, employeeCount) {
  return Number(employeeCount || 0) * Number(PLAN_PRICES[org.plan] || 0);
}

function assertKnownFeatureFlag(flagKey) {
  if (!FEATURE_FLAGS.includes(flagKey)) {
    throw createError('SA_028', 'Feature flag not found', 404, [
      { field: 'key', message: 'Unknown feature flag key' },
    ]);
  }
}

async function getGlobalFeatureFlagState(flagKey) {
  const rawValue = await redisClient.get(getFeatureFlagRedisKey(flagKey));
  return rawValue === 'true';
}

async function setGlobalFeatureFlagState(flagKey, enabled) {
  await redisClient.set(getFeatureFlagRedisKey(flagKey), String(Boolean(enabled)));
  return Boolean(enabled);
}

function getRefreshExpiryDate() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

function buildImpersonationEmployee(admin, org, session, superAdminId) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: 'admin',
    orgId: org.id,
    orgName: org.name,
    isImpersonated: true,
    impersonatedBy: superAdminId,
    impersonationSessionId: session.id,
    impersonationStartedAt: session.started_at,
  };
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

async function sendBillingAlert({ orgId, alertType, customMessage }) {
  if (!BILLING_ALERT_TYPES.includes(alertType)) {
    throw createError('SA_026', 'Invalid billing alert type', 422, [
      { field: 'alertType', message: 'Unsupported billing alert type' },
    ]);
  }

  const [org, admin] = await Promise.all([
    Organisation.findOne({ where: { id: orgId } }),
    Employee.findOne({
      where: {
        org_id: orgId,
        role: 'admin',
        is_active: true,
      },
      order: [['created_at', 'ASC']],
    }),
  ]);

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  if (!admin || !admin.email) {
    throw createError('SA_027', 'Organisation admin email is unavailable', 422, [
      { field: 'orgId', message: 'No active admin with email found for this organisation' },
    ]);
  }

  const queuedEmail = await queueBillingAlertEmail({
    email: admin.email,
    organisationName: org.name,
    adminName: admin.name,
    alertType,
    customMessage,
  });

  return {
    queued: Boolean(queuedEmail?.queued),
    jobId: queuedEmail?.jobId || null,
    orgId: org.id,
    orgName: org.name,
    adminId: admin.id,
    adminName: admin.name,
    adminEmail: admin.email,
    alertType,
    customMessage: customMessage || null,
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
    isImpersonated: true,
    impersonatedBy: superAdminId,
    impersonationSessionId: session.id,
  }, { expiresIn: '30m' });

  return {
    id: session.id,
    orgId,
    orgName: targetOrg.name,
    adminId: targetAdmin.id,
    adminName: targetAdmin.name,
    adminEmail: targetAdmin.email,
    token,
    adminPortalUrl: env.frontend.adminUrl || null,
    expiresIn: 1800,
    employee: buildImpersonationEmployee(targetAdmin, targetOrg, session, superAdminId),
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
    orgSlug: org ? org.slug : null,
    adminId: admin ? admin.id : null,
    adminName: admin ? admin.name : null,
    adminEmail: admin ? admin.email : null,
    adminPortalUrl: env.frontend.adminUrl || null,
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

async function getAllFeatureFlags() {
  const orgs = await Organisation.findAll({
    attributes: ['id', 'name', 'slug', 'settings'],
    where: {
      is_active: true,
    },
    order: [['name', 'ASC']],
  });

  const flags = {};

  for (const flagKey of FEATURE_FLAGS) {
    const globalEnabled = await getGlobalFeatureFlagState(flagKey);
    const orgOverrides = [];

    for (const org of orgs) {
      const normalizedSettings = normalizeOrgFeatureSettings(org.settings);
      const overrideValue = normalizedSettings.featureFlags.overrides?.[flagKey];

      if (typeof overrideValue === 'boolean') {
        orgOverrides.push({
          orgId: org.id,
          orgName: org.name,
          orgSlug: org.slug,
          enabled: overrideValue,
        });
      }
    }

    flags[flagKey] = {
      globalEnabled,
      orgOverrides,
    };
  }

  return { flags };
}

async function setFeatureFlagGlobal({ flagKey, enabled }) {
  assertKnownFeatureFlag(flagKey);
  const globalEnabled = await setGlobalFeatureFlagState(flagKey, enabled);

  return {
    key: flagKey,
    globalEnabled,
  };
}

async function setFeatureFlagOrgOverride({ flagKey, orgId, enabled }) {
  assertKnownFeatureFlag(flagKey);

  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const nextSettings = normalizeOrgFeatureSettings(org.settings);
  nextSettings.featureFlags.overrides[flagKey] = Boolean(enabled);

  await org.update({ settings: nextSettings });

  return {
    key: flagKey,
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    enabled: Boolean(enabled),
  };
}

async function removeFeatureFlagOrgOverride({ flagKey, orgId }) {
  assertKnownFeatureFlag(flagKey);

  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const nextSettings = normalizeOrgFeatureSettings(org.settings);
  delete nextSettings.featureFlags.overrides[flagKey];

  await org.update({ settings: nextSettings });

  return {
    key: flagKey,
    orgId: org.id,
    removed: true,
  };
}

async function getFeatureFlagOrgs(flagKey) {
  assertKnownFeatureFlag(flagKey);

  const orgs = await Organisation.findAll({
    attributes: ['id', 'name', 'slug', 'settings'],
    order: [['name', 'ASC']],
  });

  const results = orgs
    .map((org) => {
      const normalizedSettings = normalizeOrgFeatureSettings(org.settings);
      const overrideValue = normalizedSettings.featureFlags.overrides?.[flagKey];

      if (typeof overrideValue !== 'boolean') {
        return null;
      }

      return {
        orgId: org.id,
        orgName: org.name,
        orgSlug: org.slug,
        enabled: overrideValue,
      };
    })
    .filter(Boolean);

  return {
    key: flagKey,
    orgs: results,
  };
}

async function getAnalyticsGrowth(query = {}) {
  const weeks = Math.max(1, Math.min(Number(query.weeks) || 12, 26));
  const months = Math.max(1, Math.min(Number(query.months) || 6, 24));
  const weekStart = startOfUtcWeek(new Date());
  const weekSeries = Array.from({ length: weeks }, (_, index) => addUtcDays(weekStart, -7 * (weeks - 1 - index)));
  const monthStart = startOfUtcMonth(new Date());
  const monthSeries = Array.from({ length: months }, (_, index) => addUtcMonths(monthStart, -(months - 1 - index)));

  const [orgs, employees] = await Promise.all([
    Organisation.findAll({
      attributes: ['id', 'created_at'],
      paranoid: false,
    }),
    Employee.findAll({
      attributes: ['id', 'created_at'],
      where: {
        role: {
          [Op.ne]: 'superadmin',
        },
      },
      paranoid: false,
    }),
  ]);

  const newOrgsWeekly = weekSeries.map((start) => {
    const end = addUtcDays(start, 7);
    const count = orgs.filter((org) => {
      const createdAt = new Date(org.created_at);
      return createdAt >= start && createdAt < end;
    }).length;

    return {
      week: formatWeekLabel(start),
      count,
    };
  });

  const employeeGrowth = monthSeries.map((start) => {
    const end = addUtcMonths(start, 1);
    const total = employees.filter((employee) => new Date(employee.created_at) < end).length;

    return {
      month: formatMonthLabel(start),
      total,
    };
  });

  return {
    newOrgsWeekly,
    employeeGrowth,
  };
}

async function getAnalyticsUsage(query = {}) {
  const days = Math.max(1, Math.min(Number(query.days) || 30, 90));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dateSeries = Array.from({ length: days }, (_, index) => addUtcDays(today, -(days - 1 - index)));

  const [attendanceRows, employees] = await Promise.all([
    Attendance.findAll({
      attributes: ['date'],
      where: {
        date: {
          [Op.gte]: dateSeries[0].toISOString().slice(0, 10),
          [Op.lte]: dateSeries[dateSeries.length - 1].toISOString().slice(0, 10),
        },
      },
      paranoid: false,
    }),
    Employee.findAll({
      attributes: ['face_embedding_local', 'face_embedding_id'],
      where: {
        role: {
          [Op.ne]: 'superadmin',
        },
      },
      paranoid: false,
    }),
  ]);

  const attendanceByDate = attendanceRows.reduce((acc, row) => {
    const key = row.date;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const enrolledEmployees = employees.filter(
    (employee) => Boolean(employee.face_embedding_id || employee.face_embedding_local)
  );
  const localCapableEmployees = enrolledEmployees.filter(
    (employee) => Array.isArray(employee.face_embedding_local) && employee.face_embedding_local.length === 128
  );
  const localFacePercent = enrolledEmployees.length > 0
    ? Math.round((localCapableEmployees.length / enrolledEmployees.length) * 100)
    : 0;

  return {
    checkinsDaily: dateSeries.map((date) => {
      const key = date.toISOString().slice(0, 10);
      return {
        date: key,
        count: attendanceByDate[key] || 0,
      };
    }),
    localFacePercent,
    cloudFacePercent: Math.max(0, 100 - localFacePercent),
  };
}

async function getAnalyticsRetention() {
  const now = new Date();
  const currentMonth = startOfUtcMonth(now);
  const cohortMonths = Array.from({ length: 6 }, (_, index) => addUtcMonths(currentMonth, -(6 - index)));
  const orgs = await Organisation.findAll({
    attributes: ['id', 'created_at', 'is_active', 'plan'],
    paranoid: false,
  });

  const cohorts = cohortMonths.map((monthStart) => {
    const monthEnd = addUtcMonths(monthStart, 1);
    const cohortOrgs = orgs.filter((org) => {
      const createdAt = new Date(org.created_at);
      return createdAt >= monthStart && createdAt < monthEnd;
    });
    const size = cohortOrgs.length;

    const monthData = {
      month: formatMonthLabel(monthStart),
      size,
    };

    for (let offset = 1; offset <= 6; offset += 1) {
      const evaluationMonthEnd = addUtcMonths(monthStart, offset + 1);
      const eligibleOrgs = cohortOrgs.filter((org) => new Date(org.created_at) < evaluationMonthEnd);
      const activeOrgs = eligibleOrgs.filter((org) => org.is_active);
      monthData[`m${offset}`] = eligibleOrgs.length > 0
        ? Math.round((activeOrgs.length / eligibleOrgs.length) * 100)
        : null;
    }

    return monthData;
  }).filter((cohort) => cohort.size > 0);

  return { cohorts };
}

async function getBillingOverviewData() {
  const [orgs, employeeCounts, paymentRecords] = await Promise.all([
    Organisation.findAll({
      attributes: ['id', 'name', 'slug', 'plan', 'is_active', 'created_at', 'updated_at'],
      paranoid: false,
    }),
    Employee.findAll({
      attributes: ['org_id'],
      where: {
        role: {
          [Op.ne]: 'superadmin',
        },
        is_active: true,
      },
      paranoid: false,
    }),
    PaymentRecord.findAll({
      attributes: ['id', 'org_id', 'invoice_id', 'amount_paise', 'currency', 'status', 'created_at'],
      order: [['created_at', 'DESC']],
    }),
  ]);

  const employeeCountByOrg = employeeCounts.reduce((acc, employee) => {
    const key = employee.org_id;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const orgBillingRows = orgs.map((org) => {
    const employeeCount = employeeCountByOrg[org.id] || 0;
    const mrr = getOrgMonthlyMrr(org, employeeCount);

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      isActive: Boolean(org.is_active),
      createdAt: org.created_at,
      updatedAt: org.updated_at,
      employeeCount,
      mrr,
    };
  });

  return {
    orgs: orgBillingRows,
    paymentRecords,
  };
}

async function getRevenueSummary() {
  const { orgs, paymentRecords } = await getBillingOverviewData();
  const now = new Date();
  const monthStart = startOfUtcMonth(now);
  const nextMonthStart = addUtcMonths(monthStart, 1);
  const previousMonthStart = addUtcMonths(monthStart, -1);

  const payingOrgs = orgs.filter((org) => org.isActive && org.plan !== 'trial').length;
  const mrr = orgs
    .filter((org) => org.isActive)
    .reduce((sum, org) => sum + org.mrr, 0);
  const arpu = payingOrgs > 0 ? Math.round(mrr / payingOrgs) : 0;

  const newRevMTD = orgs
    .filter((org) => org.isActive && org.plan !== 'trial' && new Date(org.createdAt) >= monthStart)
    .reduce((sum, org) => sum + org.mrr, 0);

  const churnedRevMTD = orgs
    .filter((org) => !org.isActive && new Date(org.updatedAt) >= monthStart)
    .reduce((sum, org) => sum + org.mrr, 0);

  return {
    mrr,
    payingOrgs,
    arpu,
    newRevMTD,
    churnedRevMTD,
    previousMonthRevenue: paymentRecords
      .filter((record) => {
        const createdAt = new Date(record.created_at);
        return createdAt >= previousMonthStart && createdAt < monthStart && record.status === 'verified';
      })
      .reduce((sum, record) => sum + Math.round(Number(record.amount_paise || 0) / 100), 0),
    currentMonthRevenue: paymentRecords
      .filter((record) => {
        const createdAt = new Date(record.created_at);
        return createdAt >= monthStart && createdAt < nextMonthStart && record.status === 'verified';
      })
      .reduce((sum, record) => sum + Math.round(Number(record.amount_paise || 0) / 100), 0),
  };
}

async function getBillingMrrHistory(query = {}) {
  const months = Math.max(1, Math.min(Number(query.months) || 12, 24));
  const { orgs } = await getBillingOverviewData();
  const currentMonth = startOfUtcMonth(new Date());
  const monthSeries = Array.from({ length: months }, (_, index) => addUtcMonths(currentMonth, -(months - 1 - index)));

  return monthSeries.map((monthStart) => ({
    month: formatMonthLabel(monthStart),
    mrr: orgs
      .filter((org) => {
        const createdAt = new Date(org.createdAt);
        const updatedAt = new Date(org.updatedAt);
        return createdAt < addUtcMonths(monthStart, 1) && (org.isActive || updatedAt >= monthStart);
      })
      .reduce((sum, org) => sum + org.mrr, 0),
  }));
}

async function getBillingPlanBreakdown() {
  const { orgs } = await getBillingOverviewData();
  const breakdown = new Map();

  orgs
    .filter((org) => org.isActive)
    .forEach((org) => {
      const current = breakdown.get(org.plan) || { plan: org.plan, count: 0, revenue: 0 };
      current.count += 1;
      current.revenue += org.mrr;
      breakdown.set(org.plan, current);
    });

  return Array.from(breakdown.values()).sort((a, b) => b.revenue - a.revenue);
}

async function getBillingChurnedOrgs(query = {}) {
  const limit = Math.max(1, Math.min(Number(query.limit) || 10, 50));
  const monthStart = startOfUtcMonth(new Date());
  const { orgs } = await getBillingOverviewData();

  const churned = orgs
    .filter((org) => !org.isActive && new Date(org.updatedAt) >= monthStart)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit)
    .map((org) => ({
      id: org.id,
      name: org.name,
      mrr: org.mrr,
      cancelledAt: org.updatedAt,
    }));

  return {
    orgs: churned,
    total: churned.length,
  };
}

async function getBillingInvoices(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.max(1, Math.min(Number(query.limit) || 20, 100));
  const offset = (page - 1) * limit;
  const { orgs, paymentRecords } = await getBillingOverviewData();
  const orgMap = Object.fromEntries(orgs.map((org) => [org.id, org]));

  const invoices = paymentRecords.map((record) => ({
    id: record.id,
    invoiceNo: record.invoice_id,
    orgName: orgMap[record.org_id]?.name || 'Unknown Org',
    amount: Math.round(Number(record.amount_paise || 0) / 100),
    currency: record.currency || 'INR',
    date: record.created_at,
    status: record.status === 'verified' ? 'paid' : record.status,
  }));

  return {
    invoices: invoices.slice(offset, offset + limit),
    total: invoices.length,
    page,
    limit,
  };
}

async function getBillingTopOrgs(query = {}) {
  const limit = Math.max(1, Math.min(Number(query.limit) || 10, 50));
  const { orgs } = await getBillingOverviewData();

  return {
    orgs: orgs
      .filter((org) => org.isActive)
      .sort((a, b) => b.mrr - a.mrr)
      .slice(0, limit)
      .map((org, index) => ({
        id: org.id,
        rank: index + 1,
        name: org.name,
        plan: org.plan,
        employeeCount: org.employeeCount,
        mrr: org.mrr,
      })),
  };
}

async function getQueueStatusByName(queueName) {
  const queue = queues[queueName];

  if (!queue || typeof queue.getJobCounts !== 'function') {
    throw createError('HTTP_404', 'Queue not found', 404);
  }

  const counts = await queue.getJobCounts();

  return {
    name: queueName,
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    completed: counts.completed || 0,
    failed: counts.failed || 0,
    delayed: counts.delayed || 0,
  };
}

async function getDatabaseHealthStatus() {
  const startedAt = Date.now();
  await sequelize.authenticate();
  const latency = Date.now() - startedAt;

  return {
    status: 'healthy',
    latency,
  };
}

async function retryQueueJob(queueName, jobId) {
  const queue = queues[queueName];

  if (!queue || typeof queue.getJob !== 'function') {
    throw createError('HTTP_404', 'Queue not found', 404);
  }

  const job = await queue.getJob(jobId);

  if (!job) {
    throw createError('HTTP_404', 'Job not found', 404);
  }

  await job.retry();

  return {
    queue: queueName,
    jobId: job.id,
    retried: true,
  };
}

async function retryAllFailedJobs(queueName) {
  const queue = queues[queueName];

  if (!queue || typeof queue.getFailed !== 'function') {
    throw createError('HTTP_404', 'Queue not found', 404);
  }

  const failedJobs = await queue.getFailed();
  let retriedCount = 0;

  for (const job of failedJobs) {
    await job.retry();
    retriedCount += 1;
  }

  return {
    queue: queueName,
    retriedCount,
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
  sendBillingAlert,
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
  getAllFeatureFlags,
  setFeatureFlagGlobal,
  setFeatureFlagOrgOverride,
  removeFeatureFlagOrgOverride,
  getFeatureFlagOrgs,
  getAnalyticsGrowth,
  getAnalyticsUsage,
  getAnalyticsRetention,
  getRevenueSummary,
  getBillingMrrHistory,
  getBillingPlanBreakdown,
  getBillingChurnedOrgs,
  getBillingInvoices,
  getBillingTopOrgs,
  getQueueStatusByName,
  getDatabaseHealthStatus,
  retryQueueJob,
  retryAllFailedJobs,
};
