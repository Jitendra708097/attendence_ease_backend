const { Op } = require('sequelize');
const crypto = require('crypto');
const XLSX = require('xlsx');
const {  AuditLog, Attendance, AttendanceSession, Branch, Department, Employee, ImpersonationSession, Organisation, PaymentRecord, PlanChangeHistory, RefreshToken, Shift, sequelize } = require('../../models');
const { compareValue, hashValue, signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/auth');
const { getPagination } = require('../../utils/pagination');
const { redisClient } = require('../../config/redis');
const env = require('../../config/env');
const queues = require('../../queues');
const { queueWelcomeEmail, queueBillingAlertEmail } = require('../notification/notification.service');
const { getRequestMetricsSnapshot } = require('../../utils/requestMetrics');
const { getRekognitionHealth } = require('../face/face.cloudService');
const planService = require('../plan/plan.service');
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

const IMPERSONATION_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const IMPERSONATION_TOKEN_TTL_SECONDS = 30 * 60;
const IMPERSONATION_HANDOFF_TTL_SECONDS = 60;
const IMPERSONATION_HANDOFF_KEY_PREFIX = 'impersonation_handoff:';
const DASHBOARD_CACHE_TTL_SECONDS = 45;
let lastEventLoopLagMs = 0;

setInterval(() => {
  const startedAt = Date.now();
  setImmediate(() => {
    lastEventLoopLagMs = Math.max(0, Date.now() - startedAt);
  });
}, 5000).unref();



function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function escapeCsvValue(value) {
  if (value == null) {
    return '';
  }

  const stringValue = String(value);
  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function buildCsv(rows) {
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');
}

function getColumnWidth(value, options = {}) {
  if (value == null) {
    return options.minWidth || 10;
  }

  const stringValue = String(value);
  const longestLine = stringValue.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0);
  return Math.min(Math.max(longestLine + 2, options.minWidth || 10), options.maxWidth || 40);
}

function buildWorkbookBuffer(sheetName, rows, options = {}) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const columnWidths = options.columnWidths || [];

  worksheet['!cols'] = Array.from({ length: columnCount }, (_, columnIndex) => ({
    wch: columnWidths[columnIndex] || Math.max(...rows.map((row) => getColumnWidth(row[columnIndex], options))),
  }));

  if (rows.length > 0 && columnCount > 0) {
    worksheet['!autofilter'] = {
      ref: `A1:${XLSX.utils.encode_cell({ r: 0, c: columnCount - 1 })}`,
    };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  }

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function getFeatureFlagRedisKey(flagKey) {
  return `feature_flag:${flagKey}:global`;
}

function getDashboardCacheKey({ months = 6, recentSignupsLimit = 5 } = {}) {
  return `superadmin_dashboard:v2:${months}:${recentSignupsLimit}`;
}

function getDashboardScopedCacheKey({ months = 6, recentSignupsLimit = 5, plan = '', status = '', orgId = '' } = {}) {
  return `superadmin_dashboard:v3:${months}:${recentSignupsLimit}:${plan || 'all'}:${status || 'all'}:${orgId || 'all'}`;
}

function buildDashboardOrgWhere(options = {}) {
  const where = {};

  if (options.plan) {
    where.plan = options.plan;
  }

  if (options.orgId) {
    where.id = options.orgId;
  }

  if (options.status === 'active') {
    where.is_active = true;
    where.cancelled_at = null;
    if (!options.plan) {
      where.plan = { [Op.ne]: 'trial' };
    }
  }

  if (options.status === 'trial') {
    where.is_active = true;
    where.plan = 'trial';
    where.cancelled_at = null;
  }

  if (options.status === 'suspended') {
    where.is_active = false;
    where.cancelled_at = null;
  }

  if (options.status === 'cancelled') {
    where.cancelled_at = { [Op.ne]: null };
  }

  return where;
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
  const fallback = planService.DEFAULT_PLAN_DEFINITIONS.find((plan) => plan.code === org.plan) || {};
  const snapshot = org.settings?.planSnapshot || {};
  const billingType = org.planBillingType || snapshot.billingType || fallback.billing_type;
  const monthlyPrice = org.planMonthlyPrice ?? snapshot.monthlyPrice ?? fallback.monthly_price;
  const pricePerEmployee = org.planPricePerEmployee ?? snapshot.pricePerEmployee ?? fallback.price_per_employee;

  if (billingType === 'flat') {
    return Number(monthlyPrice || 0);
  }
  if (billingType === 'per_employee') {
    return Number(employeeCount || 0) * Number(pricePerEmployee || 0);
  }
  return 0;
}

function formatAuditLogRecord(row, orgMap = {}, actorMap = {}) {
  return {
    id: row.id,
    action: row.action,
    createdAt: row.created_at,
    orgId: row.org_id,
    orgName: row.org_id && orgMap[row.org_id] ? orgMap[row.org_id].name : null,
    orgSlug: row.org_id && orgMap[row.org_id] ? orgMap[row.org_id].slug : null,
    performedByName: row.actor_id && actorMap[row.actor_id] ? actorMap[row.actor_id].name : null,
    performedByEmail: row.actor_id && actorMap[row.actor_id] ? actorMap[row.actor_id].email : null,
    ipAddress: row.ip_address,
    impersonatedBy: row.impersonated_by,
    impersonationSessionId: row.impersonation_session_id,
    metadata: {
      entityType: row.entity_type,
      entityId: row.entity_id,
      oldValue: row.old_value,
      newValue: row.new_value,
      actorRole: row.actor_role,
      userAgent: row.user_agent,
    },
  };
}

async function getEmployeeCountsByOrg(orgIds = []) {
  if (!orgIds.length) {
    return {};
  }

  const rows = await Employee.findAll({
    attributes: [
      'org_id',
      [sequelize.fn('COUNT', sequelize.col('id')), 'employeeCount'],
    ],
    where: {
      org_id: {
        [Op.in]: orgIds,
      },
      role: {
        [Op.ne]: 'superadmin',
      },
    },
    group: ['org_id'],
    raw: true,
  });

  return rows.reduce((acc, row) => {
    acc[row.org_id] = Number(row.employeeCount || 0);
    return acc;
  }, {});
}

async function getAuditLookupMaps(rows = []) {
  const orgIds = [...new Set(rows.map((row) => row.org_id).filter(Boolean))];
  const actorIds = [...new Set(rows.map((row) => row.actor_id).filter(Boolean))];

  const [orgs, actors] = await Promise.all([
    orgIds.length > 0
      ? Organisation.findAll({ where: { id: { [Op.in]: orgIds } }, attributes: ['id', 'name', 'slug'] })
      : [],
    actorIds.length > 0
      ? Employee.findAll({ where: { id: { [Op.in]: actorIds } }, attributes: ['id', 'name', 'email'] })
      : [],
  ]);

  return {
    orgMap: Object.fromEntries(orgs.map((org) => [org.id, org])),
    actorMap: Object.fromEntries(actors.map((actor) => [actor.id, actor])),
  };
}

function buildAuditLogWhere(query = {}) {
  const where = {};

  if (query.orgId) {
    where.org_id = query.orgId;
  }

  if (query.action) {
    where.action = String(query.action).includes('%')
      ? { [Op.iLike]: query.action }
      : query.action;
  }

  if (query.entityType) {
    where.entity_type = query.entityType;
  }

  if (query.entityId) {
    where.entity_id = query.entityId;
  }

  if (query.impersonationSessionId) {
    where.impersonation_session_id = query.impersonationSessionId;
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

  return where;
}

function buildImpersonationSessionWhere(superAdminId, query = {}) {
  const where = {
    super_admin_id: superAdminId,
  };

  if (query.orgId) {
    where.target_org_id = query.orgId;
  }

  if (query.adminId) {
    where.target_emp_id = query.adminId;
  }

  if (query.status === 'active') {
    where.ended_at = null;
  } else if (query.status === 'ended') {
    where.ended_at = { [Op.ne]: null };
  }

  if (query.reason) {
    where.reason = { [Op.iLike]: `%${String(query.reason).trim()}%` };
  }

  if (query.startDate || query.endDate) {
    where.started_at = {};

    if (query.startDate) {
      where.started_at[Op.gte] = new Date(query.startDate);
    }

    if (query.endDate) {
      where.started_at[Op.lte] = new Date(query.endDate);
    }
  }

  return where;
}

function buildAuditActionPatternWhere(patterns = []) {
  return {
    [Op.or]: patterns.map((pattern) => ({
      action: {
        [Op.iLike]: pattern,
      },
    })),
  };
}

function buildAuditLogSummaryWhere(baseWhere, extraWhere = {}) {
  return {
    ...baseWhere,
    ...extraWhere,
  };
}

function buildAnalyticsOrgWhere(query = {}) {
  const where = {};

  if (query.orgId) {
    where.id = query.orgId;
  }

  if (query.plan) {
    where.plan = query.plan;
  }

  if (query.status === 'cancelled') {
    where.cancelled_at = { [Op.ne]: null };
  } else if (query.status === 'suspended') {
    where.is_active = false;
    where.cancelled_at = null;
  } else if (query.status === 'trial') {
    where.is_active = true;
    where.cancelled_at = null;
    where.plan = 'trial';
  } else if (query.status === 'paid') {
    where.is_active = true;
    where.cancelled_at = null;
    where.plan = { [Op.ne]: 'trial' };
  } else if (query.status === 'active') {
    where.is_active = true;
    where.cancelled_at = null;
  }

  return where;
}

function getAnalyticsBucketKey(dateInput, groupBy = 'daily') {
  const date = new Date(dateInput);
  if (groupBy === 'monthly') {
    return date.toISOString().slice(0, 7);
  }
  if (groupBy === 'weekly') {
    return formatWeekLabel(startOfUtcWeek(date));
  }
  return date.toISOString().slice(0, 10);
}

async function getAnalyticsOrgIds(query = {}) {
  const where = buildAnalyticsOrgWhere(query);

  if (Object.keys(where).length === 0) {
    return null;
  }

  const orgs = await Organisation.findAll({
    where,
    attributes: ['id'],
    paranoid: false,
  });

  return orgs.map((org) => org.id);
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getQueueSnapshot({ includeFailedJobs = false, failedJobLimit = 25 } = {}) {
  const queueEntries = Object.entries(queues).filter(([, queue]) => (
    queue
    && typeof queue.getJobCounts === 'function'
  ));
  const queueHealth = await Promise.all(
    queueEntries.map(async ([name, queue]) => {
      try {
        const counts = await queue.getJobCounts();
        return {
          name,
          waiting: counts.waiting || 0,
          active: counts.active || 0,
          completed: counts.completed || 0,
          failed: counts.failed || 0,
          delayed: counts.delayed || 0,
          status: 'healthy',
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          name,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          status: 'degraded',
          error: error.message,
          checkedAt: new Date().toISOString(),
        };
      }
    })
  );

  if (!includeFailedJobs) {
    return {
      queues: queueHealth,
      failedJobs: [],
      failedJobCount: queueHealth.reduce((sum, queue) => sum + Number(queue.failed || 0), 0),
    };
  }

  const failedJobGroups = await Promise.all(
    queueEntries.map(async ([name, queue]) => {
      try {
        const jobs = await queue.getFailed(0, failedJobLimit - 1);
        return jobs.map((job) => ({
          id: job.id,
          queue: name,
          error: job.failedReason || job.stacktrace?.[0] || 'Unknown queue failure',
          failedAt: job.finishedOn ? new Date(job.finishedOn) : (job.processedOn ? new Date(job.processedOn) : null),
        }));
      } catch (error) {
        return [{
          id: `${name}:unavailable`,
          queue: name,
          error: error.message,
          failedAt: new Date(),
        }];
      }
    })
  );

  return {
    queues: queueHealth,
    failedJobs: failedJobGroups.flat().sort((a, b) => new Date(b.failedAt || 0) - new Date(a.failedAt || 0)).slice(0, failedJobLimit),
    failedJobCount: queueHealth.reduce((sum, queue) => sum + Number(queue.failed || 0), 0),
  };
}

async function getRedisHealthStatus() {
  if (!redisClient || typeof redisClient.ping !== 'function') {
    return {
      status: 'degraded',
      latency: null,
    };
  }

  const startedAt = Date.now();

  try {
    await redisClient.ping();
    return {
      status: redisClient.status === 'ready' ? 'healthy' : 'degraded',
      latency: Date.now() - startedAt,
      detail: {
        status: redisClient.status,
        mode: redisClient.mode || 'standalone',
        commandQueueLength: redisClient.commandQueue?.length || 0,
        offlineQueueLength: redisClient.offlineQueue?.length || 0,
      },
    };
  } catch (error) {
    return {
      status: 'degraded',
      latency: null,
      error: error.message,
      detail: {
        status: redisClient.status || 'unknown',
        mode: redisClient.mode || 'standalone',
        commandQueueLength: redisClient.commandQueue?.length || 0,
        offlineQueueLength: redisClient.offlineQueue?.length || 0,
      },
    };
  }
}

async function buildHealthSnapshot({ requestSeries = [] } = {}) {
  const requestMetrics = getRequestMetricsSnapshot();
  const [databaseHealth, redisHealth, queueSnapshot, rekognitionHealth] = await Promise.all([
    getDatabaseHealthStatus(),
    getRedisHealthStatus(),
    getQueueSnapshot({ includeFailedJobs: true }),
    getRekognitionHealth(),
  ]);

  const currentTimeLabel = new Date().toISOString().slice(11, 16);
  const apiStatus = requestMetrics.errorRate >= 10 || requestMetrics.p95 >= 3000
    ? 'degraded'
    : 'healthy';
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const queueIssues = queueSnapshot.queues.filter((queue) => queue.status && queue.status !== 'healthy');
  const failedQueueCount = queueSnapshot.failedJobCount;
  const impactedFeatures = [
    redisHealth.status !== 'healthy' && 'Redis-backed OTPs, cooldowns, queues, cache, and handoff codes may be affected',
    queueIssues.length > 0 && 'Background jobs such as notifications, reports, billing emails, and attendance sync may be delayed',
    failedQueueCount > 0 && 'Some background jobs failed and may need retry or investigation',
    apiStatus !== 'healthy' && 'API users may experience slower responses or elevated errors',
    databaseHealth.status !== 'healthy' && 'Core application reads/writes may fail or become slow',
    rekognitionHealth.status !== 'healthy' && 'AWS Rekognition face search may be unavailable or degraded',
  ].filter(Boolean);

  return {
    database: databaseHealth.status,
    redis: redisHealth.status,
    rekognition: rekognitionHealth.status,
    api: apiStatus,
    availabilityPercent: 100,
    processUptimeSeconds: Math.floor(process.uptime()),
    uptime: 100,
    dbLatency: databaseHealth.latency,
    redisLatency: redisHealth.latency,
    checkedAt: new Date().toISOString(),
    services: {
      database: {
        name: 'PostgreSQL',
        status: databaseHealth.status,
        latency: databaseHealth.latency,
        checkedAt: new Date().toISOString(),
        reason: databaseHealth.status === 'healthy' ? null : 'Database health check failed or latency is unavailable',
      },
      redis: {
        name: 'Redis Cache',
        status: redisHealth.status,
        latency: redisHealth.latency,
        checkedAt: new Date().toISOString(),
        reason: redisHealth.status === 'healthy' ? null : (redisHealth.error || `Redis status is ${redisClient.status || 'unknown'}`),
        detail: redisHealth.detail,
      },
      api: {
        name: 'API Server',
        status: apiStatus,
        latency: requestMetrics.p95,
        checkedAt: new Date().toISOString(),
        reason: apiStatus === 'healthy' ? null : `API p95 ${requestMetrics.p95}ms, error rate ${requestMetrics.errorRate}%`,
      },
      rekognition: {
        name: 'AWS Rekognition',
        status: rekognitionHealth.status,
        latency: rekognitionHealth.latency,
        checkedAt: rekognitionHealth.checkedAt || new Date().toISOString(),
        reason: rekognitionHealth.status === 'healthy' ? null : rekognitionHealth.reason,
        detail: {
          configured: rekognitionHealth.configured,
          collectionId: rekognitionHealth.collectionId,
          faceCount: rekognitionHealth.faceCount,
          faceModelVersion: rekognitionHealth.faceModelVersion,
        },
      },
    },
    reasons: {
      database: databaseHealth.status === 'healthy' ? null : 'Database health check failed or latency is unavailable',
      redis: redisHealth.status === 'healthy' ? null : (redisHealth.error || `Redis status is ${redisClient.status || 'unknown'}`),
      api: apiStatus === 'healthy' ? null : `API p95 ${requestMetrics.p95}ms, error rate ${requestMetrics.errorRate}%`,
      rekognition: rekognitionHealth.status === 'healthy' ? null : rekognitionHealth.reason,
    },
    apiMetrics: {
      p50: requestMetrics.p50,
      p95: requestMetrics.p95,
      p99: requestMetrics.p99,
      errorRate: requestMetrics.errorRate,
      totalRequests: requestMetrics.totalRequests,
      errorCount: requestMetrics.errorCount,
      slowEndpoints: requestMetrics.slowEndpoints,
    },
    runtime: {
      memoryRssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      externalMb: Math.round(memory.external / 1024 / 1024),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      eventLoopLagMs: lastEventLoopLagMs,
    },
    impactedFeatures,
    queues: queueSnapshot.queues,
    failedJobs: queueSnapshot.failedJobCount,
    metrics: {
      responseTime: requestMetrics.responseTime.length > 0
        ? requestMetrics.responseTime
        : (databaseHealth.latency != null ? [{ time: currentTimeLabel, p95: databaseHealth.latency }] : []),
      errorRate: requestMetrics.errorRateSeries.length > 0
        ? requestMetrics.errorRateSeries
        : [{ time: currentTimeLabel, rate: 0 }],
      requests: requestMetrics.requestSeries.length > 0 ? requestMetrics.requestSeries : requestSeries,
    },
  };
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
    impersonationExpiresAt: session.expires_at,
  };
}

function getImpersonationHandoffKey(code) {
  return `${IMPERSONATION_HANDOFF_KEY_PREFIX}${code}`;
}

async function createImpersonationHandoff(payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handoffCode = crypto.randomBytes(32).toString('base64url');
    const result = await redisClient.set(
      getImpersonationHandoffKey(handoffCode),
      JSON.stringify(payload),
      'EX',
      IMPERSONATION_HANDOFF_TTL_SECONDS,
      'NX'
    );

    if (result === 'OK') {
      return handoffCode;
    }
  }

  throw createError('SA_018_HANDOFF', 'Unable to create impersonation handoff', 500);
}

function deriveOrgStatus(org) {
  if (org.cancelled_at) {
    return 'cancelled';
  }

  if (!org.is_active) {
    return 'suspended';
  }

  if (org.plan === 'trial') {
    return 'trial';
  }

  return 'active';
}

function getOrgHealth(status, employeeCount, branchCount, org) {
  if (status === 'cancelled') {
    return {
      score: 0,
      label: 'Cancelled',
      reasons: ['Organisation has been cancelled'],
    };
  }

  let score = 100;
  const reasons = [];
  const settings = org.settings || {};

  if (status === 'suspended') {
    score -= 40;
    reasons.push('Suspended');
  }

  if (settings.invite?.error) {
    score -= 15;
    reasons.push('Admin invite failed');
  }

  if (employeeCount === 0) {
    score -= 20;
    reasons.push('No employees');
  }

  if (branchCount === 0) {
    score -= 10;
    reasons.push('No branches');
  }

  if (org.plan === 'trial' && org.trial_ends_at) {
    const daysLeft = Math.ceil((new Date(org.trial_ends_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysLeft <= 3) {
      score -= 10;
      reasons.push(daysLeft < 0 ? 'Trial expired' : 'Trial ending soon');
    }
  }

  const normalizedScore = Math.max(0, Math.min(100, score));

  return {
    score: normalizedScore,
    label: normalizedScore >= 80 ? 'Healthy' : normalizedScore >= 50 ? 'Watch' : 'At risk',
    reasons: reasons.length ? reasons : ['No critical issues'],
  };
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

async function getOrgSlugPreview(name) {
  const baseSlug = normalizeSlug(name) || 'organisation';
  let slug = baseSlug;
  let suffix = 1;

  while (await Organisation.findOne({ where: { slug } })) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  return {
    baseSlug,
    slug,
    adjusted: slug !== baseSlug,
  };
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

  const status = deriveOrgStatus(org);
  const health = getOrgHealth(status, employeeCount, branchCount, org);
  const billing = await planService.getBillingForOrganisation(org, employeeCount);

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    status,
    healthScore: health.score,
    healthLabel: health.label,
    healthReasons: health.reasons,
    isActive: Boolean(org.is_active),
    employeeCount,
    branchCount,
    trialEndsAt: org.trial_ends_at,
    createdAt: org.created_at,
    updatedAt: org.updated_at,
    timezone: org.timezone,
    settings: org.settings || {},
    suspendedAt: org.suspended_at,
    suspendedBy: org.suspended_by,
    suspensionReason: org.suspension_reason,
    cancelledAt: org.cancelled_at,
    cancellationReason: org.cancellation_reason,
    planDefinition: billing.mapped,
    mrr: billing.monthlyAmount,
  };
}

async function listOrgs(query = {}) {
  const { page, limit, offset } = getPagination(query);
  const search = String(query.search || query.q || '').trim();
  const where = {};
  let searchOrgIds = null;

  if (query.plan) {
    where.plan = query.plan;
  }

  if (query.status === 'cancelled') {
    where.cancelled_at = { [Op.ne]: null };
  } else if (query.status === 'suspended') {
    where.is_active = false;
    where.cancelled_at = null;
  } else if (query.status === 'active' || query.status === 'trial') {
    where.is_active = true;
    where.cancelled_at = null;
  }

  if (search) {
    const matchingAdmins = await Employee.findAll({
      where: {
        role: 'admin',
        email: { [Op.iLike]: `%${search}%` },
      },
      attributes: ['org_id'],
      raw: true,
    });
    searchOrgIds = [...new Set(matchingAdmins.map((admin) => admin.org_id).filter(Boolean))];

    where[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { slug: { [Op.iLike]: `%${search}%` } },
      ...(searchOrgIds.length > 0 ? [{ id: { [Op.in]: searchOrgIds } }] : []),
    ];
  }

  const orderFieldMap = {
    createdAt: 'created_at',
    name: 'name',
    plan: 'plan',
  };

  const needsComputedSort = ['employees', 'mrr'].includes(query.sortBy);
  const orderField = orderFieldMap[query.sortBy] || 'created_at';
  const orderDirection = String(query.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const result = await Organisation.findAndCountAll({
    where,
    limit: needsComputedSort ? undefined : limit,
    offset: needsComputedSort ? undefined : offset,
    order: needsComputedSort ? [['created_at', 'DESC']] : [[orderField, orderDirection]],
  });

  let orgs = await Promise.all(result.rows.map(buildOrgSummary));
  if (needsComputedSort) {
    const sortKey = query.sortBy === 'mrr' ? 'mrr' : 'employeeCount';
    orgs = orgs.sort((a, b) => {
      const diff = Number(a[sortKey] || 0) - Number(b[sortKey] || 0);
      return orderDirection === 'ASC' ? diff : -diff;
    });
  }
  const filtered = query.status === 'trial'
    ? orgs.filter((org) => org.status === 'trial')
    : query.status === 'active'
      ? orgs.filter((org) => org.status === 'active')
      : orgs;
  const paged = needsComputedSort ? filtered.slice(offset, offset + limit) : filtered;

  return {
    orgs: paged,
    total: query.status === 'trial' || query.status === 'active' ? filtered.length : result.count,
    page,
    limit,
  };
}

async function exportOrganisations(query = {}) {
  const data = await listOrgs({
    ...query,
    page: 1,
    limit: 10000,
  });

  const orgIds = data.orgs.map((org) => org.id);
  const owners = orgIds.length > 0
    ? await Employee.findAll({
        where: {
          org_id: { [Op.in]: orgIds },
          role: 'admin',
        },
        attributes: ['org_id', 'name', 'email'],
        order: [['created_at', 'ASC']],
      })
    : [];

  const ownerByOrgId = owners.reduce((accumulator, owner) => {
    if (!accumulator[owner.org_id]) {
      accumulator[owner.org_id] = owner;
    }
    return accumulator;
  }, {});

  const rows = [
    [
      'Organisation Name',
      'Slug',
      'Status',
      'Plan',
      'Timezone',
      'Employees',
      'Branches',
      'MRR',
      'Owner Name',
      'Owner Email',
      'Trial Ends At',
      'Created At',
      'Updated At',
    ],
    ...data.orgs.map((org) => [
      org.name,
      org.slug,
      org.status,
      org.plan,
      org.timezone || '',
      org.employeeCount || 0,
      org.branchCount || 0,
      org.mrr || 0,
      ownerByOrgId[org.id]?.name || '',
      ownerByOrgId[org.id]?.email || '',
      org.trialEndsAt ? new Date(org.trialEndsAt).toISOString() : '',
      org.createdAt ? new Date(org.createdAt).toISOString() : '',
      org.updatedAt ? new Date(org.updatedAt).toISOString() : '',
    ]),
  ];

  const filenameDate = new Date().toISOString().slice(0, 10);
  const format = String(query.format || 'csv').toLowerCase();

  if (format === 'xlsx') {
    return {
      filename: `organisations-export-${filenameDate}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: buildWorkbookBuffer('Organisations', rows),
    };
  }

  return {
    filename: `organisations-export-${filenameDate}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: `${buildCsv(rows)}\r\n`,
  };
}

async function createOrg(payload) {
  const orgName = String(payload.orgName || '').trim();
  const adminFirstName = String(payload.adminFirstName || '').trim();
  const adminLastName = String(payload.adminLastName || '').trim();
  const adminEmail = String(payload.adminEmail || '').trim().toLowerCase();
  const adminPhone = String(payload.adminPhone || '').trim();
  const plan = String(payload.plan || 'trial').trim().toLowerCase();
  const timezone = payload.timezone || 'Asia/Kolkata';
  const planDefinition = await planService.getPlanByCode(plan);

  if (!planDefinition) {
    throw createError('SA_025', 'Invalid organisation plan', 422, [
      { field: 'plan', message: 'Plan must be trial, standard, or enterprise' },
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

  const { slug } = await getOrgSlugPreview(orgName);

  const adminName = [adminFirstName, adminLastName].filter(Boolean).join(' ');
  const tempPassword = buildTempPassword();
  const passwordHash = await hashValue(tempPassword);

  const createdOrg = await sequelize.transaction(async (transaction) => {
    const organisation = await Organisation.create(
      {
        name: orgName,
        slug,
        plan,
        plan_definition_id: planDefinition.id,
        timezone,
        trial_ends_at: planDefinition.trial_days
          ? new Date(Date.now() + Number(planDefinition.trial_days) * 24 * 60 * 60 * 1000)
          : null,
        is_active: true,
        settings: {
          timezone,
          planSnapshot: planService.planSnapshot(planDefinition),
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

  await createdOrg.update({
    settings: {
      ...(createdOrg.settings || {}),
      invite: {
        email: adminEmail,
        queued: welcomeEmailQueued,
        error: welcomeEmailError,
        lastAttemptAt: new Date().toISOString(),
      },
    },
  });

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

  const summary = await buildOrgSummary(org);
  let owner = null;
  const configuredOwnerId = org.settings?.ownerEmployeeId;

  if (configuredOwnerId) {
    owner = await Employee.findOne({
      where: {
        id: configuredOwnerId,
        org_id: orgId,
      },
    });
  }

  if (!owner) {
    owner = await Employee.findOne({
      where: {
        org_id: orgId,
        role: 'admin',
      },
      order: [['created_at', 'ASC']],
    });
  }

  return {
    ...summary,
    ownerName: owner ? owner.name : null,
    ownerEmail: owner ? owner.email : null,
    ownerId: owner ? owner.id : null,
  };
}

async function resendOrgAdminInvite({ orgId }) {
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
    throw createError('SA_042', 'No active organisation admin found for invite resend', 422);
  }

  if (!admin.temp_password || admin.password_changed) {
    throw createError('SA_043', 'Admin has already completed first login. Use password reset instead.', 409);
  }

  let queued = false;
  let errorMessage = null;

  try {
    const welcomeEmail = await queueWelcomeEmail({
      email: admin.email,
      organisationName: org.name,
      employeeName: admin.name,
      tempPassword: admin.temp_password,
    });
    queued = Boolean(welcomeEmail && welcomeEmail.queued);
  } catch (error) {
    errorMessage = error.message;
  }

  await org.update({
    settings: {
      ...(org.settings || {}),
      invite: {
        email: admin.email,
        queued,
        error: errorMessage,
        lastAttemptAt: new Date().toISOString(),
      },
    },
  });

  return {
    queued,
    error: errorMessage,
    adminEmail: admin.email,
    orgId: org.id,
    orgName: org.name,
    deliveryNote: queued
      ? 'Invite email has been queued. Ask the admin to check Inbox, Spam, and Promotions.'
      : `Invite email was not queued${errorMessage ? `: ${errorMessage}` : '.'}`,
  };
}

async function updateOrgProfile({ orgId, payload = {}, actorId }) {
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const name = String(payload.name || '').trim();
  const timezone = String(payload.timezone || '').trim();
  const country = Object.prototype.hasOwnProperty.call(payload, 'country')
    ? String(payload.country || '').trim()
    : undefined;

  if (name.length < 3 || name.length > 100) {
    throw createError('SA_044', 'Organisation name must be 3-100 characters', 422, [
      { field: 'name', message: 'Organisation name must be 3-100 characters' },
    ]);
  }

  if (timezone.length < 2 || timezone.length > 100) {
    throw createError('SA_045', 'Timezone is required', 422, [
      { field: 'timezone', message: 'Timezone is required' },
    ]);
  }

  if (country !== undefined && country.length > 80) {
    throw createError('SA_046', 'Country is too long', 422, [
      { field: 'country', message: 'Country must be 80 characters or fewer' },
    ]);
  }

  const oldValue = org.toJSON();
  const nextSettings = {
    ...(org.settings || {}),
    timezone,
    lastProfileUpdate: {
      updatedBy: actorId || null,
      updatedAt: new Date().toISOString(),
      previousName: org.name,
      previousTimezone: org.timezone,
      previousCountry: org.settings?.country || null,
    },
  };

  if (country !== undefined) {
    nextSettings.country = country || null;
  }

  await org.update({
    name,
    timezone,
    settings: nextSettings,
  });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function getOrgEmployees(orgId, query = {}) {
  const { page, limit, offset } = getPagination(query);
  const search = String(query.search || query.q || '').trim();
  const where = {
    org_id: orgId,
    role: {
      [Op.ne]: 'superadmin',
    },
  };

  if (query.role) {
    where.role = query.role;
  }

  if (query.status === 'active') {
    where.is_active = true;
  }

  if (query.status === 'suspended') {
    where.is_active = false;
  }

  if (search) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { email: { [Op.iLike]: `%${search}%` } },
      { emp_code: { [Op.iLike]: `%${search}%` } },
    ];
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
    limit,
    offset,
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
    page,
    limit,
    totalPages: Math.ceil(result.count / limit) || 1,
  };
}

async function getOrgAttendanceToday(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, checkedIn] = await Promise.all([
    Attendance.findAll({
      where: {
        org_id: orgId,
        date: today,
      },
      attributes: ['status', 'is_late'],
    }),
    AttendanceSession.count({
      where: {
        org_id: orgId,
        status: 'open',
      },
    }),
  ]);

  const summary = {
    present: 0,
    absent: 0,
    late: 0,
    checkedIn,
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
  });

  return summary;
}

async function getOrgBilling(orgId) {
  const org = await getOrgDetail(orgId);
  const paymentRecords = await PaymentRecord.findAll({
    where: { org_id: orgId },
    order: [['created_at', 'DESC']],
    limit: 24,
  });

  return {
    invoices: paymentRecords.map((record) => ({
      id: record.invoice_id,
      date: record.created_at,
      amount: Math.round(Number(record.amount_paise || 0) / 100),
      status: record.status === 'verified' ? 'paid' : record.status,
      razorpayOrderId: record.razorpay_order_id,
      razorpayPaymentId: record.razorpay_payment_id,
      currency: record.currency || 'INR',
    })),
    currentEstimate: {
      id: `estimate-${org.id}`,
      date: org.updatedAt || org.createdAt,
      amount: org.mrr,
      status: org.status === 'suspended' ? 'overdue' : 'estimated',
      source: 'plan_employee_estimate',
    },
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

async function suspendOrg({ orgId, reason, actorId }) {
  const suspensionReason = normalizeRequiredReason(reason, 'reason');
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  await org.update({
    is_active: false,
    suspended_at: new Date(),
    suspended_by: actorId || null,
    suspension_reason: suspensionReason,
  });
  await revokeOrgAccess(orgId, { reason: 'organisation_suspended', endedBy: actorId || null });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function activateOrg({ orgId, reason, actorId }) {
  const activationReason = normalizeRequiredReason(reason, 'reason');
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  await org.update({
    is_active: true,
    suspended_at: null,
    suspended_by: null,
    suspension_reason: null,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    settings: {
      ...(org.settings || {}),
      lastActivation: {
        reason: activationReason,
        activatedBy: actorId || null,
        activatedAt: new Date().toISOString(),
        previousSuspensionReason: org.suspension_reason || null,
        previousCancellationReason: org.cancellation_reason || null,
      },
    },
  });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function cancelOrg({ orgId, reason, actorId }) {
  const cancellationReason = normalizeRequiredReason(reason, 'reason');
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  await org.update({
    is_active: false,
    cancelled_at: new Date(),
    cancelled_by: actorId || null,
    cancellation_reason: cancellationReason,
    settings: {
      ...(org.settings || {}),
      lastCancellation: {
        reason: cancellationReason,
        cancelledBy: actorId || null,
        cancelledAt: new Date().toISOString(),
        previousStatus: deriveOrgStatus(org),
      },
    },
  });
  await revokeOrgAccess(orgId, { reason: 'organisation_cancelled', endedBy: actorId || null });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function addOrgNote({ orgId, note, actorId, actorName }) {
  const cleanNote = String(note || '').trim();

  if (cleanNote.length < 2 || cleanNote.length > 1000) {
    throw createError('SA_047', 'Note must be 2-1000 characters', 422, [
      { field: 'note', message: 'Note must be 2-1000 characters' },
    ]);
  }

  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  const entry = {
    id: crypto.randomUUID(),
    note: cleanNote,
    createdAt: new Date().toISOString(),
    createdBy: actorId || null,
    createdByName: actorName || null,
  };

  await org.update({
    settings: {
      ...(org.settings || {}),
      supportNotes: [entry, ...((org.settings || {}).supportNotes || [])].slice(0, 50),
    },
  });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
    note: entry,
  };
}

async function transferOrgOwner({ orgId, employeeId, reason, actorId }) {
  const transferReason = normalizeRequiredReason(reason, 'reason');
  const [org, employee] = await Promise.all([
    Organisation.findOne({ where: { id: orgId } }),
    Employee.findOne({
      where: {
        id: employeeId,
        org_id: orgId,
        role: {
          [Op.ne]: 'superadmin',
        },
      },
    }),
  ]);

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  if (!employee || !employee.is_active) {
    throw createError('SA_048', 'Active organisation employee is required for owner transfer', 422, [
      { field: 'employeeId', message: 'Select an active employee from this organisation' },
    ]);
  }

  const oldValue = org.toJSON();
  const previousOwnerId = org.settings?.ownerEmployeeId || null;

  if (employee.role !== 'admin') {
    await employee.update({ role: 'admin' });
  }

  await org.update({
    settings: {
      ...(org.settings || {}),
      ownerEmployeeId: employee.id,
      lastOwnerTransfer: {
        fromEmployeeId: previousOwnerId,
        toEmployeeId: employee.id,
        toEmployeeEmail: employee.email,
        reason: transferReason,
        changedBy: actorId || null,
        changedAt: new Date().toISOString(),
      },
    },
  });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function changePlan({ orgId, plan, reason, actorId, effectiveDate }) {
  const planChangeReason = normalizeRequiredReason(reason, 'reason');
  const nextPlanCode = String(plan || '').trim().toLowerCase();
  const planDefinition = await planService.getPlanByCode(nextPlanCode);

  if (!planDefinition) {
    throw createError('SA_025', 'Invalid organisation plan', 422, [
      { field: 'plan', message: 'Plan must be trial, standard, or enterprise' },
    ]);
  }

  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const oldValue = org.toJSON();
  const effectiveAt = effectiveDate ? new Date(effectiveDate) : new Date();
  if (Number.isNaN(effectiveAt.getTime())) {
    throw createError('SA_049', 'Invalid effective date', 422, [
      { field: 'effectiveDate', message: 'Effective date must be a valid date' },
    ]);
  }

  await sequelize.transaction(async (transaction) => {
    await org.update({
      plan: nextPlanCode,
      plan_definition_id: planDefinition.id,
      trial_ends_at: planDefinition.trial_days
        ? new Date(Date.now() + Number(planDefinition.trial_days) * 24 * 60 * 60 * 1000)
        : null,
      settings: {
        ...(org.settings || {}),
        planSnapshot: planService.planSnapshot(planDefinition),
        lastPlanChange: {
          from: org.plan,
          to: nextPlanCode,
          reason: planChangeReason,
          changedBy: actorId || null,
          changedAt: new Date().toISOString(),
          effectiveAt: effectiveAt.toISOString(),
        },
      },
    }, { transaction });

    await PlanChangeHistory.create({
      org_id: org.id,
      old_plan: oldValue.plan,
      new_plan: nextPlanCode,
      old_plan_definition_id: oldValue.plan_definition_id || null,
      new_plan_definition_id: planDefinition.id,
      actor_id: actorId || null,
      reason: planChangeReason,
      effective_at: effectiveAt,
      metadata: {
        oldSettings: oldValue.settings || {},
        newSnapshot: planService.planSnapshot(planDefinition),
      },
    }, { transaction });
  });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function getOrgPlanHistory(orgId, query = {}) {
  const limit = Math.max(1, Math.min(Number(query.limit) || 25, 100));
  const page = Math.max(1, Number(query.page) || 1);
  const offset = (page - 1) * limit;

  const org = await Organisation.findOne({ where: { id: orgId }, attributes: ['id'] });
  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const result = await PlanChangeHistory.findAndCountAll({
    where: { org_id: orgId },
    include: [
      { model: Employee, as: 'actor', attributes: ['id', 'name', 'email'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    history: result.rows.map((row) => ({
      id: row.id,
      oldPlan: row.old_plan,
      newPlan: row.new_plan,
      oldPlanDefinitionId: row.old_plan_definition_id,
      newPlanDefinitionId: row.new_plan_definition_id,
      actorId: row.actor_id,
      actorName: row.actor?.name || null,
      actorEmail: row.actor?.email || null,
      reason: row.reason,
      effectiveAt: row.effective_at,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    })),
    total: result.count,
    page,
    limit,
  };
}

async function extendTrial({ orgId, extendByDays, reason, actorId }) {
  const trialExtensionReason = normalizeRequiredReason(reason, 'reason');
  const org = await Organisation.findOne({ where: { id: orgId } });

  if (!org) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  const current = org.trial_ends_at ? new Date(org.trial_ends_at) : new Date();
  const next = new Date(current.getTime() + Number(extendByDays || 0) * 24 * 60 * 60 * 1000);
  const oldValue = org.toJSON();
  await org.update({
    trial_ends_at: next,
    settings: {
      ...(org.settings || {}),
      lastTrialExtension: {
        previousTrialEndsAt: current.toISOString(),
        newTrialEndsAt: next.toISOString(),
        extendByDays: Number(extendByDays || 0),
        reason: trialExtensionReason,
        changedBy: actorId || null,
        changedAt: new Date().toISOString(),
      },
    },
  });

  return {
    oldValue,
    newValue: await getOrgDetail(orgId),
  };
}

async function getStats(options = {}) {
  const monthsCount = Math.min(Math.max(Number(options.months || 6), 1), 24);
  const recentSignupsLimit = Math.min(Math.max(Number(options.recentSignupsLimit || options.limit || 5), 1), 25);
  const orgWhere = buildDashboardOrgWhere(options);
  const hasOrgScope = Boolean(options.plan || options.status || options.orgId);
  const cacheKey = hasOrgScope
    ? getDashboardScopedCacheKey({
      months: monthsCount,
      recentSignupsLimit,
      plan: options.plan,
      status: options.status,
      orgId: options.orgId,
    })
    : getDashboardCacheKey({ months: monthsCount, recentSignupsLimit });

  if (redisClient.status === 'ready') {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (_) {
      // Dashboard caching is opportunistic; fresh data is safer than failing the page.
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const previousMonth = new Date(startOfMonth);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);

  const [orgs, newOrgsMTD, newOrgsPrev] = await Promise.all([
    Organisation.findAll({ where: orgWhere }),
    Organisation.count({
      where: {
        ...orgWhere,
        created_at: {
          [Op.gte]: startOfMonth,
        },
      },
    }),
    Organisation.count({
      where: {
        ...orgWhere,
        created_at: {
          [Op.gte]: previousMonth,
          [Op.lt]: startOfMonth,
        },
      },
    }),
  ]);

  const orgIds = orgs.map((org) => org.id);
  const scopedOrgWhere = orgIds.length > 0 ? { org_id: { [Op.in]: orgIds } } : { org_id: null };
  const [totalEmployees, checkedInNow] = await Promise.all([
    Employee.count({
      where: {
        ...scopedOrgWhere,
        role: {
          [Op.ne]: 'superadmin',
        },
      },
    }),
    AttendanceSession.count({
      where: {
        ...scopedOrgWhere,
        status: 'open',
      },
    }),
  ]);

  const platformOrgCount = hasOrgScope ? await Organisation.count() : orgs.length;
  const orgScope = {
    filtered: hasOrgScope,
    plan: options.plan || null,
    status: options.status || null,
    orgId: options.orgId || null,
    matchingOrgs: orgs.length,
    platformOrgs: platformOrgCount,
  };

  /*
  const [orgs, totalEmployees, checkedInNow, newOrgsMTD, newOrgsPrev] = await Promise.all([
    Organisation.findAll(),
    Employee.count({
      where: {
        role: {
          [Op.ne]: 'superadmin',
        },
      },
    }),
    AttendanceSession.count({
      where: {
        status: 'open',
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
  ]);
  */

  const employeeCountsByOrg = await getEmployeeCountsByOrg(orgIds);
  const activeOrgs = orgs.filter((org) => org.is_active && org.plan !== 'trial').length;
  const trialOrgs = orgs.filter((org) => org.is_active && org.plan === 'trial').length;
  const totalOrgs = orgs.length;
  const mrr = orgs.reduce((sum, org) => sum + getOrgMonthlyMrr(org, employeeCountsByOrg[org.id]), 0);

  const recentSignups = await Promise.all(
    orgs
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, recentSignupsLimit)
      .map(async (org) => ({
        id: org.id,
        name: org.name,
        plan: org.plan,
        employeeCount: employeeCountsByOrg[org.id] || 0,
        createdAt: org.created_at,
      }))
  );

  const trialAlerts = orgs
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

  const inviteAlerts = orgs
    .filter((org) => org.settings?.invite?.error)
    .slice(0, 5)
    .map((org) => ({
      type: 'invite_failed',
      orgId: org.id,
      orgName: org.name,
      detail: org.settings.invite.error,
      createdAt: org.settings.invite.lastAttemptAt || org.updated_at || org.created_at,
    }));

  const suspendedAlerts = orgs
    .filter((org) => !org.is_active && !org.cancelled_at)
    .slice(0, 5)
    .map((org) => ({
      type: 'org_suspended',
      orgId: org.id,
      orgName: org.name,
      detail: org.suspension_reason || 'Organisation is suspended',
      createdAt: org.suspended_at || org.updated_at || org.created_at,
    }));

  const paymentFailures = orgIds.length > 0
    ? await PaymentRecord.findAll({
      where: {
        org_id: { [Op.in]: orgIds },
        status: 'failed',
      },
      order: [['created_at', 'DESC']],
      limit: 5,
    })
    : [];
  const orgById = Object.fromEntries(orgs.map((org) => [org.id, org]));
  const paymentAlerts = paymentFailures.map((record) => ({
    type: 'payment_failed',
    orgId: record.org_id,
    orgName: orgById[record.org_id]?.name || 'Organisation',
    detail: record.error_message || record.error_code || `Payment ${record.status}`,
    createdAt: record.created_at,
  }));

  const queueSnapshot = await getQueueSnapshot({ includeFailedJobs: true, failedJobLimit: 5 });
  const queueAlerts = queueSnapshot.failedJobs.map((job) => ({
    type: 'queue_failed',
    detail: `${job.queue}: ${job.error}`,
    createdAt: job.failedAt || new Date(),
  }));

  const alerts = [...queueAlerts, ...paymentAlerts, ...inviteAlerts, ...suspendedAlerts, ...trialAlerts]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 15);

  const months = Array.from({ length: monthsCount }).map((_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - ((monthsCount - 1) - index));
    return date;
  });

  const monthRangeStart = months[0].toISOString().slice(0, 10);
  const monthRangeEnd = addUtcMonths(months[months.length - 1], 1).toISOString().slice(0, 10);
  const attendanceRows = await Attendance.findAll({
    attributes: ['date'],
    where: {
      date: {
        [Op.gte]: monthRangeStart,
        [Op.lt]: monthRangeEnd,
      },
    },
    paranoid: false,
  });
  const attendanceCountByMonth = attendanceRows.reduce((acc, row) => {
    const monthKey = String(row.date).slice(0, 7);
    acc[monthKey] = (acc[monthKey] || 0) + 1;
    return acc;
  }, {});

  const mrrTrend = months.map((date) => {
    const monthKey = date.toISOString().slice(0, 7);
    const monthEnd = addUtcMonths(date, 1);
    const value = orgs.reduce((sum, org) => {
      const createdAt = new Date(org.created_at);
      if (createdAt >= monthEnd) {
        return sum;
      }

      return sum + getOrgMonthlyMrr(org, employeeCountsByOrg[org.id]);
    }, 0);

    return {
      month: monthKey,
      mrr: value,
      value,
    };
  });

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
        newOrgs: count,
        value: count,
      };
    })
  );

  const requestSeries = months.map((date) => ({
    time: date.toISOString().slice(5, 7),
    count: attendanceCountByMonth[date.toISOString().slice(0, 7)] || 0,
  }));
  const health = await buildHealthSnapshot({ requestSeries });

  const dashboardSnapshot = {
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
      scope: orgScope,
    },
    mrrTrend,
    orgGrowth,
    alerts,
    recentSignups,
    health,
  };

  if (redisClient.status === 'ready') {
    try {
      await redisClient.set(cacheKey, JSON.stringify(dashboardSnapshot), 'EX', DASHBOARD_CACHE_TTL_SECONDS);
    } catch (_) {
      // Cache writes must not affect dashboard availability.
    }
  }

  return dashboardSnapshot;
}

async function getAuditLogs(query = {}) {
  const { page, limit, offset } = getPagination(query);
  const where = buildAuditLogWhere(query);

  const result = await AuditLog.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  const { orgMap, actorMap } = await getAuditLookupMaps(result.rows);

  return {
    logs: result.rows.map((row) => formatAuditLogRecord(row, orgMap, actorMap)),
    total: result.count,
    page,
    limit,
  };
}

async function getAuditLogSummary(query = {}) {
  const baseWhere = buildAuditLogWhere(query);
  const todayStart = startOfToday();

  const [
    totalActions,
    actionsToday,
    loginFailures,
    securityIncidents,
    billingManualOverrides,
    orgConfigChanges,
    impersonations,
  ] = await Promise.all([
    AuditLog.count({ where: baseWhere }),
    AuditLog.count({
      where: buildAuditLogSummaryWhere(baseWhere, {
        created_at: {
          [Op.gte]: todayStart,
        },
      }),
    }),
    AuditLog.count({
      where: buildAuditLogSummaryWhere(
        baseWhere,
        buildAuditActionPatternWhere(['%login_failed%', '%login.failure%', '%auth.failed%'])
      ),
    }),
    AuditLog.count({
      where: buildAuditLogSummaryWhere(
        baseWhere,
        buildAuditActionPatternWhere([
          '%login_failed%',
          '%device_exception%',
          '%face%',
          '%anomaly%',
          '%password%',
          '%impersonation%',
          '%security%',
        ])
      ),
    }),
    AuditLog.count({
      where: buildAuditLogSummaryWhere(
        baseWhere,
        buildAuditActionPatternWhere([
          '%manual_override%',
          '%billing.override%',
          '%billing.manual%',
          '%PLAN_CHANGED%',
          '%TRIAL_EXTENDED%',
          '%ORG_BILLING_ALERT_SENT%',
        ])
      ),
    }),
    AuditLog.count({
      where: buildAuditLogSummaryWhere(
        baseWhere,
        buildAuditActionPatternWhere([
          'ORG_%',
          'org.%',
          'branch.%',
          'department.%',
          'shift.%',
          '%FEATURE_FLAG_CHANGED%',
        ])
      ),
    }),
    AuditLog.count({
      where: buildAuditLogSummaryWhere(baseWhere, {
        [Op.or]: [
          {
            action: {
              [Op.iLike]: '%impersonation%',
            },
          },
          {
            impersonated_by: {
              [Op.ne]: null,
            },
          },
        ],
      }),
    }),
  ]);

  return {
    totalActions,
    actionsToday,
    loginFailures,
    securityIncidents,
    billingManualOverrides,
    orgConfigChanges,
    impersonations,
  };
}

async function getAuditLogById(id) {
  const row = await AuditLog.findOne({
    where: { id },
  });

  if (!row) {
    throw createError('HTTP_404', 'Audit log not found', 404);
  }

  const { orgMap, actorMap } = await getAuditLookupMaps([row]);
  return formatAuditLogRecord(row, orgMap, actorMap);
}

async function exportAuditLogs(query = {}) {
  const where = buildAuditLogWhere(query);
  const format = String(query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const result = await AuditLog.findAll({
    where,
    order: [['created_at', 'DESC']],
  });
  const { orgMap, actorMap } = await getAuditLookupMaps(result);
  const logs = result.map((row) => formatAuditLogRecord(row, orgMap, actorMap));
  const rows = [
    ['Timestamp', 'Action', 'Organisation', 'Org Slug', 'Performed By', 'Performer Email', 'Actor Role', 'Entity Type', 'Entity Id', 'IP Address', 'Impersonated By', 'User Agent'],
    ...logs.map((log) => [
      log.createdAt,
      log.action,
      log.orgName,
      log.orgSlug,
      log.performedByName,
      log.performedByEmail,
      log.metadata.actorRole,
      log.metadata.entityType,
      log.metadata.entityId,
      log.ipAddress,
      log.impersonatedBy,
      log.metadata.userAgent,
    ]),
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'xlsx') {
    return {
      filename: `audit-logs-${stamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: buildWorkbookBuffer('AuditLogs', rows, {
        maxWidth: 80,
        columnWidths: [24, 30, 34, 22, 26, 34, 18, 18, 38, 18, 26, 90],
      }),
    };
  }

  return {
    filename: `audit-logs-${stamp}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: buildCsv(rows),
  };
}

function normalizeImpersonationReason(reason) {
  return String(reason || '').trim().replace(/\s+/g, ' ');
}

function normalizeRequiredReason(reason, field = 'reason') {
  const normalizedReason = String(reason || '').trim().replace(/\s+/g, ' ');

  if (normalizedReason.length < 10) {
    throw createError('SA_REASON_REQUIRED', `${field} must be at least 10 characters`, 422, [
      { field, message: 'Provide a clear audit reason' },
    ]);
  }

  if (normalizedReason.length > 500) {
    throw createError('SA_REASON_TOO_LONG', `${field} cannot exceed 500 characters`, 422, [
      { field, message: 'Keep the reason under 500 characters' },
    ]);
  }

  return normalizedReason;
}

async function revokeOrgAccess(orgId, { reason = 'organisation_suspended', endedBy = null } = {}) {
  const employees = await Employee.findAll({
    where: { org_id: orgId },
    attributes: ['id'],
  });
  const employeeIds = employees.map((employee) => employee.id);

  if (employeeIds.length > 0) {
    await RefreshToken.update(
      { status: 'revoked' },
      {
        where: {
          emp_id: { [Op.in]: employeeIds },
          status: { [Op.in]: ['active', 'used'] },
        },
      }
    );
  }

  await ImpersonationSession.update(
    {
      ended_at: new Date(),
      ended_by: endedBy,
      end_reason: reason,
    },
    {
      where: {
        target_org_id: orgId,
        ended_at: null,
      },
    }
  );
}

async function expireStaleImpersonationSessions(superAdminId, now = new Date()) {
  const legacyCutoff = new Date(now.getTime() - IMPERSONATION_MAX_DURATION_MS);

  await ImpersonationSession.update(
    {
      ended_at: now,
      ended_by: superAdminId,
      end_reason: 'expired',
    },
    {
      where: {
        super_admin_id: superAdminId,
        ended_at: null,
        [Op.or]: [
          {
            expires_at: {
              [Op.ne]: null,
              [Op.lte]: now,
            },
          },
          {
            expires_at: null,
            started_at: {
              [Op.lte]: legacyCutoff,
            },
          },
        ],
      },
    }
  );
}

async function startImpersonation({ superAdminId, orgId, adminId, reason, forceEndExisting = false, ipAddress = null, userAgent = null }) {
  const normalizedReason = normalizeImpersonationReason(reason);

  if (normalizedReason.length < 10) {
    throw createError('SA_018', 'Reason must be at least 10 characters', 400);
  }

  if (normalizedReason.length > 500) {
    throw createError('SA_018', 'Reason cannot exceed 500 characters', 400);
  }

  await expireStaleImpersonationSessions(superAdminId);

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

  const activeSession = await ImpersonationSession.findOne({
    where: {
      super_admin_id: superAdminId,
      ended_at: null,
    },
    order: [['started_at', 'DESC']],
  });

  if (activeSession && !forceEndExisting) {
    throw createError('SA_018_ACTIVE_SESSION', 'An active impersonation session already exists', 409, [
      {
        sessionId: activeSession.id,
        startedAt: activeSession.started_at,
        expiresAt: activeSession.expires_at,
      },
    ]);
  }

  if (activeSession && forceEndExisting) {
    await activeSession.update({
      ended_at: new Date(),
      ended_by: superAdminId,
      end_reason: 'force_ended_before_new_session',
      ended_from_ip: ipAddress,
      ended_user_agent: userAgent,
    });
  }

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + IMPERSONATION_MAX_DURATION_MS);

  const session = await ImpersonationSession.create({
    super_admin_id: superAdminId,
    target_org_id: orgId,
    target_emp_id: targetAdmin.id,
    reason: normalizedReason,
    started_at: startedAt,
    last_seen_at: startedAt,
    expires_at: expiresAt,
  });

  const token = signAccessToken({
    id: targetAdmin.id,
    orgId,
    role: 'admin',
    isImpersonated: true,
    impersonatedBy: superAdminId,
    impersonationSessionId: session.id,
  }, { expiresIn: `${IMPERSONATION_TOKEN_TTL_SECONDS}s` });

  const employee = buildImpersonationEmployee(targetAdmin, targetOrg, session, superAdminId);
  const handoffCode = await createImpersonationHandoff({
    accessToken: token,
    refreshToken: null,
    user: employee,
    org: {
      id: orgId,
      name: targetOrg.name,
      slug: targetOrg.slug || null,
    },
    session: {
      id: session.id,
      startedAt: session.started_at,
      expiresAt: session.expires_at,
    },
  });

  return {
    id: session.id,
    orgId,
    orgName: targetOrg.name,
    adminId: targetAdmin.id,
    adminName: targetAdmin.name,
    adminEmail: targetAdmin.email,
    handoffCode,
    handoffExpiresIn: IMPERSONATION_HANDOFF_TTL_SECONDS,
    adminPortalUrl: env.frontend.adminUrl || null,
    expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS,
    expiresAt,
    maxDurationSeconds: Math.floor(IMPERSONATION_MAX_DURATION_MS / 1000),
    employee,
    startedAt: session.started_at,
    lastSeenAt: session.last_seen_at,
    reason: session.reason,
  };
}

async function endImpersonation({ superAdminId, sessionId, endReason = 'manual_end', ipAddress = null, userAgent = null }) {
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

  await session.update({
    ended_at: new Date(),
    ended_by: superAdminId,
    end_reason: endReason,
    ended_from_ip: ipAddress,
    ended_user_agent: userAgent,
  });
  return { ended: true, id: session.id };
}

async function getActiveImpersonation(superAdminId) {
  await expireStaleImpersonationSessions(superAdminId);

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

  const expiresAt = session.expires_at || new Date(new Date(session.started_at).getTime() + IMPERSONATION_MAX_DURATION_MS);

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
    expiresAt,
    lastSeenAt: session.last_seen_at,
    endedAt: session.ended_at,
  };
}

async function getImpersonationHistory(superAdminId, query = {}) {
  const { page, limit, offset } = getPagination(query);
  const where = buildImpersonationSessionWhere(superAdminId, query);
  const result = await ImpersonationSession.findAndCountAll({
    where,
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
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      endedAt: row.ended_at,
      endedBy: row.ended_by,
      endReason: row.end_reason,
      reason: row.reason,
    })),
    total: result.count,
    page,
    limit,
  };
}

async function getImpersonationDetail(superAdminId, sessionId) {
  const session = await ImpersonationSession.findOne({
    where: {
      id: sessionId,
      super_admin_id: superAdminId,
    },
  });

  if (!session) {
    throw createError('HTTP_404', 'Impersonation session not found', 404);
  }

  const [org, admin, auditResult] = await Promise.all([
    Organisation.findOne({ where: { id: session.target_org_id }, attributes: ['id', 'name', 'slug'] }),
    Employee.findOne({ where: { id: session.target_emp_id }, attributes: ['id', 'name', 'email'] }),
    AuditLog.findAndCountAll({
      where: { impersonation_session_id: session.id },
      order: [['created_at', 'DESC']],
      limit: 25,
    }),
  ]);

  const { orgMap, actorMap } = await getAuditLookupMaps(auditResult.rows);
  const expiresAt = session.expires_at || new Date(new Date(session.started_at).getTime() + IMPERSONATION_MAX_DURATION_MS);

  return {
    id: session.id,
    orgId: session.target_org_id,
    orgName: org ? org.name : null,
    orgSlug: org ? org.slug : null,
    adminId: session.target_emp_id,
    adminName: admin ? admin.name : null,
    adminEmail: admin ? admin.email : null,
    reason: session.reason,
    startedAt: session.started_at,
    expiresAt,
    lastSeenAt: session.last_seen_at,
    endedAt: session.ended_at,
    endedBy: session.ended_by,
    endReason: session.end_reason,
    endedFromIp: session.ended_from_ip,
    endedUserAgent: session.ended_user_agent,
    auditCount: auditResult.count,
    auditLogs: auditResult.rows.map((row) => formatAuditLogRecord(row, orgMap, actorMap)),
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
  const groupBy = ['daily', 'weekly', 'monthly'].includes(query.groupBy) ? query.groupBy : 'weekly';
  const weekStart = startOfUtcWeek(new Date());
  const weekSeries = Array.from({ length: weeks }, (_, index) => addUtcDays(weekStart, -7 * (weeks - 1 - index)));
  const monthStart = startOfUtcMonth(new Date());
  const monthSeries = Array.from({ length: months }, (_, index) => addUtcMonths(monthStart, -(months - 1 - index)));
  const orgWhere = buildAnalyticsOrgWhere(query);

  const [orgs, employees] = await Promise.all([
    Organisation.findAll({
      attributes: ['id', 'created_at', 'plan', 'is_active', 'cancelled_at'],
      where: orgWhere,
      paranoid: false,
    }),
    Employee.findAll({
      attributes: ['id', 'org_id', 'created_at', 'is_active', 'deleted_at'],
      where: {
        role: {
          [Op.ne]: 'superadmin',
        },
        ...(query.orgId ? { org_id: query.orgId } : {}),
      },
      paranoid: false,
    }),
  ]);
  const allowedOrgIds = new Set(orgs.map((org) => org.id));
  const scopedEmployees = employees.filter((employee) => allowedOrgIds.has(employee.org_id));

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
    const total = scopedEmployees.filter((employee) => new Date(employee.created_at) < end).length;
    const active = scopedEmployees.filter((employee) => new Date(employee.created_at) < end && employee.is_active).length;

    return {
      month: formatMonthLabel(start),
      total,
      active,
      inactive: Math.max(0, total - active),
    };
  });

  return {
    groupBy,
    newOrgsWeekly,
    employeeGrowth,
    summary: {
      orgCount: orgs.length,
      activeEmployeeCount: scopedEmployees.filter((employee) => employee.is_active).length,
      inactiveEmployeeCount: scopedEmployees.filter((employee) => !employee.is_active).length,
    },
  };
}

async function getAnalyticsUsage(query = {}) {
  const days = Math.max(1, Math.min(Number(query.days) || 30, 90));
  const groupBy = ['daily', 'weekly', 'monthly'].includes(query.groupBy) ? query.groupBy : 'daily';
  const start = query.from ? new Date(query.from) : addUtcDays(startOfToday(), -(days - 1));
  start.setUTCHours(0, 0, 0, 0);
  const end = query.to ? new Date(query.to) : startOfToday();
  end.setUTCHours(0, 0, 0, 0);
  const totalDays = Math.max(1, Math.min(Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1, 120));
  const dateSeries = Array.from({ length: totalDays }, (_, index) => addUtcDays(start, index));
  const orgIds = await getAnalyticsOrgIds(query);
  const attendanceWhere = {
    date: {
      [Op.gte]: dateSeries[0].toISOString().slice(0, 10),
      [Op.lte]: dateSeries[dateSeries.length - 1].toISOString().slice(0, 10),
    },
    ...(orgIds ? { org_id: { [Op.in]: orgIds } } : {}),
  };
  const employeeWhere = {
    role: {
      [Op.ne]: 'superadmin',
    },
    ...(orgIds ? { org_id: { [Op.in]: orgIds } } : {}),
  };

  const [attendanceRows, employees] = await Promise.all([
    Attendance.findAll({
      attributes: ['date', 'status', 'source', 'face_match_source'],
      where: attendanceWhere,
      paranoid: false,
    }),
    Employee.findAll({
      attributes: ['face_embedding_id', 'is_active'],
      where: employeeWhere,
      paranoid: false,
    }),
  ]);

  const attendanceByDate = attendanceRows.reduce((acc, row) => {
    const key = getAnalyticsBucketKey(row.date, groupBy);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const bucketKeys = [...new Set(dateSeries.map((date) => getAnalyticsBucketKey(date, groupBy)))];
  const successfulStatuses = new Set(['present', 'half_day', 'half_day_early', 'incomplete']);
  const successfulCheckins = attendanceRows.filter((row) => successfulStatuses.has(row.status)).length;
  const sourceCounts = attendanceRows.reduce((acc, row) => {
    const key = row.source || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const faceSourceCounts = attendanceRows.reduce((acc, row) => {
    const key = row.face_match_source || null;
    if (key) {
      acc[key] = (acc[key] || 0) + 1;
    }
    return acc;
  }, {});

  const enrolledEmployees = employees.filter((employee) => Boolean(employee.face_embedding_id));
  const localFacePercent = enrolledEmployees.length > 0 ? 0 : null;

  return {
    groupBy,
    checkinsDaily: bucketKeys.map((key) => {
      return {
        date: key,
        count: attendanceByDate[key] || 0,
      };
    }),
    checkinSummary: {
      totalRows: attendanceRows.length,
      successfulCheckins,
      successRate: attendanceRows.length > 0 ? Math.round((successfulCheckins / attendanceRows.length) * 100) : 0,
      sourceCounts,
    },
    activeEmployeeCount: employees.filter((employee) => employee.is_active).length,
    enrolledEmployeeCount: enrolledEmployees.length,
    faceEnrollmentRate: employees.length > 0 ? Math.round((enrolledEmployees.length / employees.length) * 100) : 0,
    faceSourceCounts,
    localFacePercent,
    cloudFacePercent: localFacePercent == null ? null : Math.max(0, 100 - localFacePercent),
  };
}

async function getAnalyticsRetention(query = {}) {
  const now = new Date();
  const currentMonth = startOfUtcMonth(now);
  const cohortMonths = Array.from({ length: 6 }, (_, index) => addUtcMonths(currentMonth, -(6 - index)));
  const orgWhere = buildAnalyticsOrgWhere(query);
  const orgs = await Organisation.findAll({
    attributes: ['id', 'created_at', 'is_active', 'plan', 'cancelled_at'],
    where: orgWhere,
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
      const activeOrgs = eligibleOrgs.filter((org) => !org.cancelled_at || new Date(org.cancelled_at) >= evaluationMonthEnd);
      monthData[`m${offset}`] = eligibleOrgs.length > 0
        ? Math.round((activeOrgs.length / eligibleOrgs.length) * 100)
        : null;
    }

    return monthData;
  }).filter((cohort) => cohort.size > 0);

  return { cohorts };
}

async function getBillingOverviewData() {
  const [orgs, employeeCounts, paymentRecords, planDefinitions] = await Promise.all([
    Organisation.findAll({
      attributes: ['id', 'name', 'slug', 'plan', 'settings', 'is_active', 'created_at', 'updated_at', 'cancelled_at', 'cancellation_reason'],
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
    planService.listPlanDefinitions({ includeInactive: true }),
  ]);
  const planByCode = planDefinitions.reduce((acc, plan) => {
    acc[plan.code] = plan;
    return acc;
  }, {});

  const employeeCountByOrg = employeeCounts.reduce((acc, employee) => {
    const key = employee.org_id;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const orgBillingRows = orgs.map((org) => {
    const employeeCount = employeeCountByOrg[org.id] || 0;
    const plan = planByCode[org.plan] || {};

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      isActive: Boolean(org.is_active),
      createdAt: org.created_at,
      updatedAt: org.updated_at,
      cancelledAt: org.cancelled_at,
      cancellationReason: org.cancellation_reason,
      employeeCount,
      planBillingType: plan.billingType,
      planPricePerEmployee: plan.pricePerEmployee,
      planMonthlyPrice: plan.monthlyPrice,
      mrr: plan.billingType === 'per_employee'
        ? Number(employeeCount || 0) * Number(plan.pricePerEmployee || 0)
        : plan.billingType === 'flat'
          ? Number(plan.monthlyPrice || 0)
          : 0,
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
  const verifiedPayments = paymentRecords.filter((record) => record.status === 'verified');
  const pendingPayments = paymentRecords.filter((record) => record.status === 'pending');
  const failedPayments = paymentRecords.filter((record) => record.status === 'failed');
  const collectedRevenueTotal = verifiedPayments.reduce((sum, record) => sum + Math.round(Number(record.amount_paise || 0) / 100), 0);

  const newRevMTD = orgs
    .filter((org) => org.isActive && org.plan !== 'trial' && new Date(org.createdAt) >= monthStart)
    .reduce((sum, org) => sum + org.mrr, 0);

  const churnedRevMTD = orgs
    .filter((org) => org.cancelledAt && new Date(org.cancelledAt) >= monthStart)
    .reduce((sum, org) => sum + org.mrr, 0);

  return {
    estimatedMrr: mrr,
    mrr,
    estimatedArr: mrr * 12,
    payingOrgs,
    arpu,
    verifiedPaymentCount: verifiedPayments.length,
    pendingPaymentCount: pendingPayments.length,
    failedPaymentCount: failedPayments.length,
    collectedRevenueTotal,
    estimatedNewMrrMTD: newRevMTD,
    newRevMTD,
    estimatedChurnedMrrMTD: churnedRevMTD,
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

async function listPlans() {
  const plans = await planService.listPlanDefinitions({ includeInactive: true, includeUsage: true });
  const breakdown = await getBillingPlanBreakdown();
  const billingByPlan = breakdown.reduce((acc, row) => {
    acc[row.plan] = row;
    return acc;
  }, {});

  return {
    plans: plans.map((plan) => ({
      ...plan,
      usage: {
        ...(plan.usage || {}),
        revenue: billingByPlan[plan.code]?.revenue || 0,
      },
    })),
  };
}

async function upsertPlan(payload, code = null) {
  const plan = await planService.upsertPlanDefinition(payload, code);
  return { plan };
}

async function getBillingChurnedOrgs(query = {}) {
  const limit = Math.max(1, Math.min(Number(query.limit) || 10, 50));
  const monthStart = startOfUtcMonth(new Date());
  const { orgs } = await getBillingOverviewData();

  const churned = orgs
    .filter((org) => org.cancelledAt && new Date(org.cancelledAt) >= monthStart)
    .sort((a, b) => new Date(b.cancelledAt) - new Date(a.cancelledAt))
    .slice(0, limit)
    .map((org) => ({
      id: org.id,
      name: org.name,
      mrr: org.mrr,
      cancelledAt: org.cancelledAt,
      cancellationReason: org.cancellationReason,
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
  const where = {};
  const orgWhere = {};
  const include = [{
    model: Organisation,
    attributes: ['id', 'name', 'slug', 'plan'],
    required: false,
  }];

  if (query.status) {
    where.status = query.status === 'paid' ? 'verified' : query.status;
  }

  if (query.currency) {
    where.currency = String(query.currency).trim().toUpperCase();
  }

  if (query.from || query.to) {
    where.created_at = {};
    if (query.from) {
      where.created_at[Op.gte] = new Date(query.from);
    }
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setUTCHours(23, 59, 59, 999);
      where.created_at[Op.lte] = toDate;
    }
  }

  if (query.plan) {
    orgWhere.plan = query.plan;
  }

  if (query.search) {
    const search = String(query.search).trim();
    if (search) {
      orgWhere[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { slug: { [Op.iLike]: `%${search}%` } },
      ];
    }
  }

  if (Object.keys(orgWhere).length > 0) {
    include[0].where = orgWhere;
    include[0].required = true;
  }

  const orderFieldMap = {
    date: 'created_at',
    amount: 'amount_paise',
    status: 'status',
    currency: 'currency',
  };
  const orderField = orderFieldMap[query.sortBy] || 'created_at';
  const orderDirection = String(query.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const result = await PaymentRecord.findAndCountAll({
    where,
    include,
    order: [[orderField, orderDirection]],
    limit,
    offset,
    distinct: true,
  });

  const invoices = result.rows.map((record) => ({
    id: record.id,
    invoiceNo: record.invoice_id,
    orgId: record.org_id,
    orgName: record.Organisation?.name || 'Unknown Org',
    orgSlug: record.Organisation?.slug || null,
    plan: record.Organisation?.plan || null,
    amount: Math.round(Number(record.amount_paise || 0) / 100),
    amountPaise: record.amount_paise,
    currency: record.currency || 'INR',
    date: record.created_at,
    status: record.status === 'verified' ? 'paid' : record.status,
    gatewayStatus: record.status,
    razorpayOrderId: record.razorpay_order_id,
    razorpayPaymentId: record.razorpay_payment_id,
    errorCode: record.error_code,
    errorMessage: record.error_message,
    source: 'payment_record',
  }));

  return {
    invoices,
    total: result.count,
    page,
    limit,
    totalPages: Math.ceil(result.count / limit) || 1,
  };
}

async function exportBillingInvoices(query = {}) {
  const data = await getBillingInvoices({
    ...query,
    page: 1,
    limit: 10000,
  });

  const rows = [
    ['Invoice', 'Organisation', 'Org Slug', 'Plan', 'Date', 'Amount', 'Currency', 'Status', 'Razorpay Order', 'Razorpay Payment', 'Error'],
    ...data.invoices.map((invoice) => [
      invoice.invoiceNo,
      invoice.orgName,
      invoice.orgSlug || '',
      invoice.plan || '',
      invoice.date ? new Date(invoice.date).toISOString() : '',
      invoice.amount,
      invoice.currency,
      invoice.status,
      invoice.razorpayOrderId || '',
      invoice.razorpayPaymentId || '',
      invoice.errorMessage || invoice.errorCode || '',
    ]),
  ];

  const filenameDate = new Date().toISOString().slice(0, 10);

  return {
    filename: `billing-invoices-${filenameDate}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: `${buildCsv(rows)}\r\n`,
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
  getOrgSlugPreview,
  listOrgs,
  exportOrganisations,
  getOrgDetail,
  getOrgEmployees,
  getOrgAttendanceToday,
  getOrgBilling,
  sendBillingAlert,
  resendOrgAdminInvite,
  updateOrgProfile,
  suspendOrg,
  activateOrg,
  cancelOrg,
  addOrgNote,
  transferOrgOwner,
  changePlan,
  getOrgPlanHistory,
  extendTrial,
  getStats,
  getAuditLogs,
  getAuditLogSummary,
  getAuditLogById,
  exportAuditLogs,
  startImpersonation,
  endImpersonation,
  getActiveImpersonation,
  getImpersonationHistory,
  getImpersonationDetail,
  getAllFeatureFlags,
  setFeatureFlagGlobal,
  setFeatureFlagOrgOverride,
  removeFeatureFlagOrgOverride,
  getFeatureFlagOrgs,
  getAnalyticsGrowth,
  getAnalyticsUsage,
  getAnalyticsRetention,
  getRevenueSummary,
  listPlans,
  upsertPlan,
  getBillingMrrHistory,
  getBillingPlanBreakdown,
  getBillingChurnedOrgs,
  getBillingInvoices,
  exportBillingInvoices,
  getBillingTopOrgs,
  getQueueStatusByName,
  getDatabaseHealthStatus,
  getQueueSnapshot,
  retryQueueJob,
  retryAllFailedJobs,
};
