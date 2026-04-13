const { Op } = require('sequelize');
const { DeviceToken, Employee, Notification } = require('../../models');
const { notification: notificationQueue } = require('../../queues');
const { getPagination } = require('../../utils/pagination');
const { log } = require('../../utils/auditLog');
const { sendMulticast } = require('./notification.fcm');
const { sendWelcomeEmployeeEmail } = require('./email.service');

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
    attributes: ['id', 'org_id'],
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

  const tokenRows = await DeviceToken.findAll({
    where: {
      org_id: orgId,
      emp_id: { [Op.in]: employeeIds },
    },
    attributes: ['id', 'fcm_token', 'emp_id', 'org_id'],
    order: [['is_primary', 'DESC'], ['created_at', 'DESC']],
  });

  // ✅ FIX: Validate tokens belong to employees in this org
  const validTokenRows = tokenRows.filter(t => t.org_id === orgId && employeeIds.includes(t.emp_id));

  const seenValues = new Set();
  const uniqueTokens = validTokenRows.filter((tokenRow) => {
    if (seenValues.has(tokenRow.fcm_token)) {
      return false;
    }

    seenValues.add(tokenRow.fcm_token);
    return true;
  });

  const pushResult = await sendMulticast({
    tokens: uniqueTokens.map((tokenRow) => tokenRow.fcm_token),
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: {
      type: payload.type,
      actionUrl: payload.actionUrl || '',
    },
  });

  if (Array.isArray(pushResult.responses)) {
    const invalidTokenIds = [];

    pushResult.responses.forEach((response, index) => {
      const errorCode = response && response.error && response.error.code ? response.error.code : '';

      if (
        errorCode === 'messaging/registration-token-not-registered' ||
        errorCode === 'messaging/invalid-registration-token'
      ) {
        invalidTokenIds.push(uniqueTokens[index].id);
      }
    });

    if (invalidTokenIds.length > 0) {
      await DeviceToken.destroy({
        where: {
          id: {
            [Op.in]: invalidTokenIds,
          },
          org_id: orgId,
        },
      });
    }
  }

  const savedNotifications = await persistNotifications(orgId, employeeIds, payload);

  return {
    sentCount: pushResult.successCount || 0,
    failedCount: pushResult.failureCount || 0,
    skipped: Boolean(pushResult.skipped),
    reason: pushResult.reason || null,
    notificationCount: savedNotifications.length,
  };
}

async function processSendPushJob(jobData) {
  const { orgId, empIds, type, title, body, actionUrl = null } = jobData;

  if (!orgId || !Array.isArray(empIds) || empIds.length === 0 || !type || !title || !body) {
    return {
      sentCount: 0,
      failedCount: 0,
      notificationCount: 0,
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  return dispatchPushNow(orgId, empIds, { type, title, body, actionUrl });
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
      },
      {
        jobId: `send_push_${orgId}_${Date.now()}`,
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

async function listNotifications({ orgId, employeeId, query }) {
  const { page, limit, offset } = getPagination(query);

  const result = await Notification.findAndCountAll({
    where: {
      org_id: orgId,
      emp_id: employeeId,
    },
    order: [['is_read', 'ASC'], ['created_at', 'DESC']],
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
    notifications: result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      actionUrl: row.action_url,
      isRead: Boolean(row.is_read),
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
    unreadCount,
    page,
    total: result.count,
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
  };
}

async function registerToken({ orgId, employeeId, body, req }) {
  const fcmToken = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : null;

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
      is_primary: true,
    });
  } else {
    await DeviceToken.create({
      org_id: orgId,
      emp_id: employeeId,
      fcm_token: fcmToken,
      device_id: deviceId,
      is_primary: true,
    });
  }

  await log(req.employee, 'notification.register_token', { type: 'device_token', id: employeeId }, null, { deviceId }, req);

  return {
    registered: true,
  };
}

module.exports = {
  sendPush,
  queueWelcomeEmail,
  processSendPushJob,
  processSendWelcomeEmailJob,
  listNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  registerToken,
};
