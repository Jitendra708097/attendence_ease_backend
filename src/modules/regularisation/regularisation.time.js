const {
  getDatePartsInTimezone,
  localDateTimeToUtc,
} = require('../attendance/attendance.statusEngine');

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateString, days) {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function normalizeTimeString(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const raw = String(value).trim();
  const match = TIME_PATTERN.exec(raw);

  if (!match) {
    return null;
  }

  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

function timeToSeconds(value) {
  const normalized = normalizeTimeString(value);

  if (!normalized) {
    return null;
  }

  const [hour, minute, second] = normalized.split(':').map(Number);
  return hour * 3600 + minute * 60 + second;
}

function localDateStringForValue(value, timezone = 'UTC') {
  if (!value) {
    return null;
  }

  const parts = getDatePartsInTimezone(new Date(value), timezone || 'UTC');
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localTimeStringForValue(value, timezone = 'UTC') {
  if (!value) {
    return null;
  }

  const parts = getDatePartsInTimezone(new Date(value), timezone || 'UTC');
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function getCheckoutDateForTime(date, checkoutTime, shift = {}) {
  if (!shift.crosses_midnight) {
    return date;
  }

  const checkoutSeconds = timeToSeconds(checkoutTime);
  const shiftStartSeconds = timeToSeconds(shift.start_time);

  if (checkoutSeconds !== null && shiftStartSeconds !== null && checkoutSeconds < shiftStartSeconds) {
    return addDays(date, 1);
  }

  return date;
}

function normalizeRequestedLocalTime({ date, value, timezone = 'UTC', field, shift = {} }) {
  const time = normalizeTimeString(value);

  if (!time) {
    return null;
  }

  const targetDate = field === 'checkout'
    ? getCheckoutDateForTime(date, time, shift)
    : date;

  return localDateTimeToUtc(targetDate, time, timezone || 'UTC');
}

function assertValidDateString(date) {
  return DATE_PATTERN.test(String(date || '').trim());
}

function diffMinutes(start, end) {
  if (!start || !end) {
    return 0;
  }

  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function buildCorrectedAttendanceTimes({ attendance, requestedCheckIn, requestedCheckOut }) {
  const nextCheckIn = requestedCheckIn || attendance.first_check_in || null;
  const nextCheckOut = requestedCheckOut || attendance.last_check_out || null;
  const nextCheckInDate = nextCheckIn ? new Date(nextCheckIn) : null;
  const nextCheckOutDate = nextCheckOut ? new Date(nextCheckOut) : null;

  if (nextCheckInDate && nextCheckOutDate && nextCheckOutDate <= nextCheckInDate) {
    const error = new Error('Check-out time must be after check-in time');
    error.code = 'REG_015';
    error.statusCode = 422;
    error.details = [
      { field: 'requestedCheckOut', message: 'Check-out time must be after check-in time' },
    ];
    throw error;
  }

  return {
    nextCheckIn: nextCheckInDate,
    nextCheckOut: nextCheckOutDate,
    totalWorkedMinutes: diffMinutes(nextCheckInDate, nextCheckOutDate),
  };
}

function isRegularisationTimeOffDate({ value, attendanceDate, field, shift = {}, timezone = 'UTC' }) {
  if (!value || !attendanceDate) {
    return false;
  }

  const localDate = localDateStringForValue(value, timezone);

  if (field === 'checkout' && shift.crosses_midnight) {
    return ![attendanceDate, addDays(attendanceDate, 1)].includes(localDate);
  }

  return localDate !== attendanceDate;
}

function reanchorRegularisationTime({ value, attendanceDate, field, shift = {}, timezone = 'UTC' }) {
  const localTime = localTimeStringForValue(value, timezone);

  if (!localTime) {
    return null;
  }

  return normalizeRequestedLocalTime({
    date: attendanceDate,
    value: localTime,
    timezone,
    field,
    shift,
  });
}

module.exports = {
  addDays,
  assertValidDateString,
  buildCorrectedAttendanceTimes,
  isRegularisationTimeOffDate,
  localDateStringForValue,
  localTimeStringForValue,
  normalizeRequestedLocalTime,
  normalizeTimeString,
  reanchorRegularisationTime,
};
