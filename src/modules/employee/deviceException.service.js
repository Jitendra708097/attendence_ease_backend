const { Op } = require('sequelize');
const { DeviceException, Employee } = require('../../models');
const { sendPush } = require('../notification/notification.service');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function toDto(record) {
  return {
    id: record.id,
    orgId: record.org_id,
    empId: record.emp_id,
    employeeName: record.employee ? record.employee.name : null,
    tempDeviceId: record.temp_device_id,
    status: record.status,
    expiresAt: record.expires_at,
    approvedAt: record.approved_at,
    approvedBy: record.approved_by,
    reason: record.reason,
    createdAt: record.created_at,
  };
}

async function createDeviceException({ orgId, empId, tempDeviceId, reason, approveNow = true, approvedBy }) {
  if (!empId || !tempDeviceId) {
    throw createError('DEV_001', 'Employee and temporary device id are required', 422, [
      { field: 'empId', message: 'Employee is required' },
      { field: 'tempDeviceId', message: 'Temporary device id is required' },
    ]);
  }

  const employee = await Employee.findOne({
    where: {
      id: empId,
      org_id: orgId,
      is_active: true,
    },
  });

  if (!employee) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  await DeviceException.update(
    { status: 'expired' },
    {
      where: {
        org_id: orgId,
        emp_id: empId,
        status: 'pending',
      },
    }
  );

  const now = new Date();
  const exception = await DeviceException.create({
    org_id: orgId,
    emp_id: empId,
    temp_device_id: String(tempDeviceId).trim(),
    reason: reason || null,
    status: approveNow ? 'approved' : 'pending',
    approved_by: approveNow ? approvedBy : null,
    approved_at: approveNow ? now : null,
    expires_at: approveNow ? new Date(now.getTime() + 60 * 60 * 1000) : null,
  });

  if (approveNow) {
    await sendPush([empId], {
      type: 'general',
      title: 'One-time device check-in approved',
      body: 'Your one-time device exception has been approved for the next hour.',
      actionUrl: '/device-exception',
    });
  }

  const hydrated = await DeviceException.findOne({
    where: {
      id: exception.id,
      org_id: orgId,
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
    ],
  });

  return toDto(hydrated);
}

async function listDeviceExceptions({ orgId, query = {} }) {
  const where = { org_id: orgId };

  if (query.empId) {
    where.emp_id = query.empId;
  }

  if (query.status) {
    where.status = query.status;
  }

  const rows = await DeviceException.findAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
    ],
    order: [['created_at', 'DESC']],
  });

  return {
    exceptions: rows.map(toDto),
    total: rows.length,
  };
}

async function listOwnDeviceExceptions({ orgId, empId }) {
  const rows = await DeviceException.findAll({
    where: {
      org_id: orgId,
      emp_id: empId,
      status: {
        [Op.in]: ['pending', 'approved', 'used'],
      },
    },
    order: [['created_at', 'DESC']],
  });

  return {
    exceptions: rows.map(toDto),
    total: rows.length,
  };
}

async function approveDeviceException({ orgId, id, approvedBy }) {
  const exception = await DeviceException.findOne({
    where: {
      id,
      org_id: orgId,
      status: 'pending',
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
    ],
  });

  if (!exception) {
    throw createError('HTTP_404', 'Pending device exception not found', 404);
  }

  const now = new Date();
  await exception.update({
    status: 'approved',
    approved_by: approvedBy,
    approved_at: now,
    expires_at: new Date(now.getTime() + 60 * 60 * 1000),
  });

  await sendPush([exception.emp_id], {
    type: 'general',
    title: 'One-time device check-in approved',
    body: 'Your one-time device exception has been approved for the next hour.',
    actionUrl: '/device-exception',
  });

  return toDto(exception);
}

async function rejectDeviceException({ orgId, id, approvedBy }) {
  const exception = await DeviceException.findOne({
    where: {
      id,
      org_id: orgId,
      status: {
        [Op.in]: ['pending', 'approved'],
      },
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
    ],
  });

  if (!exception) {
    throw createError('HTTP_404', 'Device exception not found', 404);
  }

  await exception.update({
    status: 'expired',
    approved_by: approvedBy,
    approved_at: new Date(),
    expires_at: new Date(),
  });

  await sendPush([exception.emp_id], {
    type: 'general',
    title: 'One-time device check-in rejected',
    body: 'Your one-time device exception request was rejected.',
    actionUrl: '/device-exception',
  });

  return toDto(exception);
}

module.exports = {
  createDeviceException,
  listDeviceExceptions,
  listOwnDeviceExceptions,
  approveDeviceException,
  rejectDeviceException,
};
