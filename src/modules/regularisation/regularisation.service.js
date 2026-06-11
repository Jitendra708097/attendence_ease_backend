const crypto = require('crypto');
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
const { uploadRegularisationEvidence } = require('./regularisation.storageService');
const { assertValidDateString, buildCorrectedAttendanceTimes, normalizeRequestedLocalTime } = require('./regularisation.time');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const REGULARISATION_STATUSES = ['pending', 'manager_approved', 'approved', 'rejected'];
const ATTENDANCE_RESTORE_ATTRIBUTES = [ 'id', 'date', 'shift_id', 'first_check_in', 'last_check_out', 'total_worked_minutes', 'status' ];

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

function parseEvidenceImage(body = {}) {
  const rawBase64 = body.evidenceBase64 || body.evidence_base64 || body.evidenceImageBase64;

  if (!rawBase64) {
    return null;
  }

  const value = String(rawBase64).trim();
  const dataUrlMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  const mimeType = String(
    body.evidenceMimeType ||
    body.evidence_mime_type ||
    (dataUrlMatch ? dataUrlMatch[1] : 'image/jpeg')
  ).toLowerCase();
  const base64 = dataUrlMatch ? dataUrlMatch[2] : value;

  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw createError('REG_012', 'Regularisation evidence must be a JPG, PNG, or WebP image', 422, [
      { field: 'evidenceBase64', message: 'Unsupported evidence image type' },
    ]);
  }

  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
    throw createError('REG_013', 'Regularisation evidence image is invalid', 422, [
      { field: 'evidenceBase64', message: 'Invalid base64 image data' },
    ]);
  }

  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
    throw createError('REG_014', 'Regularisation evidence image must be less than 4 MB', 422, [
      { field: 'evidenceBase64', message: 'Upload a smaller evidence image' },
    ]);
  }

  return { buffer, mimeType };
}

function normalizeNote(value) {
  const note = String(value || '').trim();
  return note || null;
}

function parsePagination(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 50, 1), 100);
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function getPaginationMeta(count, page, limit) {
  return {
    page,
    limit,
    count,
    total: count,
    totalPages: Math.max(Math.ceil(count / limit), 1),
  };
}

function normalizeStatusFilter(statusFilter) {
  const status = String(statusFilter || '').trim();
  return REGULARISATION_STATUSES.includes(status) ? status : null;
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
    managerNotes: record.manager_notes,
    finalApprovedBy: record.final_approved_by,
    finalApprovedAt: record.final_approved_at,
    finalNotes: record.final_notes,
    approvalNotes: [record.manager_notes, record.final_notes].filter(Boolean).join('\n\n') || null,
    rejectionReason: record.rejection_reason,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

async function createRegularisation({ orgId, empId, body }) {
  const date = String(body.date || '').trim();
  const reason = String(body.reason || '').trim();

  if (!date || !reason || !assertValidDateString(date)) {
    throw createError('REG_001', 'Date and reason are required', 422, [
      { field: 'date', message: 'Use YYYY-MM-DD date format' },
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

  if (['on_leave', 'holiday', 'weekend'].includes(attendance.status)) {
    throw createError('REG_006', 'This attendance status cannot be regularised', 400);
  }

  const [shift, organisation] = await Promise.all([
    Shift.findOne({ where: { id: attendance.shift_id, org_id: orgId } }),
    Organisation.findOne({ where: { id: orgId }, attributes: ['timezone'] }),
  ]);

  if (!shift) {
    throw createError('HTTP_404', 'Shift configuration not found', 404);
  }

  const timezone = organisation?.timezone || DEFAULT_TIMEZONE;

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

  const requestedCheckInInput = body.requestedCheckIn ?? body.requested_check_in;
  const requestedCheckOutInput = body.requestedCheckOut ?? body.requested_check_out;
  const hasRequestedCheckIn = requestedCheckInInput !== undefined && requestedCheckInInput !== null && String(requestedCheckInInput).trim() !== '';
  const hasRequestedCheckOut = requestedCheckOutInput !== undefined && requestedCheckOutInput !== null && String(requestedCheckOutInput).trim() !== '';
  const requestedCheckIn = hasRequestedCheckIn
    ? normalizeRequestedLocalTime({
        date,
        value: requestedCheckInInput,
        timezone,
        field: 'checkin',
        shift,
      })
    : null;
  const requestedCheckOut = hasRequestedCheckOut
    ? normalizeRequestedLocalTime({
        date,
        value: requestedCheckOutInput,
        timezone,
        field: 'checkout',
        shift,
      })
    : null;

  if (hasRequestedCheckIn && !requestedCheckIn) {
    throw createError('REG_003', 'Invalid requested check-in time', 422, [
      { field: 'requestedCheckIn', message: 'Use HH:MM or HH:MM:SS format' },
    ]);
  }

  if (hasRequestedCheckOut && !requestedCheckOut) {
    throw createError('REG_004', 'Invalid requested check-out time', 422, [
      { field: 'requestedCheckOut', message: 'Use HH:MM or HH:MM:SS format' },
    ]);
  }

  if (!requestedCheckIn && !requestedCheckOut) {
    throw createError('REG_005', 'Provide at least one requested correction time', 422);
  }

  buildCorrectedAttendanceTimes({ attendance, requestedCheckIn, requestedCheckOut });

  const evidenceImage = parseEvidenceImage(body);
  const recordId = crypto.randomUUID();
  const uploadedEvidence = evidenceImage
    ? await uploadRegularisationEvidence(evidenceImage.buffer, orgId, empId, recordId)
    : null;
  const evidenceUrl = uploadedEvidence
    ? uploadedEvidence.secureUrl
    : typeof body.evidenceUrl === 'string' && /^https?:\/\//i.test(body.evidenceUrl)
      ? body.evidenceUrl.trim()
      : null;

  const record = await Regularisation.create({
    id: recordId,
    org_id: orgId,
    emp_id: empId,
    attendance_id: attendance.id,
    date,
    requested_check_in: requestedCheckIn,
    requested_check_out: requestedCheckOut,
    reason,
    evidence_type: evidenceImage ? 'photo' : normalizeEvidenceType(body.evidenceType || body.evidence_type),
    evidence_url: evidenceUrl,
  });

  await attendance.update({
    status: 'regularisation_pending',
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
        attributes: ['id', 'date', 'first_check_in', 'last_check_out', 'total_worked_minutes', 'shift_id', 'status'],
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
      data: { regularisation_id: hydrated.id, attendance_id: hydrated.attendance_id },
    },
    {
      excludeEmployeeIds: [empId],
    }
  );

  return toDto(hydrated);
}

async function listPendingRegularisations({ orgId, role, employeeId, query = {} }) {
  const statusFilter = String(query.status || '').trim();
  const requestId = query.requestId || query.regularisationId || query.id;
  const where = {
    org_id: orgId,
  };

  if (requestId) {
    where.id = requestId;
  } else if (statusFilter) {
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
        attributes: ATTENDANCE_RESTORE_ATTRIBUTES,
      },
    ],
    order: [['created_at', 'DESC']],
  });

  return {
    regularisations: rows.map(toDto),
    total: rows.length,
  };
}

async function listRegularisations({ orgId, query = {} }) {
  const statusFilter = normalizeStatusFilter(query.status);
  const requestId = query.requestId || query.regularisationId || query.id;
  const pagination = parsePagination(query);
  const page = requestId ? 1 : pagination.page;
  const limit = pagination.limit;
  const offset = requestId ? 0 : pagination.offset;
  const where = {
    org_id: orgId,
  };

  if (requestId) {
    where.id = requestId;
  } else if (statusFilter) {
    where.status = statusFilter;
  }

  const { rows, count } = await Regularisation.findAndCountAll({
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
        attributes: ATTENDANCE_RESTORE_ATTRIBUTES,
      },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return {
    regularisations: rows.map(toDto),
    total: count,
    page,
    limit,
    totalPages: Math.max(Math.ceil(count / limit), 1),
    pagination: getPaginationMeta(count, page, limit),
  };
}

async function listMyRegularisations({ orgId, employeeId, query = {} }) {
  const statusFilter = normalizeStatusFilter(query.status);
  const requestId = query.requestId || query.regularisationId || query.id;
  const pagination = parsePagination(query);
  const page = requestId ? 1 : pagination.page;
  const limit = pagination.limit;
  const offset = requestId ? 0 : pagination.offset;
  const where = {
    org_id: orgId,
    emp_id: employeeId,
  };

  if (requestId) {
    where.id = requestId;
  } else if (statusFilter) {
    where.status = statusFilter;
  }

  const { rows, count } = await Regularisation.findAndCountAll({
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
        attributes: ATTENDANCE_RESTORE_ATTRIBUTES,
      },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return {
    regularisations: rows.map(toDto),
    total: count,
    page,
    limit,
    totalPages: Math.max(Math.ceil(count / limit), 1),
    pagination: getPaginationMeta(count, page, limit),
  };
}

async function notifyAdminsForApproval(orgId, excludeEmployeeId, employeeName, date, regularisationId) {
  await notifyOrgRoles(
    orgId,
    ['admin'],
    {
      type: 'general',
      title: 'Regularisation awaiting approval',
      body: `${employeeName || 'An employee'} regularisation for ${date} is ready for final review.`,
      actionUrl: '/regularisations',
      data: { regularisation_id: regularisationId },
    },
    {
      excludeEmployeeIds: [excludeEmployeeId],
    }
  );
}

async function managerApproveRegularisation({ orgId, regularisationId, approverId, notes = null }) {
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
    manager_notes: normalizeNote(notes) || record.manager_notes,
  });

  await notifyAdminsForApproval(orgId, record.emp_id, record.employee && record.employee.name, record.date, record.id);

  return toDto(record);
}

async function approveRegularisation({ orgId, regularisationId, approverId, notes = null }) {
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

  const { nextCheckIn, nextCheckOut, totalWorkedMinutes } = buildCorrectedAttendanceTimes({
    attendance,
    requestedCheckIn: record.requested_check_in,
    requestedCheckOut: record.requested_check_out,
  });

  const statusState = computeAttendanceStatus(
    {
      date: attendance.date,
      first_check_in: nextCheckIn,
      last_check_out: nextCheckOut,
      total_worked_minutes: totalWorkedMinutes,
    },
    shift,
    null,
    organisation?.timezone || DEFAULT_TIMEZONE
  );

  await attendance.update({
    first_check_in: nextCheckIn,
    last_check_out: nextCheckOut,
    total_worked_minutes: totalWorkedMinutes,
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
    final_notes: normalizeNote(notes) || record.final_notes,
    rejection_reason: null,
  });

  await sendPush(
    [record.emp_id],
    {
      type: 'regularisation_approved',
      title: 'Regularisation approved',
      body: `Your regularisation request for ${record.date} has been approved.`,
      actionUrl: `attendease://regularise/${record.id}`,
      data: { regularisation_id: record.id, attendance_id: record.attendance_id },
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
        attributes: ATTENDANCE_RESTORE_ATTRIBUTES,
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

  if (record.attendance && record.attendance.status === 'regularisation_pending') {
    const [shift, organisation] = await Promise.all([
      Shift.findOne({ where: { id: record.attendance.shift_id, org_id: orgId } }),
      Organisation.findOne({ where: { id: orgId }, attributes: ['timezone'] }),
    ]);
    const statusState = shift
      ? computeAttendanceStatus(
          {
            date: record.attendance.date,
            first_check_in: record.attendance.first_check_in,
            last_check_out: record.attendance.last_check_out,
            total_worked_minutes: record.attendance.total_worked_minutes || 0,
          },
          shift,
          null,
          organisation?.timezone || DEFAULT_TIMEZONE
        )
      : null;
    const restorePatch = statusState
      ? {
          status: statusState.status,
          is_late: statusState.isLate,
          late_by_minutes: statusState.lateByMinutes || 0,
          is_overtime: statusState.isOvertime,
          overtime_minutes: statusState.overtimeMinutes,
          is_early_checkout: statusState.isEarlyCheckout,
          early_by_minutes: statusState.earlyByMinutes || 0,
          check_out_type: statusState.checkOutType,
        }
      : {
          status: record.attendance.last_check_out ? 'incomplete' : 'pending',
        };

    await record.attendance.update(restorePatch);
  }

  await sendPush(
    [record.emp_id],
    {
      type: 'regularisation_rejected',
      title: 'Regularisation rejected',
      body: rejectionReason
        ? `Your regularisation request for ${record.date} was rejected: ${rejectionReason}`
        : `Your regularisation request for ${record.date} was rejected.`,
      actionUrl: `attendease://regularise/${record.id}`,
      data: { regularisation_id: record.id, attendance_id: record.attendance_id },
    }
  );

  return toDto(record);
}

module.exports = {
  createRegularisation,
  listRegularisations,
  listPendingRegularisations,
  listMyRegularisations,
  managerApproveRegularisation,
  approveRegularisation,
  rejectRegularisation,
};
