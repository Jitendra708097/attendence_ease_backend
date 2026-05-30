const { Op } = require('sequelize');
const XLSX = require('xlsx');
const { Attendance, AttendanceSession, AuditLog, Branch, DeviceException, DeviceToken, Employee, LeaveRequest, Organisation, Regularisation, Shift } = require('../../models');
const { redisClient } = require('../../config/redis');
const { checkoutGrace, notification } = require('../../queues');
const { log } = require('../../utils/auditLog');
const { createChallenge, consumeChallenge, readChallenge } = require('./attendance.challengeService');
const { computeAttendanceStatus } = require('./attendance.statusEngine');
const { checkGeofence, distanceToPolygonMeters } = require('../geofence/geofence.service');
const faceService = require('../face/face.service');
const { uploadAttendanceSelfie } = require('../face/face.storageService');
const { getUndoExpiryJobId } = require('../../queues/workers/checkoutGrace.worker');
const { searchFacesByImage } = require('../face/face.cloudService');

const KIOSK_REKOGNITION_THRESHOLD = 97;

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

  return organisation && organisation.timezone ? organisation.timezone : 'Asia/Kolkata';
}

function getCooldownKey(orgId, empId) {
  return `attendance_cooldown:${orgId}:${empId}`;
}

function getUndoKey(orgId, empId, sessionId) {
  return `attendance_undo:${orgId}:${empId}:${sessionId}`;
}

async function getUndoWindowEndsAt(orgId, empId, sessionId) {
  if (!sessionId) {
    return null;
  }

  const undoKey = getUndoKey(orgId, empId, sessionId);
  const ttlSeconds = await redisClient.ttl(undoKey);
  if (ttlSeconds <= 0) {
    return null;
  }

  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function getLiveFeedKey(orgId) {
  return `attendance_live_feed:${orgId}`;
}

function getAttendanceSubmitKey(orgId, empId, action, clientRequestId) {
  const requestPart = clientRequestId || 'recent';
  return `attendance_submit:${orgId}:${empId}:${action}:${requestPart}`;
}

async function guardRecentSubmit({ orgId, empId, action, clientRequestId, ttlSeconds = 30 }) {
  const keys = [...new Set([
    getAttendanceSubmitKey(orgId, empId, action, clientRequestId),
    getAttendanceSubmitKey(orgId, empId, action, null),
  ])];

  for (const key of keys) {
    const created = await redisClient.set(key, '1', 'EX', ttlSeconds, 'NX');
    if (!created) {
      throw createError('ATT_DUPLICATE', 'Attendance request is already being processed. Please wait a moment.', 409);
    }
  }
}

async function releaseRecentSubmit({ orgId, empId, action, clientRequestId }) {
  try {
    const keys = [...new Set([
      getAttendanceSubmitKey(orgId, empId, action, clientRequestId),
      getAttendanceSubmitKey(orgId, empId, action, null),
    ])];

    await redisClient.del(...keys);
  } catch (error) {
    return null;
  }

  return true;
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

async function validateChallenge({ orgId, empId, challengeToken, captureTimestamp, consume = true }) {
  // ✅ FIX: Validate challenge token format
  if (!challengeToken || typeof challengeToken !== 'string') {
    throw createError('ATT_013', 'Invalid challenge token format', 422);
  }
  
  const payload = consume ? await consumeChallenge(challengeToken) : await readChallenge(challengeToken);

  if (!payload) {
    throw createError('ATT_008', 'Challenge token is invalid, expired, or already used', 401);
  }

  // ✅ FIX: Validate challenge belongs to this employee and org
  if (payload.orgId !== orgId || payload.empId !== empId) {
    throw createError('ATT_009', 'Challenge token does not match employee', 401);
  }

  // ✅ FIX: Validate timestamp is recent
  const captureTime = Number(captureTimestamp);
  if (!Number.isFinite(captureTime) || Math.abs(Date.now() - captureTime) > 180 * 1000) {
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
    const [approvedUpdatedCount] = await DeviceException.update(
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

    if (approvedUpdatedCount) {
      return;
    }

    const usedException = await DeviceException.findOne({
      where: {
        id: exceptionId,
        org_id: orgId,
        emp_id: employee.id,
        temp_device_id: deviceId,
        status: 'used',
        expires_at: { [Op.gt]: new Date() },
      },
      attributes: ['id'],
    });

    if (!usedException) {
      throw createError('AUTH_009', 'Device exception is invalid or expired', 401);
    }
    return;
  }

  throw createError('AUTH_009', 'This device is not registered for the employee', 401);
}

function validateGpsPayload(body) {
  const latitude = Number(body.lat ?? body.latitude ?? body.coords?.latitude);
  const longitude = Number(body.lng ?? body.longitude ?? body.coords?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw createError('GEO_002', 'GPS coordinates are required', 400);
  }

  body.lat = latitude;
  body.lng = longitude;

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
    minSessionMinutes: shift.min_session_minutes,
    cooldownMinutes: shift.session_cooldown_minutes,
    maxSessionsPerDay: shift.max_sessions_per_day,
  };
}

function getPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function hasReachedSessionLimit(attendance, shift) {
  const maxSessionsPerDay = getPositiveNumber(shift.max_sessions_per_day);
  return maxSessionsPerDay != null && Number(attendance.session_count || 0) >= maxSessionsPerDay;
}

function getSessionCooldownMinutes(shift) {
  return getPositiveNumber(shift.session_cooldown_minutes);
}

function localDateTimeToUtc(dateString, timeString, timezone = 'UTC') {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  const [hour, minute, second] = String(timeString || '00:00:00')
    .split(':')
    .map((value) => Number(value || 0));

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    return null;
  }

  const target = {
    year,
    month,
    day,
    hour,
    minute,
    second,
  };

  const partsToUtcEpoch = (parts) =>
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );

  const getDateParts = (date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .reduce((accumulator, part) => {
        if (part.type !== 'literal') {
          accumulator[part.type] = part.value;
        }
        return accumulator;
      }, {});

  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let index = 0; index < 3; index += 1) {
    const localParts = getDateParts(new Date(guess));
    const diff = partsToUtcEpoch(target) - partsToUtcEpoch(localParts);
    guess += diff;
  }

  return new Date(guess);
}

function addDays(dateString, days) {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function getIncompleteExpiryDate(attendanceDate, shift) {
  if (!attendanceDate || !shift?.end_time) {
    return null;
  }

  const shiftEndDate = shift.crosses_midnight ? addDays(attendanceDate, 1) : attendanceDate;
  return localDateTimeToUtc(shiftEndDate, shift.end_time, 'UTC');
}

function getCheckoutGraceDeadline(attendanceDate, shift, timezone) {
  if (!attendanceDate || !shift?.end_time) {
    return null;
  }

  const shiftEnd = localDateTimeToUtc(
    shift.crosses_midnight ? addDays(attendanceDate, 1) : attendanceDate,
    shift.end_time,
    timezone
  );

  if (!shiftEnd) {
    return null;
  }

  const graceMinutes = Number(shift.grace_minutes_checkout || 60);
  return new Date(shiftEnd.getTime() + graceMinutes * 60 * 1000);
}

function assertCheckoutWindowStillOpen(attendanceDate, shift, timezone) {
  const checkoutDeadline = getCheckoutGraceDeadline(attendanceDate, shift, timezone);
  if (checkoutDeadline && Date.now() >= checkoutDeadline.getTime()) {
    throw createError(
      'ATT_014',
      'Check-in window has expired for this shift. Please request regularisation.',
      400
    );
  }
}

async function scheduleIncompleteExpiry({ orgId, empId, attendanceId, sessionId, attendanceDate, shift, timezone }) {
  const localShiftEnd = localDateTimeToUtc(
    shift.crosses_midnight ? addDays(attendanceDate, 1) : attendanceDate,
    shift.end_time,
    timezone
  );
  const checkoutDeadline = getCheckoutGraceDeadline(attendanceDate, shift, timezone);

  if (!localShiftEnd || !checkoutDeadline) {
    return null;
  }

  const delay = Math.max(checkoutDeadline.getTime() - Date.now(), 0);
  const jobId = `attendance_incomplete_expiry_${sessionId}`;

  await checkoutGrace.add(
    'incomplete_session_expiry',
    {
      orgId,
      empId,
      attendanceId,
      sessionId,
    },
    {
      jobId,
      delay,
      removeOnComplete: true,
    }
  );

  const reminderDelay = Math.max(localShiftEnd.getTime() + 30 * 60 * 1000 - Date.now(), 0);
  await notification.add(
    'checkout_reminder',
    {
      orgId,
      empId,
      attendanceId,
      sessionId,
    },
    {
      jobId: `checkout_reminder_${sessionId}`,
      delay: reminderDelay,
      removeOnComplete: true,
    }
  );

  return jobId;
}

function normalizeFaceMatch(result) {
  if (!result || !result.verified) {
    return {
      faceMatchScore: null,
      faceMatchSource: null,
    };
  }

  const provider = String(result.source || '').toLowerCase();
  const source = provider === 'rekognition' || provider === 'dedup_cache' ? 'aws' : provider || null;
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

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function getColumnWidth(value) {
  if (value == null) {
    return 10;
  }

  const stringValue = String(value);
  const longestLine = stringValue.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0);
  return Math.min(Math.max(longestLine + 2, 10), 40);
}

function buildWorkbookBuffer(sheetName, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const columnCount = Math.max(...rows.map((row) => row.length), 0);

  worksheet['!cols'] = Array.from({ length: columnCount }, (_, columnIndex) => ({
    wch: Math.max(...rows.map((row) => getColumnWidth(row[columnIndex]))),
  }));

  if (rows.length > 0 && columnCount > 0) {
    worksheet['!autofilter'] = {
      ref: `A1:${XLSX.utils.encode_cell({ r: 0, c: columnCount - 1 })}`,
    };
  }

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function normalizeDateFilter(query = {}, fallbackDate) {
  const dateFrom = query.date || query.dateFrom || fallbackDate;
  const dateTo = query.date || query.dateTo || dateFrom;

  return {
    dateFrom: dateFrom <= dateTo ? dateFrom : dateTo,
    dateTo: dateFrom <= dateTo ? dateTo : dateFrom,
  };
}

function getDateRangeBetween(dateFrom, dateTo) {
  const dates = [];
  const cursor = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);

  while (cursor <= end && dates.length <= 370) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function buildEmployeeAttendanceWhere(orgId, query = {}) {
  const where = {
    org_id: orgId,
    is_active: true,
    role: { [Op.ne]: 'superadmin' },
  };

  if (query.branch) {
    where.branch_id = query.branch;
  }

  if (query.employeeId) {
    where.id = query.employeeId;
  }

  return where;
}

function attendanceEmployeeInclude(attributes = ['id', 'name', 'email']) {
  return {
    model: Employee,
    as: 'employee',
    attributes,
    required: true,
    where: {
      role: { [Op.ne]: 'superadmin' },
    },
  };
}

function buildAttendanceDateWhere(dateFrom, dateTo) {
  return dateFrom === dateTo
    ? dateFrom
    : { [Op.between]: [dateFrom, dateTo] };
}

function toAttendanceListItem(row) {
  return {
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
  };
}

function toSyntheticNotMarkedItem(employee, date) {
  return {
    id: `not_marked:${employee.id}:${date}`,
    date,
    status: 'not_marked',
    totalWorkedMins: 0,
    sessionsToday: 0,
    checkInTime: null,
    checkOutTime: null,
    workingHours: 0,
    isLate: false,
    isAnomaly: false,
    isSyntheticNotMarked: true,
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      emp_code: employee.emp_code,
      branch_id: employee.branch_id,
    },
  };
}

async function getSyntheticNotMarkedAttendance(orgId, query = {}) {
  if (query.isLate === 'true' || query.isLate === true) {
    return [];
  }

  const timezone = await getOrgTimezone(orgId);
  const today = getTodayDateString(timezone);
  const { dateFrom, dateTo } = normalizeDateFilter(query, today);
  const dateRange = getDateRangeBetween(dateFrom, dateTo);

  if (dateRange.length === 0) {
    return [];
  }

  const employees = await Employee.findAll({
    where: buildEmployeeAttendanceWhere(orgId, query),
    attributes: ['id', 'name', 'email', 'emp_code', 'branch_id'],
    order: [['name', 'ASC']],
  });

  if (employees.length === 0) {
    return [];
  }

  const attendanceRows = await Attendance.findAll({
    where: {
      org_id: orgId,
      emp_id: { [Op.in]: employees.map((employee) => employee.id) },
      date: buildAttendanceDateWhere(dateFrom, dateTo),
    },
    attributes: ['emp_id', 'date'],
  });
  const markedByEmployeeDate = new Set(
    attendanceRows.map((attendance) => `${attendance.emp_id}:${attendance.date}`)
  );

  const rows = [];
  dateRange.forEach((date) => {
    employees.forEach((employee) => {
      if (!markedByEmployeeDate.has(`${employee.id}:${date}`)) {
        rows.push(toSyntheticNotMarkedItem(employee, date));
      }
    });
  });

  return rows.sort((left, right) => {
    if (left.date !== right.date) {
      return right.date.localeCompare(left.date);
    }
    return (left.employee?.name || '').localeCompare(right.employee?.name || '');
  });
}

function requireSelfieBuffer(selfieBase64, actionLabel) {
  const selfieBuffer = faceService.decodeSelfie(selfieBase64);

  if (!selfieBuffer) {
    throw createError('FACE_002', `A valid selfie image is required for ${actionLabel}`, 422);
  }

  return selfieBuffer;
}

function isTerminalOfflineSyncError(error) {
  return [
    'GEO_001',
    'GEO_002',
    'GEO_003',
    'GEO_004',
    'FACE_002',
    'FACE_003',
    'FACE_004',
    'ATT_009',
    'ATT_011',
  ].includes(error.code);
}

async function validateLocationForBranch(branch, body) {
  validateGpsPayload(body);

  if (branch.is_remote) {
    return;
  }

  if (!Array.isArray(branch.geo_fence_polygons) || branch.geo_fence_polygons.length < 3) {
    throw createError('GEO_001', 'No valid geofence is configured for this branch', 400);
  }

  const employeeLocation = { lat: Number(body.lat), lng: Number(body.lng) };
  const isInside = checkGeofence(employeeLocation, branch);
  if (!isInside) {
    const accuracy = Number(body.accuracy || 0);
    const toleranceMeters = Math.min(Math.max(accuracy, 15), 50);
    const distanceToBoundary = distanceToPolygonMeters(employeeLocation, branch.geo_fence_polygons);

    if (distanceToBoundary <= toleranceMeters) {
      body.isGeofenceBuffered = true;
      body.geofenceDistanceMeters = Number(distanceToBoundary.toFixed(2));
      return;
    }

    throw createError('GEO_003', 'Employee is outside the branch geofence', 400);
  }
}

function haversineMeters(from, to) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const latDelta = toRadians(to.lat - from.lat);
  const lngDelta = toRadians(to.lng - from.lng);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(lngDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function validateVelocity({ orgId, empId, lat, lng, timestamp = new Date() }) {
  const previousSession = await AttendanceSession.findOne({
    where: {
      org_id: orgId,
      emp_id: empId,
      [Op.or]: [
        { check_out_lat: { [Op.ne]: null }, check_out_lng: { [Op.ne]: null }, check_out_time: { [Op.ne]: null } },
        { check_in_lat: { [Op.ne]: null }, check_in_lng: { [Op.ne]: null }, check_in_time: { [Op.ne]: null } },
      ],
    },
    order: [['updated_at', 'DESC']],
  });

  if (!previousSession) {
    return;
  }

  const previousLat = previousSession.check_out_lat ?? previousSession.check_in_lat;
  const previousLng = previousSession.check_out_lng ?? previousSession.check_in_lng;
  const previousTime = previousSession.check_out_time || previousSession.check_in_time;

  if (previousLat == null || previousLng == null || !previousTime) {
    return;
  }

  const seconds = Math.abs(new Date(timestamp).getTime() - new Date(previousTime).getTime()) / 1000;
  if (seconds < 1) {
    return;
  }

  const meters = haversineMeters(
    { lat: Number(previousLat), lng: Number(previousLng) },
    { lat: Number(lat), lng: Number(lng) }
  );

  if (meters / seconds > 83.33) {
    throw createError('GEO_004', 'Location changed too quickly compared with the last attendance point', 400);
  }
}

async function identifyEmployeeByFace({ orgId, selfieBuffer }) {
  if (!Buffer.isBuffer(selfieBuffer)) {
    throw createError('FACE_002', 'Kiosk scan requires a selfie image', 422);
  }

  const cloudSearch = await searchFacesByImage(selfieBuffer, {
    threshold: KIOSK_REKOGNITION_THRESHOLD,
    maxFaces: 5,
  });

  if (cloudSearch.matches.length > 0) {
    const faceIds = cloudSearch.matches.map((match) => match.faceId);
    const employees = await Employee.findAll({
      where: {
        org_id: orgId,
        is_active: true,
        is_face_enrolled: true,
        face_embedding_id: { [Op.in]: faceIds },
      },
      attributes: ['id', 'org_id', 'branch_id', 'shift_id', 'name', 'emp_code', 'face_embedding_id'],
    });
    const employeeByFaceId = employees.reduce((accumulator, employee) => {
      accumulator[employee.face_embedding_id] = employee;
      return accumulator;
    }, {});
    const rankedOrgMatches = cloudSearch.matches
      .map((match) => ({
        ...match,
        employee: employeeByFaceId[match.faceId],
      }))
      .filter((match) => match.employee)
      .sort((left, right) => right.similarity - left.similarity);
    const best = rankedOrgMatches[0];
    const second = rankedOrgMatches[1];

    if (best && best.similarity >= KIOSK_REKOGNITION_THRESHOLD) {
      if (second && best.similarity - second.similarity < 2) {
        throw createError('FACE_007', 'Face match is ambiguous. Please try again.', 409);
      }

      return {
        employee: best.employee,
        match: {
          score: Number((best.similarity / 100).toFixed(3)),
          confidence: best.similarity,
          source: 'aws',
          threshold: KIOSK_REKOGNITION_THRESHOLD,
        },
      };
    }
  }

  throw createError('FACE_008', 'No registered employee face matched in this organisation', 404);
}

async function getLeaveApprovalForDate(orgId, empId, date) {
  const leave = await LeaveRequest.findOne({
    where: {
      org_id: orgId,
      emp_id: empId,
      status: 'approved',
      from_date: { [Op.lte]: date },
      to_date: { [Op.gte]: date },
    },
    order: [['is_half_day', 'DESC']],
  });

  if (!leave) {
    return null;
  }

  return {
    type: leave.is_half_day ? 'half_day' : 'full_day',
    period: leave.half_day_period || null,
    leaveId: leave.id,
  };
}

function addDateDays(dateString, days) {
  const value = new Date(`${dateString}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function getDateList(fromDate, toDate) {
  const dates = [];
  for (let current = fromDate; current && current <= toDate; current = addDateDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

async function recomputeLeaveAttendance({ orgId, empId, fromDate, toDate, transaction = null }) {
  const employee = await Employee.findOne({
    where: { id: empId, org_id: orgId, is_active: true },
    transaction,
  });

  if (!employee) {
    return { updated: 0 };
  }

  const shift = await Shift.findOne({ where: { id: employee.shift_id, org_id: orgId }, transaction });
  if (!shift) {
    return { updated: 0 };
  }

  const timezone = await getOrgTimezone(orgId);
  const today = getTodayDateString(timezone);
  let updated = 0;

  for (const date of getDateList(fromDate, toDate)) {
    const leaveApproval = await getLeaveApprovalForDate(orgId, empId, date);
    let attendance = await Attendance.findOne({
      where: { org_id: orgId, emp_id: empId, date },
      transaction,
    });

    if (!attendance && leaveApproval) {
      attendance = await Attendance.create(
        {
          org_id: orgId,
          emp_id: empId,
          branch_id: employee.branch_id,
          shift_id: employee.shift_id,
          date,
          status: leaveApproval.type === 'full_day' ? 'on_leave' : 'half_day',
          source: 'leave',
          is_finalised: date <= today,
        },
        { transaction }
      );
      updated += 1;
      continue;
    }

    if (!attendance || attendance.is_manual) {
      continue;
    }

    const sessions = await getAttendanceSessions(attendance.id);
    const totalWorkedMinutes = sessions.reduce((sum, item) => sum + Number(item.worked_minutes || 0), 0);

    if (leaveApproval) {
      const computed = computeAttendanceStatus(
        {
          date,
          first_check_in: attendance.first_check_in,
          last_check_out: attendance.last_check_out,
          total_worked_minutes: totalWorkedMinutes,
        },
        shift,
        leaveApproval,
        timezone
      );

      await attendance.update(
        {
          status: computed.status,
          total_worked_minutes: totalWorkedMinutes,
          is_late: computed.isLate,
          late_by_minutes: computed.lateByMinutes || 0,
          is_overtime: computed.isOvertime,
          overtime_minutes: computed.overtimeMinutes || 0,
          is_early_checkout: computed.isEarlyCheckout || false,
          early_by_minutes: computed.earlyByMinutes || 0,
          check_out_type: computed.checkOutType || attendance.check_out_type,
          source: attendance.source === 'auto' ? 'leave' : attendance.source,
          is_finalised: date <= today || attendance.is_finalised,
        },
        { transaction }
      );
      updated += 1;
      continue;
    }

    if (attendance.source === 'leave' || ['on_leave', 'half_day'].includes(attendance.status)) {
      if (attendance.session_count > 0 || totalWorkedMinutes > 0) {
        const computed = computeAttendanceStatus(
          {
            date,
            first_check_in: attendance.first_check_in,
            last_check_out: attendance.last_check_out,
            total_worked_minutes: totalWorkedMinutes,
          },
          shift,
          null,
          timezone
        );
        await attendance.update(
          {
            status: computed.status,
            total_worked_minutes: totalWorkedMinutes,
            is_late: computed.isLate,
            late_by_minutes: computed.lateByMinutes || 0,
            is_overtime: computed.isOvertime,
            overtime_minutes: computed.overtimeMinutes || 0,
            is_early_checkout: computed.isEarlyCheckout || false,
            early_by_minutes: computed.earlyByMinutes || 0,
            check_out_type: computed.checkOutType || attendance.check_out_type,
            source: 'self',
          },
          { transaction }
        );
      } else {
        await attendance.update(
          {
            status: date <= today ? 'absent' : 'not_marked',
            source: 'auto',
            is_finalised: date <= today,
          },
          { transaction }
        );
      }
      updated += 1;
    }
  }

  return { updated };
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
      orgTimezone: timezone,
    };
  }

  const openSession = await getOpenSession(attendance.id);
  const sessions = await getAttendanceSessions(attendance.id);
  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const undoWindowEndsAt = lastSession
    ? await getUndoWindowEndsAt(orgId, empId, lastSession.id)
    : null;

  return {
    openSession: openSession ? { id: openSession.id, checkInTime: openSession.check_in_time, status: openSession.status } : null,
    cooldownEndsAt: cooldownEndsAt || null,
    lastCheckout: lastSession && lastSession.check_out_time ? lastSession.check_out_time : null,
    undoWindowEndsAt,
    lastCheckoutId: undoWindowEndsAt && lastSession ? lastSession.id : null,
    todayStatus: attendance.status,
    totalWorkedMins: attendance.total_worked_minutes || 0,
    sessionsToday: attendance.session_count || 0,
    firstCheckInTime: attendance.first_check_in || null,
    shiftInfo: buildShiftInfo(shift),
    orgTimezone: timezone,
  };
}

async function requestChallenge(orgId, empId) {
  await getEmployeeContext(orgId, empId);
  return createChallenge({ orgId, empId });
}

async function checkIn({ orgId, empId, body, req }) {
  const timezone = await getOrgTimezone(orgId);
  const clientRequestId = body.clientRequestId || body.client_record_id;
  await validateChallenge({
    orgId,
    empId,
    challengeToken: body.challengeToken,
    captureTimestamp: body.captureTimestamp,
    consume: false,
  });
  await guardRecentSubmit({
    orgId,
    empId,
    action: 'check_in',
    clientRequestId,
  });

  try {
    const { employee, shift, branch } = await getEmployeeContext(orgId, empId);
    const attendanceDate = getTodayDateString(timezone);
    assertCheckoutWindowStillOpen(attendanceDate, shift, timezone);
    await validateDevice({ orgId, employee, deviceId: body.deviceId, useDeviceException: body.useDeviceException, exceptionId: body.exceptionId });
    await validateLocationForBranch(branch, body);
    await validateVelocity({ orgId, empId, lat: Number(body.lat), lng: Number(body.lng), timestamp: new Date() });
    const selfieBuffer = requireSelfieBuffer(body.selfieBase64, 'attendance check-in');

    const faceVerification = await faceService.verifyFace(empId, orgId, selfieBuffer);
    const { faceMatchScore, faceMatchSource } = normalizeFaceMatch(faceVerification);

  const existingAttendance = await getTodayAttendance(orgId, empId, timezone);
  if (existingAttendance) {
    const openSession = await getOpenSession(existingAttendance.id);
    if (openSession) {
      throw createError('ATT_003', 'An attendance session is already open', 400);
    }

    if (hasReachedSessionLimit(existingAttendance, shift)) {
      throw createError('ATT_004', 'Maximum sessions reached for today', 400);
    }

    if (getSessionCooldownMinutes(shift)) {
      const cooldownEndsAt = await redisClient.get(getCooldownKey(orgId, empId));
      if (cooldownEndsAt && new Date(cooldownEndsAt) > new Date()) {
        throw createError('ATT_004', 'Employee is in cooldown period', 400);
      }
    }
  }

  await validateChallenge({
    orgId,
    empId,
    challengeToken: body.challengeToken,
    captureTimestamp: body.captureTimestamp,
  });

  // ✅ FIX: Use findOrCreate to prevent race condition
  const [attendance] = await Attendance.findOrCreate({
    where: {
      org_id: orgId,
      emp_id: empId,
      date: attendanceDate,
    },
    defaults: {
      branch_id: employee.branch_id,
      shift_id: employee.shift_id,
      status: 'pending',
      first_check_in: new Date(),
      session_count: 0,
      total_worked_minutes: 0,
      is_anomaly: Number(body.accuracy) > 50 || Boolean(body.isGeofenceBuffered),
      source: 'self',
      auto_absent_overridden: false,
      face_match_score: faceMatchScore,
      face_match_source: faceMatchSource,
    },
  });

  const nextSessionNumber = Number(attendance.session_count || 0) + 1;
  const session = await AttendanceSession.create({
    attendance_id: attendance.id,
    org_id: orgId,
    emp_id: empId,
    session_number: nextSessionNumber,
    check_in_time: new Date(),
    check_in_lat: Number(body.lat),
    check_in_lng: Number(body.lng),
    status: 'open',
    worked_minutes: 0,
    is_undo_eligible: false,
  });

  await attendance.update({
    session_count: nextSessionNumber,
    first_check_in: attendance.first_check_in || session.check_in_time,
    status: 'pending',
    is_anomaly: attendance.is_anomaly || Number(body.accuracy) > 50 || Boolean(body.isGeofenceBuffered),
    source: 'self',
    auto_absent_overridden:
      attendance.status === 'absent' && Number(attendance.session_count || 0) === 0 && !attendance.first_check_in,
    face_match_score: faceMatchScore,
    face_match_source: faceMatchSource,
  });

  const incompleteJobId = await scheduleIncompleteExpiry({
    orgId,
    empId,
    attendanceId: attendance.id,
    sessionId: session.id,
    attendanceDate: attendance.date,
    shift,
    timezone,
  });

  if (incompleteJobId) {
    await attendance.update({ checkout_grace_job_id: incompleteJobId });
  }

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
      attendanceStatus: 'pending',
      buttonState: 'CHECKED_IN',
    };
  } catch (error) {
    await releaseRecentSubmit({ orgId, empId, action: 'check_in', clientRequestId });
    throw error;
  }
}

async function checkOut({ orgId, empId, body, req }) {
  const timezone = await getOrgTimezone(orgId);
  const clientRequestId = body.clientRequestId || body.client_record_id;
  await validateChallenge({
    orgId,
    empId,
    challengeToken: body.challengeToken,
    captureTimestamp: body.captureTimestamp,
    consume: false,
  });
  await guardRecentSubmit({
    orgId,
    empId,
    action: 'check_out',
    clientRequestId,
  });

  try {
    const { employee, shift, branch } = await getEmployeeContext(orgId, empId);
  await validateDevice({ orgId, employee, deviceId: body.deviceId, useDeviceException: body.useDeviceException, exceptionId: body.exceptionId });
  await validateLocationForBranch(branch, body);
  await validateVelocity({ orgId, empId, lat: Number(body.lat), lng: Number(body.lng), timestamp: new Date() });
  const checkoutSelfieBuffer = requireSelfieBuffer(body.selfieBase64, 'attendance check-out');

  const attendance = await getTodayAttendance(orgId, empId, timezone);
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for today', 404);
  }

  const faceVerification = await faceService.verifyFace(
    empId,
    orgId,
    checkoutSelfieBuffer
  );
  let { faceMatchScore, faceMatchSource } = normalizeFaceMatch(faceVerification);

  const session = await getOpenSession(attendance.id);
  if (!session) {
    throw createError('ATT_005', 'No open attendance session found', 400);
  }

  await validateChallenge({
    orgId,
    empId,
    challengeToken: body.challengeToken,
    captureTimestamp: body.captureTimestamp,
  });

  if (attendance.checkout_grace_job_id) {
    const pendingIncompleteJob = await checkoutGrace.getJob(attendance.checkout_grace_job_id);
    if (pendingIncompleteJob) {
      await pendingIncompleteJob.remove().catch(() => {});
    }
  }

  const now = new Date();
  const workedMinutes = Math.max(0, Math.round((now.getTime() - new Date(session.check_in_time).getTime()) / 60000));
  let uploadedCheckoutSelfie = null;
  try {
    uploadedCheckoutSelfie = await uploadAttendanceSelfie(checkoutSelfieBuffer, orgId, empId, 'check-out');
  } catch (error) {
    uploadedCheckoutSelfie = null;
  }

  await session.update({
    check_out_time: now,
    check_out_lat: Number(body.lat),
    check_out_lng: Number(body.lng),
    selfie_url: uploadedCheckoutSelfie ? uploadedCheckoutSelfie.secureUrl : session.selfie_url,
    worked_minutes: workedMinutes,
    status: 'completed',
    is_undo_eligible: true,
  });

  const sessions = await getAttendanceSessions(attendance.id);
  const totalWorkedMinutes = sessions.reduce((sum, item) => sum + Number(item.worked_minutes || 0), 0);
  const leaveApproval = await getLeaveApprovalForDate(orgId, empId, attendance.date);
  const computed = computeAttendanceStatus({
    date: attendance.date,
    first_check_in: attendance.first_check_in,
    last_check_out: now,
    total_worked_minutes: totalWorkedMinutes,
  }, shift, leaveApproval, timezone);

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
    is_anomaly: attendance.is_anomaly || Number(body.accuracy) > 50 || Boolean(body.isGeofenceBuffered),
    is_finalised: Boolean(body.isFinalCheckout),
  });

  if (computed.isLate) {
    await notification.add(
      'send_push',
      {
        orgId,
        empIds: [empId],
        type: 'late_marked',
        title: 'Late attendance marked',
        body: `Your attendance for ${attendance.date} was marked late by ${computed.lateByMinutes || 0} minutes.`,
        actionUrl: 'attendease://attendance',
        data: { attendance_id: attendance.id, date: attendance.date },
      },
      {
        jobId: `late_marked_${attendance.id}`,
        removeOnComplete: true,
      }
    );
  }

  const cooldownMinutes = getSessionCooldownMinutes(shift);
  const cooldownEndsAt = cooldownMinutes ? new Date(now.getTime() + cooldownMinutes * 60 * 1000) : null;
  if (!body.isFinalCheckout && cooldownMinutes) {
    await redisClient.set(getCooldownKey(orgId, empId), cooldownEndsAt.toISOString(), 'EX', cooldownMinutes * 60);
  } else {
    await redisClient.del(getCooldownKey(orgId, empId));
  }

  const undoKey = getUndoKey(orgId, empId, session.id);
  await redisClient.set(undoKey, '1', 'EX', 10 * 60);

  const undoExpiryJobId = getUndoExpiryJobId(session.id);
  await checkoutGrace.add(
    'undo_expiry',
    {
      orgId,
      empId,
      attendanceId: attendance.id,
      sessionId: session.id,
    },
    {
      jobId: undoExpiryJobId,
      delay: 10 * 60 * 1000,
      removeOnComplete: true,
    }
  );
  await attendance.update({ checkout_grace_job_id: null });

  await log(req.employee, 'attendance.check_out', { type: 'attendance_session', id: session.id }, null, { workedMinutes }, req);
  await pushLiveFeedEvent(orgId, {
    empId,
    empName: employee.name,
    action: 'check-out',
    time: session.check_out_time,
    selfieUrl: session.selfie_url || null,
    status: computed.status,
  });

  return {
    session: {
      id: session.id,
      checkInTime: session.check_in_time,
      checkOutTime: session.check_out_time,
      checkOutLat: toNumberOrNull(session.check_out_lat),
      checkOutLng: toNumberOrNull(session.check_out_lng),
      selfieUrl: session.selfie_url || null,
      faceMethod: faceMatchSource,
      status: session.status,
      workedMinutes,
    },
    totalWorkedMins: totalWorkedMinutes,
    cooldownEndsAt: body.isFinalCheckout ? null : cooldownEndsAt.toISOString(),
  };
  } catch (error) {
    await releaseRecentSubmit({ orgId, empId, action: 'check_out', clientRequestId });
    throw error;
  }
}

async function kioskCheckIn({ orgId, employee, shift, body, req, faceMatch }) {
  const timezone = await getOrgTimezone(orgId);
  const empId = employee.id;
  const attendanceDate = getTodayDateString(timezone);
  assertCheckoutWindowStillOpen(attendanceDate, shift, timezone);
  await validateVelocity({ orgId, empId, lat: Number(body.lat), lng: Number(body.lng), timestamp: new Date() });

  const [attendance, created] = await Attendance.findOrCreate({
    where: {
      org_id: orgId,
      emp_id: empId,
      date: attendanceDate,
    },
    defaults: {
      branch_id: employee.branch_id,
      shift_id: employee.shift_id,
      status: 'pending',
      first_check_in: new Date(),
      session_count: 0,
      total_worked_minutes: 0,
      is_anomaly: Number(body.accuracy) > 50 || Boolean(body.isGeofenceBuffered),
      source: 'kiosk',
      auto_absent_overridden: false,
      face_match_score: faceMatch.score,
      face_match_source: faceMatch.source,
    },
  });

  if (!created) {
    const openSession = await getOpenSession(attendance.id);
    if (openSession) {
      throw createError('ATT_003', 'Matched employee already has an open attendance session', 400);
    }

    if (hasReachedSessionLimit(attendance, shift)) {
      throw createError('ATT_004', 'Matched employee has reached maximum sessions for today', 400);
    }

    if (getSessionCooldownMinutes(shift)) {
      const cooldownEndsAt = await redisClient.get(getCooldownKey(orgId, empId));
      if (cooldownEndsAt && new Date(cooldownEndsAt) > new Date()) {
        throw createError('ATT_004', 'Matched employee is in cooldown period', 400);
      }
    }
  }

  const nextSessionNumber = Number(attendance.session_count || 0) + 1;
  const session = await AttendanceSession.create({
    attendance_id: attendance.id,
    org_id: orgId,
    emp_id: empId,
    session_number: nextSessionNumber,
    check_in_time: new Date(),
    check_in_lat: Number(body.lat),
    check_in_lng: Number(body.lng),
    status: 'open',
    worked_minutes: 0,
    is_undo_eligible: false,
  });

  await attendance.update({
    session_count: nextSessionNumber,
    first_check_in: attendance.first_check_in || session.check_in_time,
    status: 'pending',
    is_anomaly: attendance.is_anomaly || Number(body.accuracy) > 50 || Boolean(body.isGeofenceBuffered),
    source: 'kiosk',
    auto_absent_overridden:
      attendance.status === 'absent' && Number(attendance.session_count || 0) === 0 && !attendance.first_check_in,
    face_match_score: faceMatch.score,
    face_match_source: faceMatch.source,
  });

  const incompleteJobId = await scheduleIncompleteExpiry({
    orgId,
    empId,
    attendanceId: attendance.id,
    sessionId: session.id,
    attendanceDate: attendance.date,
    shift,
    timezone,
  });

  if (incompleteJobId) {
    await attendance.update({ checkout_grace_job_id: incompleteJobId });
  }

  await redisClient.del(getCooldownKey(orgId, empId));
  await log(
    req.employee,
    'attendance.kiosk_check_in',
    { type: 'attendance_session', id: session.id },
    null,
    {
      attendanceId: attendance.id,
      matchedEmpId: empId,
      matchedBranchId: employee.branch_id,
      kioskHostEmpId: req.employee.id,
      kioskHostBranchId: req.employee.branch_id,
      deviceId: body.deviceId || null,
      gps: {
        lat: Number(body.lat),
        lng: Number(body.lng),
        accuracy: body.accuracy == null ? null : Number(body.accuracy),
      },
      faceMatchSource: faceMatch.source,
      faceMatchScore: faceMatch.score,
      faceMatch,
    },
    req
  );
  await pushLiveFeedEvent(orgId, {
    empId,
    empName: employee.name,
    action: 'kiosk-check-in',
    time: session.check_in_time,
    selfieUrl: null,
    status: attendance.status,
  });

  return {
    action: 'check_in',
    session: { id: session.id, checkInTime: session.check_in_time, status: session.status },
    attendanceStatus: 'pending',
  };
}

async function kioskCheckOut({ orgId, employee, shift, body, req, faceMatch, selfieBuffer }) {
  const timezone = await getOrgTimezone(orgId);
  const empId = employee.id;
  await validateVelocity({ orgId, empId, lat: Number(body.lat), lng: Number(body.lng), timestamp: new Date() });

  const attendance = await getTodayAttendance(orgId, empId, timezone);
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found for matched employee today', 404);
  }

  const session = await getOpenSession(attendance.id);
  if (!session) {
    throw createError('ATT_005', 'No open attendance session found for matched employee', 400);
  }

  if (attendance.checkout_grace_job_id) {
    const pendingIncompleteJob = await checkoutGrace.getJob(attendance.checkout_grace_job_id);
    if (pendingIncompleteJob) {
      await pendingIncompleteJob.remove().catch(() => {});
    }
  }

  const now = new Date();
  const workedMinutes = Math.max(0, Math.round((now.getTime() - new Date(session.check_in_time).getTime()) / 60000));
  let uploadedCheckoutSelfie = null;
  try {
    uploadedCheckoutSelfie = await uploadAttendanceSelfie(selfieBuffer, orgId, empId, 'kiosk-check-out');
  } catch (error) {
    uploadedCheckoutSelfie = null;
  }

  await session.update({
    check_out_time: now,
    check_out_lat: Number(body.lat),
    check_out_lng: Number(body.lng),
    selfie_url: uploadedCheckoutSelfie ? uploadedCheckoutSelfie.secureUrl : session.selfie_url,
    worked_minutes: workedMinutes,
    status: 'completed',
    is_undo_eligible: false,
  });

  const sessions = await getAttendanceSessions(attendance.id);
  const totalWorkedMinutes = sessions.reduce((sum, item) => sum + Number(item.worked_minutes || 0), 0);
  const leaveApproval = await getLeaveApprovalForDate(orgId, empId, attendance.date);
  const computed = computeAttendanceStatus(
    {
      date: attendance.date,
      first_check_in: attendance.first_check_in,
      last_check_out: now,
      total_worked_minutes: totalWorkedMinutes,
    },
    shift,
    leaveApproval,
    timezone
  );

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
    face_match_score: faceMatch.score,
    face_match_source: faceMatch.source,
    source: 'kiosk',
    is_anomaly: attendance.is_anomaly || Number(body.accuracy) > 50 || Boolean(body.isGeofenceBuffered),
    is_finalised: false,
    checkout_grace_job_id: null,
  });

  if (computed.isLate) {
    await notification.add(
      'send_push',
      {
        orgId,
        empIds: [empId],
        type: 'late_marked',
        title: 'Late attendance marked',
        body: `Your attendance for ${attendance.date} was marked late by ${computed.lateByMinutes || 0} minutes.`,
        actionUrl: 'attendease://attendance',
        data: { attendance_id: attendance.id, date: attendance.date },
      },
      {
        jobId: `late_marked_${attendance.id}`,
        removeOnComplete: true,
      }
    );
  }

  const cooldownMinutes = getSessionCooldownMinutes(shift);
  const cooldownEndsAt = cooldownMinutes ? new Date(now.getTime() + cooldownMinutes * 60 * 1000) : null;
  if (cooldownMinutes) {
    await redisClient.set(
      getCooldownKey(orgId, empId),
      cooldownEndsAt.toISOString(),
      'EX',
      cooldownMinutes * 60
    );
  } else {
    await redisClient.del(getCooldownKey(orgId, empId));
  }

  await log(
    req.employee,
    'attendance.kiosk_check_out',
    { type: 'attendance_session', id: session.id },
    null,
    {
      matchedEmpId: empId,
      matchedBranchId: employee.branch_id,
      kioskHostEmpId: req.employee.id,
      kioskHostBranchId: req.employee.branch_id,
      deviceId: body.deviceId || null,
      gps: {
        lat: Number(body.lat),
        lng: Number(body.lng),
        accuracy: body.accuracy == null ? null : Number(body.accuracy),
      },
      workedMinutes,
      faceMatchSource: faceMatch.source,
      faceMatchScore: faceMatch.score,
      faceMatch,
    },
    req
  );
  await pushLiveFeedEvent(orgId, {
    empId,
    empName: employee.name,
    action: 'kiosk-check-out',
    time: session.check_out_time,
    selfieUrl: session.selfie_url || null,
    status: computed.status,
  });

  return {
    action: 'check_out',
    session: {
      id: session.id,
      checkInTime: session.check_in_time,
      checkOutTime: session.check_out_time,
      status: session.status,
      workedMinutes,
    },
    attendanceStatus: computed.status,
    totalWorkedMins: totalWorkedMinutes,
    cooldownEndsAt: cooldownEndsAt.toISOString(),
  };
}

async function kioskScan({ orgId, hostEmpId, body, req }) {
  let lockedEmployeeId = null;
  const clientRequestId = body.clientRequestId || body.client_record_id;

  try {
  const hostContext = await getEmployeeContext(orgId, hostEmpId);
  await validateChallenge({
    orgId,
    empId: hostEmpId,
    challengeToken: body.challengeToken,
    captureTimestamp: body.captureTimestamp,
  });
  await validateLocationForBranch(hostContext.branch, body);

  const selfieBuffer = requireSelfieBuffer(body.selfieBase64, 'kiosk attendance');
  const { employee: matchedEmployee, match } = await identifyEmployeeByFace({
    orgId,
    selfieBuffer,
  });

  const matchedContext = await getEmployeeContext(orgId, matchedEmployee.id);
  if (String(matchedContext.employee.branch_id) !== String(hostContext.employee.branch_id)) {
    throw createError(
      'KIOSK_BRANCH_MISMATCH',
      'Employee belongs to another branch. Please use that branch kiosk.',
      403
    );
  }

  await guardRecentSubmit({
    orgId,
    empId: matchedContext.employee.id,
    action: 'kiosk_scan',
    clientRequestId,
    ttlSeconds: 45,
  });
  lockedEmployeeId = matchedContext.employee.id;

  const timezone = await getOrgTimezone(orgId);
  const attendance = await getTodayAttendance(orgId, matchedEmployee.id, timezone);
  const openSession = attendance ? await getOpenSession(attendance.id) : null;
  const result = openSession
    ? await kioskCheckOut({
        orgId,
        employee: matchedContext.employee,
        shift: matchedContext.shift,
        body,
        req,
        faceMatch: match,
        selfieBuffer,
      })
    : await kioskCheckIn({
        orgId,
        employee: matchedContext.employee,
        shift: matchedContext.shift,
        body,
        req,
        faceMatch: match,
      });

  return {
    ...result,
    matchedEmployee: {
      id: matchedContext.employee.id,
      name: matchedContext.employee.name,
      empCode: matchedContext.employee.emp_code || null,
    },
    kioskHost: {
      id: hostContext.employee.id,
      name: hostContext.employee.name,
    },
    faceMatch: match,
  };
  } catch (error) {
    if (lockedEmployeeId) {
      await releaseRecentSubmit({
        orgId,
        empId: lockedEmployeeId,
        action: 'kiosk_scan',
        clientRequestId,
      });
    }
    throw error;
  }
}

async function syncOffline({ orgId, empId, body, req }) {
  const records = Array.isArray(body.records) ? body.records : [];

  if (records.length === 0) {
    throw createError('ATT_SYNC_001', 'Offline sync requires at least one record', 422);
  }

  const timezone = await getOrgTimezone(orgId);
  const { employee, shift, branch } = await getEmployeeContext(orgId, empId);
  const results = [];

  for (const [index, record] of records.entries()) {
    const clientRecordId = record.clientRecordId || record.client_record_id;
    const capturedAt = record.timestamp ? new Date(record.timestamp) : new Date();
    const lat = Number(record.lat ?? record.latitude ?? record.location?.latitude);
    const lng = Number(record.lng ?? record.longitude ?? record.location?.longitude);

    if (!clientRecordId) {
      results.push({ index, status: 'error', code: 'ATT_SYNC_002', message: 'clientRecordId is required' });
      continue;
    }

    const existingByClientId = await Attendance.findOne({ where: { org_id: orgId, client_record_id: clientRecordId } });
    if (existingByClientId) {
      results.push({ index, status: 'duplicate', attendanceId: existingByClientId.id });
      continue;
    }

    try {
      const gpsPayload = {
        lat,
        lng,
        accuracy: record.accuracy,
        altitude: record.altitude,
        speed: record.speed,
        isMocked: Boolean(record.isMocked),
      };

      await validateLocationForBranch(branch, gpsPayload);
      await validateVelocity({ orgId, empId, lat, lng, timestamp: capturedAt });

      const selfieBuffer = faceService.decodeSelfie(record.selfieBase64);
      if (!selfieBuffer) {
        throw createError('FACE_002', 'Offline sync requires a selfie image for AWS face verification', 422);
      }
      await faceService.verifyFace(empId, orgId, selfieBuffer);

      const date = getDateStringInTimezone(capturedAt, timezone);
      const type = String(record.type || 'check_in').toLowerCase();

      if (type === 'check_out' || type === 'checkout') {
        const attendance = await Attendance.findOne({
          where: {
            org_id: orgId,
            emp_id: empId,
            date,
          },
          order: [['created_at', 'DESC']],
        });

        if (!attendance) {
          results.push({ index, status: 'conflict', message: 'No attendance record found for offline checkout' });
          continue;
        }

        const session = await getOpenSession(attendance.id);
        if (!session) {
          results.push({ index, status: 'conflict', attendanceId: attendance.id, message: 'No open session found for offline checkout' });
          continue;
        }

        const workedMinutes = Math.max(
          0,
          Math.round((capturedAt.getTime() - new Date(session.check_in_time).getTime()) / 60000)
        );

        await session.update({
          check_out_time: capturedAt,
          check_out_lat: lat,
          check_out_lng: lng,
          worked_minutes: workedMinutes,
          status: 'completed',
          is_undo_eligible: false,
        });

        const sessions = await getAttendanceSessions(attendance.id);
        const totalWorkedMinutes = sessions.reduce((sum, item) => sum + Number(item.worked_minutes || 0), 0);
        const leaveApproval = await getLeaveApprovalForDate(orgId, empId, attendance.date);
        const computed = computeAttendanceStatus(
          {
            date: attendance.date,
            first_check_in: attendance.first_check_in,
            last_check_out: capturedAt,
            total_worked_minutes: totalWorkedMinutes,
          },
          shift,
          leaveApproval,
          timezone
        );

        await attendance.update({
          last_check_out: capturedAt,
          total_worked_minutes: totalWorkedMinutes,
          status: computed.status,
          is_late: computed.isLate,
          late_by_minutes: computed.lateByMinutes || 0,
          is_overtime: computed.isOvertime,
          overtime_minutes: computed.overtimeMinutes,
          is_early_checkout: computed.isEarlyCheckout,
          early_by_minutes: computed.earlyByMinutes || 0,
          check_out_type: computed.checkOutType,
          source: 'offline_sync',
          client_record_id: attendance.client_record_id || clientRecordId,
          is_finalised: true,
        });

        results.push({ index, status: 'synced', attendanceId: attendance.id, sessionId: session.id });
        continue;
      }

      let attendance = await Attendance.findOne({
        where: {
          org_id: orgId,
          emp_id: empId,
          date,
        },
      });

      if (attendance && attendance.first_check_in) {
        results.push({ index, status: 'conflict', attendanceId: attendance.id, message: 'Attendance already exists for this date' });
        continue;
      }

      if (!attendance) {
        attendance = await Attendance.create({
          org_id: orgId,
          emp_id: empId,
          branch_id: employee.branch_id,
          shift_id: employee.shift_id,
          date,
          status: 'pending',
          first_check_in: capturedAt,
          session_count: 1,
          total_worked_minutes: 0,
          is_anomaly: Number(record.accuracy) > 50,
          source: 'offline_sync',
          client_record_id: clientRecordId,
        });
      } else {
        await attendance.update({
          status: 'pending',
          first_check_in: capturedAt,
          session_count: 1,
          total_worked_minutes: 0,
          is_anomaly: attendance.is_anomaly || Number(record.accuracy) > 50,
          source: 'offline_sync',
          auto_absent_overridden: attendance.status === 'absent',
          client_record_id: clientRecordId,
          is_finalised: false,
        });
      }

      const session = await AttendanceSession.create({
        attendance_id: attendance.id,
        org_id: orgId,
        emp_id: empId,
        session_number: 1,
        check_in_time: capturedAt,
        check_in_lat: lat,
        check_in_lng: lng,
        status: 'open',
        worked_minutes: 0,
      });

      await log(req.employee, 'attendance.offline_sync', { type: 'attendance', id: attendance.id }, null, { clientRecordId }, req);
      results.push({ index, status: 'synced', attendanceId: attendance.id, sessionId: session.id });
    } catch (error) {
      results.push({
        index,
        status: isTerminalOfflineSyncError(error) ? 'rejected' : 'error',
        code: error.code || 'ATT_SYNC_003',
        message: error.message,
        retryable: !isTerminalOfflineSyncError(error),
      });
    }
  }

  return {
    synced: results.filter((result) => result.status === 'synced').length,
    duplicates: results.filter((result) => result.status === 'duplicate').length,
    conflicts: results.filter((result) => result.status === 'conflict').length,
    rejected: results.filter((result) => result.status === 'rejected').length,
    failed: results.filter((result) => result.status === 'error').length,
    results,
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

  await lastSession.update({
    check_out_time: null,
    check_out_lat: null,
    check_out_lng: null,
    selfie_url: null,
    worked_minutes: 0,
    status: 'open',
    is_undo_eligible: false,
  });

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
  const undoJob = await checkoutGrace.getJob(getUndoExpiryJobId(lastSession.id));
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

  if (query.status === 'not_marked') {
    const syntheticRows = await getSyntheticNotMarkedAttendance(orgId, query);
    const pagedRows = syntheticRows.slice(offset, offset + limit);

    return {
      attendance: pagedRows,
      pagination: {
        page,
        limit,
        count: syntheticRows.length,
        totalPages: Math.ceil(syntheticRows.length / limit) || 1,
      },
    };
  }

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

  if (query.isLate === 'true' || query.isLate === true) {
    where.is_late = true;
  }

  if (query.branch) {
    where.branch_id = query.branch;
  }

  if (query.employeeId) {
    where.emp_id = query.employeeId;
  }

  const result = await Attendance.findAndCountAll({
    where,
    include: [attendanceEmployeeInclude(['id', 'name', 'email'])],
    order: [['date', 'DESC'], ['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    attendance: result.rows.map(toAttendanceListItem),
    pagination: {
      page,
      limit,
      count: result.count,
      totalPages: Math.ceil(result.count / limit) || 1,
    },
  };
}

async function exportAttendance(orgId, query) {
  if (query.status === 'not_marked') {
    const [notMarkedRows, branches] = await Promise.all([
      getSyntheticNotMarkedAttendance(orgId, query),
      Branch.findAll({
        where: { org_id: orgId },
        attributes: ['id', 'name'],
      }),
    ]);
    const branchNameById = branches.reduce((accumulator, branch) => {
      accumulator[branch.id] = branch.name;
      return accumulator;
    }, {});
    const rows = [
      [
        'Date',
        'Employee Name',
        'Employee Code',
        'Employee Email',
        'Branch',
        'Status',
        'First Check In',
        'Last Check Out',
        'Worked Minutes',
        'Sessions',
        'Late',
        'Anomaly',
        'Manual',
      ],
      ...notMarkedRows.map((row) => [
        row.date,
        row.employee?.name || '',
        row.employee?.emp_code || '',
        row.employee?.email || '',
        branchNameById[row.employee?.branch_id] || '',
        row.status,
        '',
        '',
        0,
        0,
        'No',
        'No',
        'No',
      ]),
    ];
    const filenameDate = new Date().toISOString().slice(0, 10);
    const format = String(query.format || 'csv').toLowerCase();

    if (format === 'xlsx') {
      return {
        filename: `attendance-export-${filenameDate}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: buildWorkbookBuffer('Attendance', rows),
      };
    }

    return {
      filename: `attendance-export-${filenameDate}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: `${buildCsv(rows)}\r\n`,
    };
  }

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

  const [attendanceRows, branches] = await Promise.all([
    Attendance.findAll({
      where,
      include: [attendanceEmployeeInclude(['id', 'name', 'email', 'emp_code'])],
      order: [['date', 'DESC'], ['created_at', 'DESC']],
    }),
    Branch.findAll({
      where: { org_id: orgId },
      attributes: ['id', 'name'],
    }),
  ]);

  const branchNameById = branches.reduce((accumulator, branch) => {
    accumulator[branch.id] = branch.name;
    return accumulator;
  }, {});

  const rows = [
    [
      'Date',
      'Employee Name',
      'Employee Code',
      'Employee Email',
      'Branch',
      'Status',
      'First Check In',
      'Last Check Out',
      'Worked Minutes',
      'Sessions',
      'Late',
      'Anomaly',
      'Manual',
    ],
    ...attendanceRows.map((row) => [
      row.date,
      row.employee?.name || '',
      row.employee?.emp_code || '',
      row.employee?.email || '',
      branchNameById[row.branch_id] || '',
      row.status,
      row.first_check_in ? new Date(row.first_check_in).toISOString() : '',
      row.last_check_out ? new Date(row.last_check_out).toISOString() : '',
      row.total_worked_minutes || 0,
      row.session_count || 0,
      row.is_late ? 'Yes' : 'No',
      row.is_anomaly ? 'Yes' : 'No',
      row.is_manual ? 'Yes' : 'No',
    ]),
  ];

  const filenameDate = new Date().toISOString().slice(0, 10);
  const format = String(query.format || 'csv').toLowerCase();

  if (format === 'xlsx') {
    return {
      filename: `attendance-export-${filenameDate}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: buildWorkbookBuffer('Attendance', rows),
    };
  }

  return {
    filename: `attendance-export-${filenameDate}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: `${buildCsv(rows)}\r\n`,
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
    include: [attendanceEmployeeInclude(['id'])],
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

  const pendingCount = rows.filter((row) => row.status === 'pending').length;
  const presentCount = rows.filter((row) => row.status === 'present').length;
  const leaveCount = rows.filter((row) => row.status === 'on_leave').length;
  const recordedAbsentCount = rows.filter((row) => row.status === 'absent').length;
  const absentCount = Math.max(employeeCount - presentCount - pendingCount - leaveCount, recordedAbsentCount);
  const lateCount = rows.filter((row) => row.is_late).length;

  return {
    employeeCount,
    checkedInCount: rows.filter((row) => row.first_check_in).length,
    pendingCount,
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
    include: [attendanceEmployeeInclude(['id'])],
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
    include: [attendanceEmployeeInclude(['id', 'name'])],
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
    include: [attendanceEmployeeInclude(['id', 'name'])],
    order: [['updated_at', 'DESC']],
  });

  const attendanceIds = openAttendances.map((attendance) => attendance.id);
  const sessions = attendanceIds.length > 0
    ? await AttendanceSession.findAll({
        where: {
          attendance_id: {
            [Op.in]: attendanceIds,
          },
        },
        order: [['session_number', 'DESC']],
      })
    : [];

  const latestSessionByAttendanceId = sessions.reduce((accumulator, session) => {
    if (!accumulator[session.attendance_id]) {
      accumulator[session.attendance_id] = session;
    }
    return accumulator;
  }, {});

  const rows = openAttendances.map((attendance) => {
    const latestSession = latestSessionByAttendanceId[attendance.id] || null;
    const isCheckedIn = Boolean(latestSession && latestSession.status === 'open');

    if (isCheckedIn) {
      onlineEmployeeIds.add(attendance.emp_id);
    }

    return {
      attendanceId: attendance.id,
      empId: attendance.emp_id,
      empName: attendance.employee ? attendance.employee.name : 'Unknown',
      status: attendance.status,
      isCheckedIn,
      time: latestSession?.check_out_time || latestSession?.check_in_time || attendance.last_check_out || attendance.first_check_in,
      selfieUrl: latestSession?.selfie_url || null,
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
    accumulator[record.date] = {
      status: record.status,
      isLate: record.isLate,
    };
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
      checkInLat: toNumberOrNull(session.check_in_lat),
      checkInLng: toNumberOrNull(session.check_in_lng),
      checkOutLat: toNumberOrNull(session.check_out_lat),
      checkOutLng: toNumberOrNull(session.check_out_lng),
      selfieUrl: session.selfie_url || null,
      faceMethod: attendance.face_match_source || null,
      isUndoEligible: Boolean(session.is_undo_eligible),
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

async function setAnomalyFlag({ orgId, id, isAnomaly, req }) {
  const attendance = await Attendance.findOne({ where: { id, org_id: orgId } });
  if (!attendance) {
    throw createError('HTTP_404', 'Attendance record not found', 404);
  }

  const previous = attendance.toJSON();
  await attendance.update({
    is_anomaly: Boolean(isAnomaly),
  });

  await log(
    req.employee,
    isAnomaly ? 'attendance.flag_anomaly' : 'attendance.unflag_anomaly',
    { type: 'attendance', id: attendance.id },
    previous,
    attendance.toJSON(),
    req
  );

  return getAttendanceById(orgId, attendance.id);
}

module.exports = {
  requestChallenge,
  checkIn,
  checkOut,
  kioskScan,
  syncOffline,
  undoCheckout,
  getTodayState,
  listAttendance,
  exportAttendance,
  getAttendanceHistory,
  getAttendanceById,
  manualMark,
  setAnomalyFlag,
  recomputeLeaveAttendance,
  getTodayStats,
  getTrendStats,
  getTopLateEmployees,
  getRecentActivity,
  getLiveBoard,
};
