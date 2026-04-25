const { Op } = require('sequelize');
const {
  Attendance,
  Employee,
  Organisation,
  Regularisation,
  Shift,
} = require('../../models');
const { computeAttendanceStatus } = require('../attendance/attendance.statusEngine');
const { notifyOrgRoles, sendPush } = require('../notification/notification.service');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeEvidenceType(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (['email', 'photo', 'document', 'other'].includes(normalized)) {
    return normalized;
  }

  return 'other';
}

function normalizeRequestedDateTime(date, timeOrDateTime) {
  if (!timeOrDateTime) {
    return null;
  }

  if (timeOrDateTime instanceof Date) {
    return timeOrDateTime;
  }

  const value = String(timeOrDateTime).trim();

  if (!value) {
    return null;
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return new Date(`${date}T${value}:00.000Z`);
  }

  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${date}T${value}.000Z`);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function diffMinutes(start, end) {
  if (!start || !end) {
    return 0;
  }

  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function toDto(record) {
  const employeeName = record.employee ? record.employee.name : null;
  const attendance = record.attendance || null;
  const currentLevel = record.status === 'pending' ? 'manager_review' : record.status === 'manager_approved' ? 'admin_review' : 'completed';

  return {
    id: record.id,
    orgId: record.org_id,
    empId: record.emp_id,
    attendanceId: record.attendance_id,
    employeeName,
    date: record.date,
    reason: record.reason,
    evidenceType: record.evidence_type,
    evidenceUrl: record.evidence_url,
    requestedCheckIn: record.requested_check_in,
    requestedCheckOut: record.requested_check_out,
    originalCheckIn: attendance ? attendance.first_check_in : null,
    originalCheckOut: attendance ? attendance.last_check_out : null,
    status: record.status,
    level: currentLevel,
    managerApprovedBy: record.manager_approved_by,
    managerApprovedAt: record.manager_approved_at,
    finalApprovedBy: record.final_approved_by,
    finalApprovedAt: record.final_approved_at,
    rejectionReason: record.rejection_reason,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

async function createRegularisation({ orgId, empId, body }) {
  const date = String(body.date || '').trim();
  const reason = String(body.reason || '').trim();

  if (!date || !reason) {
    throw createError('REG_001', 'Date and reason are required', 422, [
      { field: 'date', message: 'Date is required' },
      { field: 'reason', message: 'Reason is required' },
    ]);
  }

  const attendance = await Attendance.findOne({
    where: {
      org_id: orgId,
      emp_id: empId,
      date,
    },
  });

  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for the selected date', 404);
  }

  const existing = await Regularisation.findOne({
    where: {
      org_id: orgId,
      emp_id: empId,
      attendance_id: attendance.id,
      status: {
        [Op.in]: ['pending', 'manager_approved'],
      },
    },
  });

  if (existing) {
    throw createError('REG_002', 'A regularisation request is already pending for this attendance', 409);
  }

  const requestedCheckIn = normalizeRequestedDateTime(date, body.requestedCheckIn || body.requested_check_in);
  const requestedCheckOut = normalizeRequestedDateTime(date, body.requestedCheckOut || body.requested_check_out);

  if ((body.requestedCheckIn || body.requested_check_in) && !requestedCheckIn) {
    throw createError('REG_003', 'Invalid requested check-in time', 422, [
      { field: 'requestedCheckIn', message: 'Use HH:MM or ISO datetime format' },
    ]);
  }

  if ((body.requestedCheckOut || body.requested_check_out) && !requestedCheckOut) {
    throw createError('REG_004', 'Invalid requested check-out time', 422, [
      { field: 'requestedCheckOut', message: 'Use HH:MM or ISO datetime format' },
    ]);
  }

  if (!requestedCheckIn && !requestedCheckOut) {
    throw createError('REG_005', 'Provide at least one requested correction time', 422);
  }

  const evidenceUrl = typeof body.evidenceUrl === 'string' && /^https?:\/\//i.test(body.evidenceUrl)
    ? body.evidenceUrl.trim()
    : null;

  const record = await Regularisation.create({
    org_id: orgId,
    emp_id: empId,
    attendance_id: attendance.id,
    date,
    requested_check_in: requestedCheckIn,
    requested_check_out: requestedCheckOut,
    reason,
    evidence_type: normalizeEvidenceType(body.evidenceType || body.evidence_type),
    evidence_url: evidenceUrl,
  });

  const hydrated = await Regularisation.findOne({
    where: {
      id: record.id,
      org_id: orgId,
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
      {
        model: Attendance,
        as: 'attendance',
        attributes: ['id', 'first_check_in', 'last_check_out'],
      },
    ],
  });

  await notifyOrgRoles(
    orgId,
    ['admin'],
    {
      type: 'regularisation_submitted',
      title: 'New regularisation request',
      body: `${hydrated.employee ? hydrated.employee.name : 'An employee'} submitted a regularisation request for ${date}.`,
      actionUrl: '/regularisations',
    },
    {
      excludeEmployeeIds: [empId],
    }
  );

  return toDto(hydrated);
}

async function listPendingRegularisations({ orgId, role, employeeId, query = {} }) {
  const statusFilter = String(query.status || '').trim();
  const where = {
    org_id: orgId,
  };

  if (statusFilter) {
    where.status = statusFilter;
  } else if (role === 'manager') {
    where.status = 'pending';
  } else {
    where.status = {
      [Op.in]: ['pending', 'manager_approved'],
    };
  }

  if (role === 'employee') {
    where.emp_id = employeeId;
  }

  const rows = await Regularisation.findAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name', 'role'],
      },
      {
        model: Attendance,
        as: 'attendance',
        attributes: ['id', 'first_check_in', 'last_check_out', 'status'],
      },
    ],
    order: [['created_at', 'DESC']],
  });

  return {
    regularisations: rows.map(toDto),
    total: rows.length,
  };
}

async function notifyAdminsForApproval(orgId, excludeEmployeeId, employeeName, date) {
  await notifyOrgRoles(
    orgId,
    ['admin'],
    {
      type: 'general',
      title: 'Regularisation awaiting approval',
      body: `${employeeName || 'An employee'} regularisation for ${date} is ready for final review.`,
      actionUrl: '/regularisations',
    },
    {
      excludeEmployeeIds: [excludeEmployeeId],
    }
  );
}

async function managerApproveRegularisation({ orgId, regularisationId, approverId }) {
  const record = await Regularisation.findOne({
    where: {
      id: regularisationId,
      org_id: orgId,
      status: 'pending',
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
      {
        model: Attendance,
        as: 'attendance',
        attributes: ['id', 'first_check_in', 'last_check_out'],
      },
    ],
  });

  if (!record) {
    throw createError('HTTP_404', 'Regularisation request not found', 404);
  }

  await record.update({
    status: 'manager_approved',
    manager_approved_by: approverId,
    manager_approved_at: new Date(),
  });

  await notifyAdminsForApproval(orgId, record.emp_id, record.employee && record.employee.name, record.date);

  return toDto(record);
}

async function approveRegularisation({ orgId, regularisationId, approverId }) {
  const record = await Regularisation.findOne({
    where: {
      id: regularisationId,
      org_id: orgId,
      status: {
        [Op.in]: ['pending', 'manager_approved'],
      },
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
      {
        model: Attendance,
        as: 'attendance',
      },
    ],
  });

  if (!record) {
    throw createError('HTTP_404', 'Regularisation request not found', 404);
  }

  const attendance = record.attendance;

  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for this regularisation', 404);
  }

  const shift = await Shift.findOne({
    where: {
      id: attendance.shift_id,
      org_id: orgId,
    },
  });

  if (!shift) {
    throw createError('HTTP_404', 'Shift configuration not found', 404);
  }

  const organisation = await Organisation.findOne({
    where: {
      id: orgId,
    },
    attributes: ['timezone'],
  });

  const nextCheckIn = record.requested_check_in || attendance.first_check_in;
  const nextCheckOut = record.requested_check_out || attendance.last_check_out;
  const totalWorkedMinutes = diffMinutes(
    nextCheckIn ? new Date(nextCheckIn) : null,
    nextCheckOut ? new Date(nextCheckOut) : null
  );

  const statusState = computeAttendanceStatus(
    {
      date: attendance.date,
      first_check_in: nextCheckIn,
      last_check_out: nextCheckOut,
      total_worked_minutes: totalWorkedMinutes || attendance.total_worked_minutes || 0,
    },
    shift,
    null,
    organisation.timezone || 'UTC'
  );

  await attendance.update({
    first_check_in: nextCheckIn,
    last_check_out: nextCheckOut,
    total_worked_minutes: totalWorkedMinutes || attendance.total_worked_minutes || 0,
    status: statusState.status,
    is_late: statusState.isLate,
    late_by_minutes: statusState.lateByMinutes || 0,
    is_overtime: statusState.isOvertime,
    overtime_minutes: statusState.overtimeMinutes,
    is_early_checkout: statusState.isEarlyCheckout,
    early_by_minutes: statusState.earlyByMinutes || 0,
    check_out_type: statusState.checkOutType,
    is_manual: true,
    is_finalised: Boolean(nextCheckOut),
    marked_by: approverId,
    source: 'regularisation',
  });

  await record.update({
    status: 'approved',
    final_approved_by: approverId,
    final_approved_at: new Date(),
    rejection_reason: null,
  });

  await sendPush(
    [record.emp_id],
    {
      type: 'regularisation_approved',
      title: 'Regularisation approved',
      body: `Your regularisation request for ${record.date} has been approved.`,
      actionUrl: '/history',
    }
  );

  return toDto(record);
}

async function rejectRegularisation({ orgId, regularisationId, approverId, rejectionReason }) {
  const record = await Regularisation.findOne({
    where: {
      id: regularisationId,
      org_id: orgId,
      status: {
        [Op.in]: ['pending', 'manager_approved'],
      },
    },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name'],
      },
      {
        model: Attendance,
        as: 'attendance',
        attributes: ['id', 'first_check_in', 'last_check_out'],
      },
    ],
  });

  if (!record) {
    throw createError('HTTP_404', 'Regularisation request not found', 404);
  }

  await record.update({
    status: 'rejected',
    final_approved_by: approverId,
    final_approved_at: new Date(),
    rejection_reason: rejectionReason || null,
  });

  await sendPush(
    [record.emp_id],
    {
      type: 'regularisation_rejected',
      title: 'Regularisation rejected',
      body: rejectionReason
        ? `Your regularisation request for ${record.date} was rejected: ${rejectionReason}`
        : `Your regularisation request for ${record.date} was rejected.`,
      actionUrl: '/history',
    }
  );

  return toDto(record);
}

module.exports = {
  createRegularisation,
  listPendingRegularisations,
  managerApproveRegularisation,
  approveRegularisation,
  rejectRegularisation,
};
