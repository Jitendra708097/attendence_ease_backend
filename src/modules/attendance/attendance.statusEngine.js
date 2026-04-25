/**
 * Pure function - no DB calls.
 * @param {Object} attendance
 * @param {Object} shift
 * @param {Object | null} leaveApprovals
 * @param {string} timezone
 * @returns {{ status: string, isLate: boolean, isOvertime: boolean, overtimeMinutes: number }}
 */
function partsToUtcEpoch(parts) {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
}

function getDatePartsInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
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
}

function localDateTimeToUtc(dateString, timeString, timezone) {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  const [hour, minute, second] = String(timeString || '00:00:00')
    .split(':')
    .map((value) => Number(value || 0));

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    return null;
  }

  const targetParts = { year, month, day, hour, minute, second };
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let index = 0; index < 3; index += 1) {
    const localParts = getDatePartsInTimezone(new Date(guess), timezone || 'UTC');
    const diff = partsToUtcEpoch(targetParts) - partsToUtcEpoch(localParts);
    guess += diff;
  }

  return new Date(guess);
}

function addDays(dateString, days) {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function computeAttendanceStatus(attendance, shift, leaveApprovals, timezone = 'UTC') {
  if (leaveApprovals && leaveApprovals.type === 'full_day') {
    return {
      status: 'on_leave',
      isLate: false,
      isOvertime: false,
      overtimeMinutes: 0,
    };
  }

  if (leaveApprovals && leaveApprovals.type === 'half_day') {
    return {
      status: 'half_day',
      isLate: false,
      isOvertime: false,
      overtimeMinutes: 0,
    };
  }

  const totalWorked = Number(attendance.total_worked_minutes || 0);
  const overtimeAfter = Number(shift.overtime_after_minutes || 480);
  const halfDayAfter = Number(shift.half_day_after_minutes || 240);
  const absentAfter = Number(shift.absent_after_minutes || 120);
  const overtimeMinutes = totalWorked > overtimeAfter ? totalWorked - overtimeAfter : 0;

  let status = 'absent';

  if (totalWorked >= halfDayAfter) {
    status = 'present';
  } else if (totalWorked >= absentAfter) {
    status = 'half_day_early';
  }

  const shiftStart = attendance.date && shift.start_time
    ? localDateTimeToUtc(attendance.date, shift.start_time, timezone)
    : null;
  const firstCheckIn = attendance.first_check_in ? new Date(attendance.first_check_in) : null;
  const lateThreshold = shiftStart
    ? new Date(shiftStart.getTime() + Number(shift.grace_minutes_checkin || 15) * 60 * 1000)
    : null;
  const lastCheckOut = attendance.last_check_out ? new Date(attendance.last_check_out) : null;
  const shiftEndDate = attendance.date && shift.crosses_midnight ? addDays(attendance.date, 1) : attendance.date;
  const shiftEnd = shiftEndDate && shift.end_time
    ? localDateTimeToUtc(shiftEndDate, shift.end_time, timezone)
    : null;
  const lateByMinutes =
    firstCheckIn && lateThreshold && firstCheckIn > lateThreshold
      ? Math.round((firstCheckIn.getTime() - lateThreshold.getTime()) / 60000)
      : 0;
  const isEarlyCheckout = Boolean(lastCheckOut && shiftEnd && lastCheckOut < shiftEnd);
  const earlyByMinutes =
    isEarlyCheckout && shiftEnd
      ? Math.round((shiftEnd.getTime() - lastCheckOut.getTime()) / 60000)
      : 0;
  const checkOutType = !lastCheckOut ? null : isEarlyCheckout ? 'early' : 'normal';

  return {
    status,
    isLate: Boolean(firstCheckIn && lateThreshold && firstCheckIn > lateThreshold),
    lateByMinutes,
    isOvertime: overtimeMinutes >= Number(shift.min_overtime_minutes || 30),
    overtimeMinutes,
    isEarlyCheckout,
    earlyByMinutes,
    checkOutType,
  };
}

module.exports = {
  computeAttendanceStatus,
};
