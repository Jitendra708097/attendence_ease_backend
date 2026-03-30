const { Op } = require('sequelize');
const { Attendance, AttendanceSession, Branch, DeviceException, Employee, Shift } = require('../../models');
const { redisClient } = require('../../config/redis');
const { checkoutGrace } = require('../../queues');
const { log } = require('../../utils/auditLog');
const { createChallenge, consumeChallenge } = require('./attendance.challengeService');
const { computeAttendanceStatus } = require('./attendance.statusEngine');
const { checkGeofence } = require('../geofence/geofence.service');
const faceService = require('../face/face.service');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getCooldownKey(orgId, empId) {
  return `attendance_cooldown:${orgId}:${empId}`;
}

function getUndoKey(orgId, empId, sessionId) {
  return `attendance_undo:${orgId}:${empId}:${sessionId}`;
}

async function getEmployeeContext(orgId, empId) {
  const employee = await Employee.findOne({
    where: { id: empId, org_id: orgId, is_active: true },
  });

  if (!employee) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  const shift = await Shift.findOne({
    where: { id: employee.shift_id, org_id: orgId },
  });
  const branch = await Branch.findOne({
    where: { id: employee.branch_id, org_id: orgId },
  });

  if (!shift || !branch) {
    throw createError('ATT_001', 'Employee attendance configuration is incomplete', 400);
  }

  return { employee, shift, branch };
}

async function getTodayAttendance(orgId, empId) {
  return Attendance.findOne({
    where: { org_id: orgId, emp_id: empId, date: getTodayDateString() },
  });
}

async function getAttendanceSessions(attendanceId) {
  return AttendanceSession.findAll({
    where: { attendance_id: attendanceId },
    order: [['session_number', 'ASC']],
  });
}

async function getOpenSession(attendanceId) {
  return AttendanceSession.findOne({
    where: { attendance_id: attendanceId, status: 'open' },
    order: [['session_number', 'DESC']],
  });
}

async function validateChallenge({ orgId, empId, challengeToken, captureTimestamp }) {
  const payload = await consumeChallenge(challengeToken);

  if (!payload) {
    throw createError('ATT_008', 'Challenge token is invalid or expired', 400);
  }

  if (payload.orgId !== orgId || payload.empId !== empId) {
    throw createError('ATT_009', 'Challenge token does not belong to this employee', 400);
  }

  const captureTime = Number(captureTimestamp);
  if (!Number.isFinite(captureTime) || Math.abs(Date.now() - captureTime) > 35 * 1000) {
    throw createError('ATT_011', 'Capture timestamp is outside the allowed window', 400);
  }
}

async function validateDevice({ orgId, employee, deviceId, useDeviceException, exceptionId }) {
  if (employee.registered_device_id && employee.registered_device_id === deviceId) {
    return;
  }

  if (!employee.registered_device_id && deviceId) {
    await employee.update({ registered_device_id: deviceId });
    return;
  }

  if (useDeviceException && exceptionId) {
    const exception = await DeviceException.findOne({
      where: {
        id: exceptionId,
        org_id: orgId,
        emp_id: employee.id,
        status: 'approved',
        expires_at: { [Op.gt]: new Date() },
      },
    });

    if (!exception) {
      throw createError('AUTH_009', 'Device exception is invalid or expired', 401);
    }

    await exception.update({ status: 'used' });
    return;
  }

  throw createError('AUTH_009', 'This device is not registered for the employee', 401);
}

function validateGpsPayload(body) {
  if (body.isMocked) {
    throw createError('GEO_001', 'Mock location detected', 400);
  }
  if (Number(body.accuracy) > 100) {
    throw createError('GEO_002', 'GPS accuracy is too weak', 400);
  }
  if (body.speed != null && Number(body.speed) > 83.33) {
    throw createError('GEO_004', 'GPS speed is not plausible', 400);
  }
  if (body.altitude != null && Number(body.altitude) < -100) {
    throw createError('GEO_004', 'GPS altitude is invalid', 400);
  }
}

function buildShiftInfo(shift) {
  return {
    id: shift.id,
    name: shift.name,
    startTime: shift.start_time,
    endTime: shift.end_time,
  };
}

async function getTodayState(orgId, empId) {
  const { shift } = await getEmployeeContext(orgId, empId);
  const attendance = await getTodayAttendance(orgId, empId);
  const cooldownEndsAt = await redisClient.get(getCooldownKey(orgId, empId));

  if (!attendance) {
    return {
      openSession: null,
      cooldownEndsAt: cooldownEndsAt || null,
      lastCheckout: null,
      lastCheckoutId: null,
      todayStatus: 'not_marked',
      totalWorkedMins: 0,
      sessionsToday: 0,
      firstCheckInTime: null,
      shiftInfo: buildShiftInfo(shift),
    };
  }

  const openSession = await getOpenSession(attendance.id);
  const sessions = await getAttendanceSessions(attendance.id);
  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const undoKey = lastSession ? getUndoKey(orgId, empId, lastSession.id) : null;
  const undoAvailable = undoKey ? await redisClient.get(undoKey) : null;

  return {
    openSession: openSession ? { id: openSession.id, checkInTime: openSession.check_in_time, status: openSession.status } : null,
    cooldownEndsAt: cooldownEndsAt || null,
    lastCheckout: undoAvailable ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
    lastCheckoutId: undoAvailable && lastSession ? lastSession.id : null,
    todayStatus: attendance.status,
    totalWorkedMins: attendance.total_worked_minutes || 0,
    sessionsToday: attendance.session_count || 0,
    firstCheckInTime: attendance.first_check_in || null,
    shiftInfo: buildShiftInfo(shift),
  };
}

async function requestChallenge(orgId, empId) {
  await getEmployeeContext(orgId, empId);
  return createChallenge({ orgId, empId });
}

async function checkIn({ orgId, empId, body, req }) {
  await validateChallenge({ orgId, empId, challengeToken: body.challengeToken, captureTimestamp: body.captureTimestamp });

  const { employee, shift, branch } = await getEmployeeContext(orgId, empId);
  await validateDevice({ orgId, employee, deviceId: body.deviceId, useDeviceException: body.useDeviceException, exceptionId: body.exceptionId });
  validateGpsPayload(body);

  if (!branch.is_remote && Array.isArray(branch.geo_fence_polygons) && branch.geo_fence_polygons.length >= 3) {
    const isInside = checkGeofence({ lat: Number(body.lat), lng: Number(body.lng) }, branch);
    if (!isInside) {
      throw createError('GEO_003', 'Employee is outside the branch geofence', 400);
    }
  }

  await faceService.verifyFace(empId, orgId, body.faceEmbedding || null, faceService.decodeSelfie(body.selfieBase64));

  const todayAttendance = await getTodayAttendance(orgId, empId);
  if (todayAttendance) {
    const openSession = await getOpenSession(todayAttendance.id);
    if (openSession) {
      throw createError('ATT_003', 'An attendance session is already open', 400);
    }

    if (Number(todayAttendance.session_count || 0) >= Number(shift.max_sessions_per_day || 3)) {
      throw createError('ATT_004', 'Maximum sessions reached for today', 400);
    }

    const cooldownEndsAt = await redisClient.get(getCooldownKey(orgId, empId));
    if (cooldownEndsAt && new Date(cooldownEndsAt) > new Date()) {
      throw createError('ATT_004', 'Employee is in cooldown period', 400);
    }
  }

  const attendance = todayAttendance || (await Attendance.create({
    org_id: orgId,
    emp_id: empId,
    date: getTodayDateString(),
    shift_id: employee.shift_id,
    status: 'absent',
    first_check_in: new Date(),
    session_count: 0,
    total_worked_minutes: 0,
    is_anomaly: Number(body.accuracy) > 50,
  }));

  const nextSessionNumber = Number(attendance.session_count || 0) + 1;
  const session = await AttendanceSession.create({
    attendance_id: attendance.id,
    org_id: orgId,
    session_number: nextSessionNumber,
    check_in_time: new Date(),
    status: 'open',
    worked_minutes: 0,
  });

  await attendance.update({
    session_count: nextSessionNumber,
    first_check_in: attendance.first_check_in || session.check_in_time,
    is_anomaly: attendance.is_anomaly || Number(body.accuracy) > 50,
  });

  await redisClient.del(getCooldownKey(orgId, empId));
  await log(req.employee, 'attendance.check_in', { type: 'attendance_session', id: session.id }, null, { attendanceId: attendance.id }, req);

  return {
    session: { id: session.id, checkInTime: session.check_in_time, status: session.status },
    attendanceStatus: attendance.status,
    buttonState: 'CHECKED_IN',
  };
}

async function checkOut({ orgId, empId, body, req }) {
  const { shift } = await getEmployeeContext(orgId, empId);
  const attendance = await getTodayAttendance(orgId, empId);
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for today', 404);
  }

  const session = await getOpenSession(attendance.id);
  if (!session) {
    throw createError('ATT_005', 'No open attendance session found', 400);
  }

  const now = new Date();
  const workedMinutes = Math.max(0, Math.round((now.getTime() - new Date(session.check_in_time).getTime()) / 60000));
  await session.update({ check_out_time: now, worked_minutes: workedMinutes, status: 'completed' });

  const sessions = await getAttendanceSessions(attendance.id);
  const totalWorkedMinutes = sessions.reduce((sum, item) => sum + Number(item.worked_minutes || 0), 0);
  const computed = computeAttendanceStatus({
    date: attendance.date,
    first_check_in: attendance.first_check_in,
    total_worked_minutes: totalWorkedMinutes,
  }, shift, null);

  await attendance.update({
    last_check_out: now,
    total_worked_minutes: totalWorkedMinutes,
    status: computed.status,
    is_late: computed.isLate,
    is_overtime: computed.isOvertime,
    is_finalised: Boolean(body.isFinalCheckout),
  });

  const cooldownEndsAt = new Date(now.getTime() + Number(shift.session_cooldown_minutes || 15) * 60 * 1000);
  await redisClient.set(getCooldownKey(orgId, empId), cooldownEndsAt.toISOString(), 'EX', Number(shift.session_cooldown_minutes || 15) * 60);

  const undoKey = getUndoKey(orgId, empId, session.id);
  await redisClient.set(undoKey, '1', 'EX', 10 * 60);

  await checkoutGrace.add('checkout_grace_expiry', {
    orgId,
    empId,
    attendanceId: attendance.id,
    sessionId: session.id,
  }, {
    jobId: `checkout_grace_${session.id}`,
    delay: 10 * 60 * 1000,
    removeOnComplete: true,
  });

  await log(req.employee, 'attendance.check_out', { type: 'attendance_session', id: session.id }, null, { workedMinutes }, req);

  return {
    session: {
      id: session.id,
      checkInTime: session.check_in_time,
      checkOutTime: session.check_out_time,
      status: session.status,
      workedMinutes,
    },
    totalWorkedMins: totalWorkedMinutes,
    cooldownEndsAt: body.isFinalCheckout ? null : cooldownEndsAt.toISOString(),
  };
}

async function undoCheckout({ orgId, empId, req }) {
  const attendance = await getTodayAttendance(orgId, empId);
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for today', 404);
  }

  const sessions = await getAttendanceSessions(attendance.id);
  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  if (!lastSession || !lastSession.check_out_time) {
    throw createError('ATT_006', 'No checkout available to undo', 400);
  }

  const undoKey = getUndoKey(orgId, empId, lastSession.id);
  const isUndoAvailable = await redisClient.get(undoKey);
  if (!isUndoAvailable) {
    throw createError('ATT_007', 'Undo window has expired', 400);
  }

  await lastSession.update({ check_out_time: null, worked_minutes: 0, status: 'open' });

  const completedSessions = sessions.filter((item) => item.id !== lastSession.id);
  const totalWorkedMinutes = completedSessions.reduce((sum, item) => sum + Number(item.worked_minutes || 0), 0);
  await attendance.update({ last_check_out: null, total_worked_minutes: totalWorkedMinutes, is_finalised: false });

  await redisClient.del(undoKey, getCooldownKey(orgId, empId));
  const undoJob = await checkoutGrace.getJob(`checkout_grace_${lastSession.id}`);
  if (undoJob) {
    await undoJob.remove().catch(() => {});
  }

  await log(req.employee, 'attendance.undo_checkout', { type: 'attendance_session', id: lastSession.id }, null, null, req);
  return { session: { id: lastSession.id, checkInTime: lastSession.check_in_time, status: 'open' } };
}

async function listAttendance(orgId, query) {
  const where = { org_id: orgId };
  if (query.date) where.date = query.date;
  if (query.status) where.status = query.status;

  const rows = await Attendance.findAll({
    where,
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'first_name', 'last_name', 'email'] }],
    order: [['date', 'DESC'], ['created_at', 'DESC']],
    limit: Math.min(Number(query.limit || 20), 100),
  });

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    status: row.status,
    totalWorkedMins: row.total_worked_minutes || 0,
    sessionsToday: row.session_count || 0,
    employee: row.employee ? {
      id: row.employee.id,
      name: `${row.employee.first_name || ''} ${row.employee.last_name || ''}`.trim(),
      email: row.employee.email,
    } : null,
  }));
}

async function getAttendanceHistory(orgId, empId, query) {
  const where = {
    org_id: orgId,
    emp_id: empId,
  };

  if (query.month) {
    const [year, month] = String(query.month).split('-');
    const monthNumber = Number(month);
    const monthStart = new Date(Date.UTC(Number(year), monthNumber - 1, 1));
    const monthEnd = new Date(Date.UTC(Number(year), monthNumber, 0));
    where.date = {
      [Op.between]: [
        monthStart.toISOString().slice(0, 10),
        monthEnd.toISOString().slice(0, 10),
      ],
    };
  }

  const rows = await Attendance.findAll({
    where,
    order: [['date', 'DESC']],
    limit: Math.min(Number(query.limit || 31), 100),
  });

  const records = rows.map((row) => ({
    id: row.id,
    date: row.date,
    status: row.status,
    totalWorkedMins: row.total_worked_minutes || 0,
    sessionsToday: row.session_count || 0,
    firstCheckIn: row.first_check_in,
    lastCheckOut: row.last_check_out,
    isLate: Boolean(row.is_late),
  }));

  const attendanceMap = records.reduce((accumulator, record) => {
    accumulator[record.date] = record.status;
    return accumulator;
  }, {});

  const summary = records.reduce(
    (accumulator, record) => {
      if (record.status === 'present') accumulator.present += 1;
      if (record.status === 'absent') accumulator.absent += 1;
      if (record.status === 'on_leave') accumulator.onLeave += 1;
      if (record.isLate) accumulator.late += 1;
      return accumulator;
    },
    { present: 0, absent: 0, late: 0, onLeave: 0 }
  );

  return {
    records,
    attendanceMap,
    summary,
  };
}

async function getAttendanceById(orgId, id) {
  const attendance = await Attendance.findOne({ where: { id, org_id: orgId } });
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found', 404);
  }

  const sessions = await getAttendanceSessions(attendance.id);
  return {
    id: attendance.id,
    date: attendance.date,
    status: attendance.status,
    totalWorkedMins: attendance.total_worked_minutes || 0,
    sessionsToday: attendance.session_count || 0,
    firstCheckInTime: attendance.first_check_in,
    lastCheckOutTime: attendance.last_check_out,
    sessions: sessions.map((session) => ({
      id: session.id,
      sessionNumber: session.session_number,
      checkInTime: session.check_in_time,
      checkOutTime: session.check_out_time,
      workedMinutes: session.worked_minutes || 0,
      status: session.status,
    })),
  };
}

async function manualMark({ orgId, id, body, req }) {
  const attendance = await Attendance.findOne({ where: { id, org_id: orgId } });
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found', 404);
  }

  const previous = attendance.toJSON();
  await attendance.update({
    status: body.status || attendance.status,
    is_manual: true,
    marked_by: req.employee.id,
    total_worked_minutes: Number(body.totalWorkedMins ?? attendance.total_worked_minutes ?? 0),
  });

  await log(req.employee, 'attendance.manual_mark', { type: 'attendance', id: attendance.id }, previous, attendance.toJSON(), req);
  return getAttendanceById(orgId, attendance.id);
}

module.exports = {
  requestChallenge,
  checkIn,
  checkOut,
  undoCheckout,
  getTodayState,
  listAttendance,
  getAttendanceHistory,
  getAttendanceById,
  manualMark,
};
