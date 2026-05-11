const { Op } = require('sequelize');
const { AttendanceSession, DeviceToken, Employee, Notification } = require('../../models');
const { redisClient } = require('../../config/redis');
const { notification: notificationQueue } = require('../../queues');
const { getPagination } = require('../../utils/pagination');
const { log } = require('../../utils/auditLog');
const { sendMulticast } = require('./notification.fcm');
const { sendWelcomeEmployeeEmail, sendOrgAdminBillingAlertEmail } = require('./email.service');

const FCM_BATCH_SIZE = 500;
const DEFAULT_NOTIFICATION_PREFERENCES = {
  leave_approved: true,
  leave_rejected: true,
  late_marked: true,
  absent_marked: true,
  regularisation_approved: true,
  regularisation_rejected: true,
  checkout_reminder: true,
  announcements: true,
};

const COOLDOWN_SECONDS_BY_TYPE = {
  checkout_reminder: 60 * 60,
  late_marked: 4 * 60 * 60,
  absent_marked: 4 * 60 * 60,
  leave_approved: 5 * 60,
  leave_rejected: 5 * 60,
  regularisation_approved: 5 * 60,
  regularisation_rejected: 5 * 60,
  announcements: 10 * 60,
};

const TTL_SECONDS_BY_TYPE = {
  checkout_reminder: 60 * 60,
};

const NOTIFICATION_CATEGORIES = {
  leave_request: 'leave',
  leave_request_submitted: 'leave',
  leave_approved: 'leave',
  leave_rejected: 'leave',
  leave_cancelled: 'leave',
  regularisation_request: 'regularisation',
  regularisation_submitted: 'regularisation',
  regularisation_approved: 'regularisation',
  regularisation_rejected: 'regularisation',
  device_exception_requested: 'device_exception',
  device_exception_approved: 'device_exception',
  device_exception_rejected: 'device_exception',
  checkin_reminder: 'attendance',
  checkout_reminder: 'attendance',
  attendance_marked: 'attendance',
  attendance_anomaly: 'attendance',
  late_marked: 'attendance',
  absent_marked: 'attendance',
  face_enrollment: 'employee',
  face_enrollment_complete: 'employee',
  new_employee_onboarded: 'employee',
  billing_alert: 'billing',
  report_generated: 'report',
  report_failed: 'report',
  branch_updated: 'system',
  branch_geofence_changed: 'system',
  shift_changed: 'system',
  general: 'system',
};

const NOTIFICATION_PRIORITIES = {
  attendance_anomaly: 'critical',
  device_exception_requested: 'critical',
  billing_alert: 'critical',
  absent_marked: 'high',
  leave_request_submitted: 'high',
  regularisation_submitted: 'high',
  regularisation_request: 'high',
  leave_request: 'high',
  late_marked: 'normal',
  checkout_reminder: 'normal',
  checkin_reminder: 'normal',
  report_failed: 'normal',
  report_generated: 'low',
  branch_geofence_changed: 'normal',
  branch_updated: 'low',
  shift_changed: 'normal',
  face_enrollment: 'low',
  face_enrollment_complete: 'low',
  new_employee_onboarded: 'low',
  general: 'low',
};

const NOTIFICATION_STATUSES = {
  leave_request: 'action_needed',
  leave_request_submitted: 'action_needed',
  regularisation_request: 'action_needed',
  regularisation_submitted: 'action_needed',
  device_exception_requested: 'action_needed',
  leave_approved: 'approved',
  regularisation_approved: 'approved',
  device_exception_approved: 'approved',
  leave_rejected: 'rejected',
  regularisation_rejected: 'rejected',
  device_exception_rejected: 'rejected',
  leave_cancelled: 'cancelled',
  report_failed: 'failed',
  report_generated: 'completed',
  branch_geofence_changed: 'completed',
  branch_updated: 'completed',
  shift_changed: 'completed',
};

function getNotificationCategory(type) {
  return NOTIFICATION_CATEGORIES[type] || 'system';
}

function getNotificationPriority(type, data = {}) {
  return data.priority || NOTIFICATION_PRIORITIES[type] || 'normal';
}

function getNotificationStatus(type, data = {}) {
  return data.status || NOTIFICATION_STATUSES[type] || 'info';
}

function buildNotificationDto(row) {
  const data = row.data || {};
  const employee = row.employee
    ? {
        id: row.employee.id,
        name: row.employee.name,
        empCode: row.employee.emp_code,
        email: row.employee.email,
      }
    : null;

  return {
    id: row.id,
    type: row.type,
    category: getNotificationCategory(row.type),
    priority: getNotificationPriority(row.type, data),
    status: getNotificationStatus(row.type, data),
    title: row.title,
    body: row.body,
    message: row.body,
    actionUrl: row.action_url,
    action_url: row.action_url,
    data,
    employee,
    isRead: Boolean(row.is_read),
    is_read: Boolean(row.is_read),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeNotificationData(payload = {}) {
  return {
    ...(payload.data && typeof payload.data === 'object' ? payload.data : {}),
    type: payload.type,
    action_url: payload.actionUrl || payload.action_url || '',
    actionUrl: payload.actionUrl || payload.action_url || '',
    sent_at: String(Date.now()),
  };
}

function getCooldownSeconds(type) {
  return COOLDOWN_SECONDS_BY_TYPE[type] || 5 * 60;
}

async function isCooldownOpen(employeeId, type) {
  const key = `notif_cooldown:${employeeId}:${type}`;

  try {
    const existing = await redisClient.get(key);
    if (existing) {
      return false;
    }

    await redisClient.set(key, '1', 'EX', getCooldownSeconds(type));
    return true;
  } catch (error) {
    return true;
  }
}

function isNotificationEnabled(employee, type) {
  const preferences = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(employee.notification_preferences || {}),
  };

  return !(
    preferences.enabled === false ||
    preferences.push === false ||
    preferences[type] === false
  );
}

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function persistNotifications(orgId, employeeIds, payload) {
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
    return [];
  }

  return Notification.bulkCreate(
    employeeIds.map((employeeId) => ({
      org_id: orgId,
      emp_id: employeeId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      data: normalizeNotificationData(payload),
      action_url: payload.actionUrl || null,
    })),
    {
      returning: true,
    }
  );
}

async function dispatchPushNow(orgId, employeeIds, payload) {
  // ✅ FIX: Validate employees belong to org
  const employees = await Employee.findAll({
    where: {
      id: { [Op.in]: employeeIds },
      org_id: orgId,
      is_active: true,
    },
    attributes: ['id', 'org_id', 'notification_preferences'],
  });

  if (employees.length !== employeeIds.length) {
    // Some employees don't belong to this org
    return {
      sentCount: 0,
      failedCount: 0,
      skipped: true,
      reason: 'invalid_employees',
      notificationCount: 0,
    };
  }

  const preferenceEligibleEmployeeIds = employees
    .filter((employee) => {
      return isNotificationEnabled(employee, payload.type);
    })
    .map((employee) => employee.id);

  const eligibleEmployeeIds = [];
  for (const employeeId of preferenceEligibleEmployeeIds) {
    if (await isCooldownOpen(employeeId, payload.type)) {
      eligibleEmployeeIds.push(employeeId);
    }
  }

  if (eligibleEmployeeIds.length === 0) {
    return {
      sentCount: 0,
      failedCount: 0,
      skipped: true,
      reason: preferenceEligibleEmployeeIds.length === 0 ? 'notification_preferences_disabled' : 'cooldown_active',
      notificationCount: 0,
    };
  }

  const tokenRows = await DeviceToken.findAll({
    where: {
      org_id: orgId,
      emp_id: { [Op.in]: eligibleEmployeeIds },
      is_active: true,
    },
    attributes: ['id', 'fcm_token', 'emp_id', 'org_id'],
    order: [['is_primary', 'DESC'], ['created_at', 'DESC']],
  });

  // ✅ FIX: Validate tokens belong to employees in this org
  const validTokenRows = tokenRows.filter(t => t.org_id === orgId && eligibleEmployeeIds.includes(t.emp_id));

  const seenValues = new Set();
  const uniqueTokens = validTokenRows.filter((tokenRow) => {
    if (seenValues.has(tokenRow.fcm_token)) {
      return false;
    }

    seenValues.add(tokenRow.fcm_token);
    return true;
  });

  const notificationData = normalizeNotificationData(payload);
  const ttlSeconds = payload.ttlSeconds || TTL_SECONDS_BY_TYPE[payload.type] || null;
  const batchResults = [];
  let successCount = 0;
  let failureCount = 0;

  for (const tokenChunk of chunkArray(uniqueTokens, FCM_BATCH_SIZE)) {
    const result = await sendMulticast({
      tokens: tokenChunk.map((tokenRow) => tokenRow.fcm_token),
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: notificationData,
      ttlSeconds,
    });

    successCount += Number(result.successCount || 0);
    failureCount += Number(result.failureCount || 0);
    batchResults.push({ tokenChunk, result });
  }

  for (const { tokenChunk, result } of batchResults) {
    if (!Array.isArray(result.responses)) {
      continue;
    }

    const invalidTokenIds = [];

    result.responses.forEach((response, index) => {
      const errorCode = response && response.error && response.error.code ? response.error.code : '';

      if (
        errorCode === 'messaging/registration-token-not-registered' ||
        errorCode === 'messaging/invalid-registration-token'
      ) {
        invalidTokenIds.push(tokenChunk[index].id);
      }
    });

    if (invalidTokenIds.length > 0) {
      await DeviceToken.update(
        { is_active: false },
        {
          where: {
            id: {
              [Op.in]: invalidTokenIds,
            },
            org_id: orgId,
          },
        }
      );
    }
  }

  const savedNotifications = await persistNotifications(orgId, eligibleEmployeeIds, payload);

  return {
    sentCount: successCount,
    failedCount: failureCount,
    skipped: batchResults.every(({ result }) => Boolean(result.skipped)),
    reason: batchResults.find(({ result }) => result.reason)?.result.reason || null,
    notificationCount: savedNotifications.length,
  };
}

async function processSendPushJob(jobData) {
  const { orgId, empIds, type, title, body, actionUrl = null, data = {}, ttlSeconds = null } = jobData;

  if (!orgId || !Array.isArray(empIds) || empIds.length === 0 || !type || !title || !body) {
    return {
      sentCount: 0,
      failedCount: 0,
      notificationCount: 0,
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  return dispatchPushNow(orgId, empIds, { type, title, body, actionUrl, data, ttlSeconds });
}

async function processShiftReminderJob(jobData) {
  const {
    orgId,
    shiftId,
    reminderType,
    type,
    title,
    body,
    actionUrl = null,
  } = jobData;

  if (!orgId || !shiftId || !title || !body) {
    return {
      sentCount: 0,
      failedCount: 0,
      notificationCount: 0,
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  const employees = await Employee.findAll({
    where: {
      org_id: orgId,
      shift_id: shiftId,
      is_active: true,
      role: {
        [Op.ne]: 'superadmin',
      },
    },
    attributes: ['id'],
  });

  if (employees.length === 0) {
    return {
      sentCount: 0,
      failedCount: 0,
      notificationCount: 0,
      skipped: true,
      reason: 'no_recipients',
    };
  }

  return dispatchPushNow(
    orgId,
    employees.map((employee) => employee.id),
    {
      type: type || reminderType || 'shift_reminder',
      title,
      body,
      actionUrl,
      data: jobData.data || {},
      ttlSeconds: jobData.ttlSeconds || null,
    }
  );
}

async function processCheckoutReminderJob(jobData) {
  const { orgId, empId, attendanceId, sessionId } = jobData || {};

  if (!orgId || !empId || !attendanceId || !sessionId) {
    return {
      sentCount: 0,
      failedCount: 0,
      notificationCount: 0,
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  const session = await AttendanceSession.findOne({
    where: {
      id: sessionId,
      attendance_id: attendanceId,
      org_id: orgId,
      emp_id: empId,
    },
  });

  if (!session || session.check_out_time || session.status !== 'open') {
    return {
      sentCount: 0,
      failedCount: 0,
      notificationCount: 0,
      skipped: true,
      reason: 'already_checked_out',
    };
  }

  return dispatchPushNow(orgId, [empId], {
    type: 'checkout_reminder',
    title: "Don't forget to check out",
    body: 'Your shift has ended. Tap here to mark your check-out.',
    actionUrl: `attendease://checkout/${attendanceId}`,
    data: {
      attendance_id: attendanceId,
      session_id: sessionId,
    },
    ttlSeconds: TTL_SECONDS_BY_TYPE.checkout_reminder,
  });
}

async function processSendWelcomeEmailJob(jobData) {
  const {
    email,
    organisationName,
    employeeName,
    tempPassword,
  } = jobData;

  if (!email || !organisationName || !employeeName || !tempPassword) {
    return {
      sent: false,
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  return sendWelcomeEmployeeEmail({
    to: email,
    organisationName,
    employeeName,
    employeeEmail: email,
    tempPassword,
  });
}

async function processSendBillingAlertEmailJob(jobData) {
  const {
    email,
    organisationName,
    adminName,
    alertType,
    customMessage,
  } = jobData;

  if (!email || !organisationName || !adminName || !alertType) {
    return {
      sent: false,
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  return sendOrgAdminBillingAlertEmail({
    to: email,
    organisationName,
    adminName,
    alertType,
    customMessage,
  });
}

async function sendPush(empIds, payload) {
  if (!Array.isArray(empIds) || empIds.length === 0) {
    return {
      queued: 0,
      jobs: [],
    };
  }

  const employees = await Employee.findAll({
    where: {
      id: {
        [Op.in]: empIds,
      },
      is_active: true,
    },
    attributes: ['id', 'org_id'],
  });

  const groupedByOrg = employees.reduce((accumulator, employee) => {
    if (!accumulator[employee.org_id]) {
      accumulator[employee.org_id] = [];
    }

    accumulator[employee.org_id].push(employee.id);
    return accumulator;
  }, {});

  const jobs = [];

  for (const [orgId, employeeIds] of Object.entries(groupedByOrg)) {
    const job = await notificationQueue.add(
      'send_push',
      {
        orgId,
        empIds: employeeIds,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        actionUrl: payload.actionUrl || null,
        data: payload.data || {},
        ttlSeconds: payload.ttlSeconds || null,
      },
      {
        jobId: `send_push_${orgId}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      }
    );

    jobs.push({
      orgId,
      employeeCount: employeeIds.length,
      jobId: job.id,
    });
  }

  return {
    queued: jobs.length,
    jobs,
  };
}

async function notifyOrgRoles(orgId, roles, payload, options = {}) {
  if (!orgId || !Array.isArray(roles) || roles.length === 0 || !payload) {
    return {
      queued: 0,
      jobs: [],
    };
  }

  const excludeEmployeeIds = Array.isArray(options.excludeEmployeeIds)
    ? options.excludeEmployeeIds.filter(Boolean)
    : [];

  const where = {
    org_id: orgId,
    is_active: true,
    role: {
      [Op.in]: roles,
    },
  };

  if (excludeEmployeeIds.length > 0) {
    where.id = {
      [Op.notIn]: excludeEmployeeIds,
    };
  }

  const employees = await Employee.findAll({
    where,
    attributes: ['id'],
  });

  if (employees.length === 0) {
    return {
      queued: 0,
      jobs: [],
    };
  }

  return sendPush(
    employees.map((employee) => employee.id),
    payload
  );
}

async function queueWelcomeEmail(payload) {
  if (!payload || !payload.email || !payload.organisationName || !payload.employeeName || !payload.tempPassword) {
    throw createError('NOTIF_003', 'Welcome email payload is incomplete', 422);
  }

  const job = await notificationQueue.add(
    'send_welcome_email',
    {
      email: payload.email,
      organisationName: payload.organisationName,
      employeeName: payload.employeeName,
      tempPassword: payload.tempPassword,
    },
    {
      jobId: `welcome_email_${payload.email}_${Date.now()}`,
    }
  );

  return {
    queued: true,
    jobId: job.id,
  };
}

async function queueBillingAlertEmail(payload) {
  if (!payload || !payload.email || !payload.organisationName || !payload.adminName || !payload.alertType) {
    throw createError('NOTIF_004', 'Billing alert email payload is incomplete', 422);
  }

  const job = await notificationQueue.add(
    'send_billing_alert_email',
    {
      email: payload.email,
      organisationName: payload.organisationName,
      adminName: payload.adminName,
      alertType: payload.alertType,
      customMessage: payload.customMessage || null,
    },
    {
      jobId: `billing_alert_email_${payload.email}_${Date.now()}`,
    }
  );

  return {
    queued: true,
    jobId: job.id,
  };
}

async function listNotifications({ orgId, employeeId, query }) {
  const { page, limit, offset } = getPagination(query);
  const where = {
    org_id: orgId,
    emp_id: employeeId,
  };

  if (query?.type) {
    const types = String(query.type)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (types.length > 0) {
      where.type = {
        [Op.in]: types,
      };
    }
  }

  if (query?.category) {
    const categoryTypes = Object.entries(NOTIFICATION_CATEGORIES)
      .filter(([, category]) => category === query.category)
      .map(([type]) => type);

    where.type = categoryTypes.length > 0 ? { [Op.in]: categoryTypes } : '__none__';
  }

  if (query?.isRead === 'true' || query?.isRead === true) {
    where.is_read = true;
  }

  if (query?.isRead === 'false' || query?.isRead === false) {
    where.is_read = false;
  }

  if (query?.dateFrom || query?.dateTo) {
    where.created_at = {};

    if (query.dateFrom) {
      where.created_at[Op.gte] = new Date(`${query.dateFrom}T00:00:00.000Z`);
    }

    if (query.dateTo) {
      where.created_at[Op.lte] = new Date(`${query.dateTo}T23:59:59.999Z`);
    }
  }

  if (query?.search) {
    const searchTerm = `%${String(query.search).trim()}%`;
    where[Op.or] = [
      { title: { [Op.iLike]: searchTerm } },
      { body: { [Op.iLike]: searchTerm } },
      { type: { [Op.iLike]: searchTerm } },
    ];
  }

  const result = await Notification.findAndCountAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name', 'emp_code', 'email'],
        required: false,
      },
    ],
    order: [['is_read', 'ASC'], ['created_at', 'DESC']],
    distinct: true,
    limit,
    offset,
  });

  const unreadCount = await Notification.count({
    where: {
      org_id: orgId,
      emp_id: employeeId,
      is_read: false,
    },
  });

  return {
    notifications: result.rows.map(buildNotificationDto),
    unreadCount,
    count: unreadCount,
    page,
    limit,
    total: result.count,
    totalPages: Math.ceil(result.count / limit) || 1,
    hasMore: offset + result.rows.length < result.count,
  };
}

async function markAsRead({ orgId, employeeId, ids, req }) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw createError('NOTIF_002', 'Notification ids are required', 422, [
      { field: 'ids', message: 'Provide at least one notification id' },
    ]);
  }

  const [updatedCount] = await Notification.update(
    {
      is_read: true,
      read_at: new Date(),
    },
    {
      where: {
        id: {
          [Op.in]: ids,
        },
        org_id: orgId,
        emp_id: employeeId,
        is_read: false,
      },
    }
  );

  await log(req.employee, 'notification.read', { type: 'notification', id: ids.join(',') }, null, { ids }, req);

  return {
    updatedCount,
  };
}

async function markAllAsRead({ orgId, employeeId, req }) {
  const [updatedCount] = await Notification.update(
    {
      is_read: true,
      read_at: new Date(),
    },
    {
      where: {
        org_id: orgId,
        emp_id: employeeId,
        is_read: false,
      },
    }
  );

  await log(req.employee, 'notification.read_all', { type: 'notification', id: employeeId }, null, null, req);

  return {
    updatedCount,
  };
}

async function getUnreadCount({ orgId, employeeId }) {
  const unreadCount = await Notification.count({
    where: {
      org_id: orgId,
      emp_id: employeeId,
      is_read: false,
    },
  });

  return {
    unreadCount,
    count: unreadCount,
  };
}

async function registerToken({ orgId, employeeId, body, req }) {
  const fcmToken = typeof body.fcmToken === 'string'
    ? body.fcmToken.trim()
    : typeof body.fcm_token === 'string'
      ? body.fcm_token.trim()
      : '';
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : null;
  const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : null;

  if (!fcmToken) {
    throw createError('NOTIF_001', 'FCM token is required', 422, [
      { field: 'fcmToken', message: 'FCM token is required' },
    ]);
  }

  await DeviceToken.update(
    { is_primary: false },
    {
      where: {
        org_id: orgId,
        emp_id: employeeId,
      },
    }
  );

  const existing = await DeviceToken.findOne({
    where: {
      org_id: orgId,
      emp_id: employeeId,
      fcm_token: fcmToken,
    },
  });

  if (existing) {
    await existing.update({
      device_id: deviceId,
      platform,
      is_primary: true,
      is_active: true,
    });
  } else {
    await DeviceToken.create({
      org_id: orgId,
      emp_id: employeeId,
      fcm_token: fcmToken,
      device_id: deviceId,
      platform,
      is_primary: true,
    });
  }

  await log(req.employee, 'notification.register_token', { type: 'device_token', id: employeeId }, null, { deviceId }, req);

  return {
    registered: true,
  };
}

async function deregisterToken({ orgId, employeeId, body, req }) {
  const fcmToken = typeof body.fcmToken === 'string'
    ? body.fcmToken.trim()
    : typeof body.fcm_token === 'string'
      ? body.fcm_token.trim()
      : '';

  if (!fcmToken) {
    throw createError('NOTIF_001', 'FCM token is required', 422, [
      { field: 'fcmToken', message: 'FCM token is required' },
    ]);
  }

  const [updatedCount] = await DeviceToken.update(
    { is_active: false, is_primary: false },
    {
      where: {
        org_id: orgId,
        emp_id: employeeId,
        fcm_token: fcmToken,
      },
    }
  );

  await log(req.employee, 'notification.deregister_token', { type: 'device_token', id: employeeId }, null, { updatedCount }, req);

  return {
    deregistered: updatedCount > 0,
    updatedCount,
  };
}

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  sendPush,
  notifyOrgRoles,
  queueWelcomeEmail,
  queueBillingAlertEmail,
  processSendPushJob,
  processShiftReminderJob,
  processCheckoutReminderJob,
  processSendWelcomeEmailJob,
  processSendBillingAlertEmailJob,
  listNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  registerToken,
  deregisterToken,
};
