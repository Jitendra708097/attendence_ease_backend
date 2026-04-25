const { Op } = require('sequelize');
const { Attendance, AttendanceSession, AuditLog, Branch, DeviceException, DeviceToken, Employee, LeaveRequest, Organisation, Regularisation, Shift } = require('../../models');
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

function getDatePartsInTimezone(value, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(value).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function formatDateParts(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getTodayDateString(timezone = 'UTC') {
  return formatDateParts(getDatePartsInTimezone(new Date(), timezone));
}

function getDateStringInTimezone(value, timezone = 'UTC') {
  return formatDateParts(getDatePartsInTimezone(value, timezone));
}

function getMonthRangeInTimezone(timezone = 'UTC', value = new Date()) {
  const current = getDatePartsInTimezone(value, timezone);
  const start = `${current.year}-${String(current.month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
  const end = `${current.year}-${String(current.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return { start, end };
}

async function getOrgTimezone(orgId) {
  const organisation = await Organisation.findOne({
    where: { id: orgId },
    attributes: ['timezone'],
  });

  return organisation && organisation.timezone ? organisation.timezone : 'UTC';
}

function getCooldownKey(orgId, empId) {
  return `attendance_cooldown:${orgId}:${empId}`;
}

function getUndoKey(orgId, empId, sessionId) {
  return `attendance_undo:${orgId}:${empId}:${sessionId}`;
}

function getLiveFeedKey(orgId) {
  return `attendance_live_feed:${orgId}`;
}

async function pushLiveFeedEvent(orgId, payload) {
  try {
    await redisClient.lpush(getLiveFeedKey(orgId), JSON.stringify(payload));
    await redisClient.ltrim(getLiveFeedKey(orgId), 0, 49);
    await redisClient.expire(getLiveFeedKey(orgId), 7 * 24 * 60 * 60);
  } catch (error) {
    return null;
  }

  return true;
}

async function readLiveFeedEvents(orgId, limit = 20) {
  try {
    const rows = await redisClient.lrange(getLiveFeedKey(orgId), 0, Math.max(0, limit - 1));
    return rows
      .map((row) => {
        try {
          return JSON.parse(row);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
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

async function getTodayAttendance(orgId, empId, timezone = 'UTC') {
  return Attendance.findOne({
    where: { org_id: orgId, emp_id: empId, date: getTodayDateString(timezone) },
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
  // ✅ FIX: Validate challenge token format
  if (!challengeToken || typeof challengeToken !== 'string') {
    throw createError('ATT_013', 'Invalid challenge token format', 422);
  }
  
  const payload = await consumeChallenge(challengeToken);

  if (!payload) {
    throw createError('ATT_008', 'Challenge token is invalid, expired, or already used', 401);
  }

  // ✅ FIX: Validate challenge belongs to this employee and org
  if (payload.orgId !== orgId || payload.empId !== empId) {
    throw createError('ATT_009', 'Challenge token does not match employee', 401);
  }

  // ✅ FIX: Validate timestamp is recent
  const captureTime = Number(captureTimestamp);
  if (!Number.isFinite(captureTime) || Math.abs(Date.now() - captureTime) > 35 * 1000) {
    throw createError('ATT_011', 'Capture timestamp is outside the allowed window', 401);
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
    const [updatedCount] = await DeviceException.update(
      { status: 'used' },
      {
        where: {
          id: exceptionId,
          org_id: orgId,
          emp_id: employee.id,
          temp_device_id: deviceId,
          status: 'approved',
          expires_at: { [Op.gt]: new Date() },
        },
      }
    );

    if (!updatedCount) {
      throw createError('AUTH_009', 'Device exception is invalid or expired', 401);
    }
    return;
  }

  throw createError('AUTH_009', 'This device is not registered for the employee', 401);
}

function validateGpsPayload(body) {
  const latitude = Number(body.lat);
  const longitude = Number(body.lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw createError('GEO_002', 'GPS coordinates are required', 400);
  }
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

function normalizeFaceMatch(result) {
  if (!result || !result.verified) {
    return {
      faceMatchScore: null,
      faceMatchSource: null,
    };
  }

  const provider = String(result.source || '').toLowerCase();
  const source = provider === 'rekognition' ? 'aws' : 'local';
  const rawScore =
    typeof result.score === 'number' && Number.isFinite(result.score)
      ? result.score
      : typeof result.confidence === 'number' && Number.isFinite(result.confidence)
        ? result.confidence / 100
        : null;

  return {
    faceMatchScore:
      typeof rawScore === 'number' && Number.isFinite(rawScore)
        ? Number(Math.max(0, Math.min(0.999, rawScore)).toFixed(3))
        : null,
    faceMatchSource: source,
  };
}

async function validateLocationForBranch(branch, body) {
  validateGpsPayload(body);

  if (branch.is_remote) {
    return;
  }

  const isInside = checkGeofence({ lat: Number(body.lat), lng: Number(body.lng) }, branch);
  if (!isInside) {
    throw createError('GEO_003', 'Employee is outside the branch geofence', 400);
  }
}

async function getTodayState(orgId, empId) {
  const timezone = await getOrgTimezone(orgId);
  const { shift } = await getEmployeeContext(orgId, empId);
  const attendance = await getTodayAttendance(orgId, empId, timezone);
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
    lastCheckout: lastSession && lastSession.check_out_time ? lastSession.check_out_time : null,
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
  const timezone = await getOrgTimezone(orgId);
  await validateChallenge({ orgId, empId, challengeToken: body.challengeToken, captureTimestamp: body.captureTimestamp });

  const { employee, shift, branch } = await getEmployeeContext(orgId, empId);
  await validateDevice({ orgId, employee, deviceId: body.deviceId, useDeviceException: body.useDeviceException, exceptionId: body.exceptionId });
  await validateLocationForBranch(branch, body);

  const faceVerification = await faceService.verifyFace(
    empId,
    orgId,
    body.faceEmbedding || null,
    faceService.decodeSelfie(body.selfieBase64)
  );
  const { faceMatchScore, faceMatchSource } = normalizeFaceMatch(faceVerification);

  // ✅ FIX: Use findOrCreate to prevent race condition
  const [attendance, created] = await Attendance.findOrCreate({
    where: {
      org_id: orgId,
      emp_id: empId,
      date: getTodayDateString(timezone),
    },
    defaults: {
      branch_id: employee.branch_id,
      shift_id: employee.shift_id,
      status: 'not_marked',
      first_check_in: new Date(),
      session_count: 0,
      total_worked_minutes: 0,
      is_anomaly: Number(body.accuracy) > 50,
      source: 'self',
      auto_absent_overridden: false,
      face_match_score: faceMatchScore,
      face_match_source: faceMatchSource,
    },
  });

  // Check if session already open
  if (!created) {
    const openSession = await getOpenSession(attendance.id);
    if (openSession) {
      throw createError('ATT_003', 'An attendance session is already open', 400);
    }

    if (Number(attendance.session_count || 0) >= Number(shift.max_sessions_per_day || 3)) {
      throw createError('ATT_004', 'Maximum sessions reached for today', 400);
    }

    const cooldownEndsAt = await redisClient.get(getCooldownKey(orgId, empId));
    if (cooldownEndsAt && new Date(cooldownEndsAt) > new Date()) {
      throw createError('ATT_004', 'Employee is in cooldown period', 400);
    }
  }

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
    status: 'present',
    is_anomaly: attendance.is_anomaly || Number(body.accuracy) > 50,
    source: 'self',
    auto_absent_overridden:
      attendance.status === 'absent' && Number(attendance.session_count || 0) === 0 && !attendance.first_check_in,
    face_match_score: faceMatchScore,
    face_match_source: faceMatchSource,
  });

  await redisClient.del(getCooldownKey(orgId, empId));
  await log(req.employee, 'attendance.check_in', { type: 'attendance_session', id: session.id }, null, { attendanceId: attendance.id }, req);
  await pushLiveFeedEvent(orgId, {
    empId,
    empName: employee.name,
    action: 'check-in',
    time: session.check_in_time,
    selfieUrl: null,
    status: attendance.status,
  });

  return {
    session: { id: session.id, checkInTime: session.check_in_time, status: session.status },
    attendanceStatus: 'present',
    buttonState: 'CHECKED_IN',
  };
}

async function checkOut({ orgId, empId, body, req }) {
  const timezone = await getOrgTimezone(orgId);
  const { employee, shift, branch } = await getEmployeeContext(orgId, empId);
  await validateDevice({ orgId, employee, deviceId: body.deviceId, useDeviceException: body.useDeviceException, exceptionId: body.exceptionId });
  await validateLocationForBranch(branch, body);

  if (body.challengeToken || body.captureTimestamp) {
    await validateChallenge({ orgId, empId, challengeToken: body.challengeToken, captureTimestamp: body.captureTimestamp });
  }

  const attendance = await getTodayAttendance(orgId, empId, timezone);
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for today', 404);
  }

  let faceMatchScore = attendance.face_match_score || null;
  let faceMatchSource = attendance.face_match_source || null;

  if (body.faceEmbedding || body.selfieBase64) {
    const faceVerification = await faceService.verifyFace(
      empId,
      orgId,
      body.faceEmbedding || null,
      faceService.decodeSelfie(body.selfieBase64)
    );
    ({ faceMatchScore, faceMatchSource } = normalizeFaceMatch(faceVerification));
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
    last_check_out: now,
    total_worked_minutes: totalWorkedMinutes,
  }, shift, null, timezone);

  await attendance.update({
    last_check_out: now,
    total_worked_minutes: totalWorkedMinutes,
    status: computed.status,
    is_late: computed.isLate,
    late_by_minutes: computed.lateByMinutes || 0,
    is_overtime: computed.isOvertime,
    overtime_minutes: computed.overtimeMinutes,
    is_early_checkout: computed.isEarlyCheckout,
    early_by_minutes: computed.earlyByMinutes || 0,
    check_out_type: computed.checkOutType,
    face_match_score: faceMatchScore,
    face_match_source: faceMatchSource,
    is_finalised: Boolean(body.isFinalCheckout),
  });

  const cooldownEndsAt = new Date(now.getTime() + Number(shift.session_cooldown_minutes || 15) * 60 * 1000);
  if (!body.isFinalCheckout) {
    await redisClient.set(getCooldownKey(orgId, empId), cooldownEndsAt.toISOString(), 'EX', Number(shift.session_cooldown_minutes || 15) * 60);
  } else {
    await redisClient.del(getCooldownKey(orgId, empId));
  }

  const undoKey = getUndoKey(orgId, empId, session.id);
  await redisClient.set(undoKey, '1', 'EX', 10 * 60);

  const checkoutGraceJobId = `checkout_grace_${session.id}`;
  await checkoutGrace.add('checkout_grace_expiry', {
    orgId,
    empId,
    attendanceId: attendance.id,
    sessionId: session.id,
  }, {
    jobId: checkoutGraceJobId,
    delay: 10 * 60 * 1000,
    removeOnComplete: true,
  });
  await attendance.update({ checkout_grace_job_id: checkoutGraceJobId });

  await log(req.employee, 'attendance.check_out', { type: 'attendance_session', id: session.id }, null, { workedMinutes }, req);
  await pushLiveFeedEvent(orgId, {
    empId,
    empName: employee.name,
    action: 'check-out',
    time: session.check_out_time,
    selfieUrl: null,
    status: computed.status,
  });

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
  const timezone = await getOrgTimezone(orgId);
  const attendance = await getTodayAttendance(orgId, empId, timezone);
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
  await attendance.update({
    last_check_out: null,
    total_worked_minutes: totalWorkedMinutes,
    is_finalised: false,
    is_early_checkout: false,
    early_by_minutes: 0,
    check_out_type: null,
    checkout_grace_job_id: null,
  });

  await redisClient.del(undoKey, getCooldownKey(orgId, empId));
  const undoJob = await checkoutGrace.getJob(`checkout_grace_${lastSession.id}`);
  if (undoJob) {
    await undoJob.remove().catch(() => {});
  }

  await log(req.employee, 'attendance.undo_checkout', { type: 'attendance_session', id: lastSession.id }, null, null, req);
  return { session: { id: lastSession.id, checkInTime: lastSession.check_in_time, status: 'open' } };
}

async function listAttendance(orgId, query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const where = { org_id: orgId };

  if (query.date) {
    where.date = query.date;
  } else if (query.dateFrom || query.dateTo) {
    where.date = {};

    if (query.dateFrom) {
      where.date[Op.gte] = query.dateFrom;
    }

    if (query.dateTo) {
      where.date[Op.lte] = query.dateTo;
    }
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.branch) {
    where.branch_id = query.branch;
  }

  if (query.employeeId) {
    where.emp_id = query.employeeId;
  }

  const result = await Attendance.findAndCountAll({
    where,
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'name', 'email'] }],
    order: [['date', 'DESC'], ['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    attendance: result.rows.map((row) => ({
      id: row.id,
      date: row.date,
      status: row.status,
      totalWorkedMins: row.total_worked_minutes || 0,
      sessionsToday: row.session_count || 0,
      checkInTime: row.first_check_in,
      checkOutTime: row.last_check_out,
      workingHours: Number(row.total_worked_minutes || 0) / 60,
      isLate: Boolean(row.is_late),
      isAnomaly: Boolean(row.is_anomaly),
      employee: row.employee
        ? {
            id: row.employee.id,
            name: row.employee.name,
            email: row.employee.email,
          }
        : null,
    })),
    pagination: {
      page,
      limit,
      count: result.count,
      totalPages: Math.ceil(result.count / limit) || 1,
    },
  };
}

function getDateRangeDays(days, timezone = 'UTC') {
  const dates = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() - offset);
    dates.push(getDateStringInTimezone(value, timezone));
  }

  return dates;
}

async function getTodayStats(orgId) {
  const timezone = await getOrgTimezone(orgId);
  const today = getTodayDateString(timezone);
  const employeeCount = await Employee.count({
    where: { org_id: orgId, is_active: true, role: { [Op.ne]: 'superadmin' } },
  });

  const rows = await Attendance.findAll({
    where: { org_id: orgId, date: today },
  });

  const pendingLeaves = await LeaveRequest.count({
    where: { org_id: orgId, status: 'pending' },
  });

  const pendingRegularisations = await Regularisation.count({
    where: { org_id: orgId, status: { [Op.in]: ['pending', 'manager_approved'] } },
  });

  const pendingDeviceExceptions = await DeviceException.count({
    where: { org_id: orgId, status: 'pending' },
  });

  const presentCount = rows.filter((row) => row.status === 'present').length;
  const leaveCount = rows.filter((row) => row.status === 'on_leave').length;
  const recordedAbsentCount = rows.filter((row) => row.status === 'absent').length;
  const absentCount = Math.max(employeeCount - presentCount - leaveCount, recordedAbsentCount);
  const lateCount = rows.filter((row) => row.is_late).length;

  return {
    employeeCount,
    checkedInCount: rows.filter((row) => row.first_check_in).length,
    presentCount,
    absentCount,
    leaveCount,
    lateCount,
    pendingLeaves,
    pendingRegularisations,
    pendingExceptions: pendingDeviceExceptions,
  };
}

async function getTrendStats(orgId, query) {
  const timezone = await getOrgTimezone(orgId);
  const days = Math.min(Math.max(Number(query.days || 30), 1), 90);
  const dates = getDateRangeDays(days, timezone);
  const rows = await Attendance.findAll({
    where: {
      org_id: orgId,
      date: {
        [Op.between]: [dates[0], dates[dates.length - 1]],
      },
    },
    attributes: ['date', 'status', 'is_late'],
    order: [['date', 'ASC']],
  });

  return dates.map((date) => {
    const dayRows = rows.filter((row) => row.date === date);
    return {
      date,
      present: dayRows.filter((row) => row.status === 'present').length,
      absent: dayRows.filter((row) => row.status === 'absent').length,
      leave: dayRows.filter((row) => row.status === 'on_leave').length,
      late: dayRows.filter((row) => row.is_late).length,
    };
  });
}

async function getTopLateEmployees(orgId, query) {
  const timezone = await getOrgTimezone(orgId);
  const limit = Math.min(Math.max(Number(query.limit || 5), 1), 20);
  const { start, end } = getMonthRangeInTimezone(timezone);
  const rows = await Attendance.findAll({
    where: {
      org_id: orgId,
      is_late: true,
      date: {
        [Op.between]: [start, end],
      },
    },
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'name'] }],
  });

  const grouped = rows.reduce((accumulator, row) => {
    const key = row.emp_id;
    if (!accumulator[key]) {
      accumulator[key] = {
        empId: row.emp_id,
        name: row.employee ? row.employee.name : 'Unknown',
        count: 0,
      };
    }

    accumulator[key].count += 1;
    return accumulator;
  }, {});

  return Object.values(grouped)
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

async function getRecentActivity(orgId, query) {
  const limit = Math.min(Math.max(Number(query.limit || 10), 1), 50);
  const liveEvents = await readLiveFeedEvents(orgId, limit);

  if (liveEvents.length > 0) {
    return liveEvents;
  }

  const rows = await AuditLog.findAll({
    where: {
      org_id: orgId,
      action: {
        [Op.in]: ['attendance.check_in', 'attendance.check_out', 'attendance.manual_mark'],
      },
    },
    order: [['created_at', 'DESC']],
    limit,
  });

  return rows.map((row) => ({
    id: String(row.id),
    action: row.action,
    time: row.created_at,
    entityType: row.entity_type,
    entityId: row.entity_id,
  }));
}

async function getLiveBoard(orgId, query) {
  const timezone = await getOrgTimezone(orgId);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 50);
  const events = await readLiveFeedEvents(orgId, limit);
  const onlineEmployeeIds = new Set();

  const openAttendances = await Attendance.findAll({
    where: {
      org_id: orgId,
      date: getTodayDateString(timezone),
    },
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'name'] }],
    order: [['updated_at', 'DESC']],
  });

  const rows = openAttendances.map((attendance) => {
    const isCheckedIn = Boolean(attendance.first_check_in) && !attendance.last_check_out;
    if (isCheckedIn) {
      onlineEmployeeIds.add(attendance.emp_id);
    }

    return {
      attendanceId: attendance.id,
      empId: attendance.emp_id,
      empName: attendance.employee ? attendance.employee.name : 'Unknown',
      status: attendance.status,
      isCheckedIn,
      time: attendance.last_check_out || attendance.first_check_in,
      selfieUrl: null,
      totalWorkedMins: attendance.total_worked_minutes || 0,
    };
  });

  return {
    rows,
    events,
    summary: {
      checkedInCount: onlineEmployeeIds.size,
      totalRows: rows.length,
    },
  };
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
    source: 'admin',
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
  getTodayStats,
  getTrendStats,
  getTopLateEmployees,
  getRecentActivity,
  getLiveBoard,
};
