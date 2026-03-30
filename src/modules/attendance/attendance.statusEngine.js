/**
 * Pure function - no DB calls.
 * @param {Object} attendance
 * @param {Object} shift
 * @param {Object | null} leaveApprovals
 * @returns {{ status: string, isLate: boolean, isOvertime: boolean, overtimeMinutes: number }}
 */
function computeAttendanceStatus(attendance, shift, leaveApprovals) {
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

  if (totalWorked >= overtimeAfter) {
    status = 'present';
  } else if (totalWorked >= halfDayAfter) {
    status = 'present';
  } else if (totalWorked >= absentAfter) {
    status = 'half_day_early';
  }

  const shiftStart = attendance.date && shift.start_time
    ? new Date(`${attendance.date}T${shift.start_time}Z`)
    : null;
  const firstCheckIn = attendance.first_check_in ? new Date(attendance.first_check_in) : null;
  const lateThreshold = shiftStart
    ? new Date(shiftStart.getTime() + Number(shift.grace_minutes_checkin || 15) * 60 * 1000)
    : null;

  return {
    status,
    isLate: Boolean(firstCheckIn && lateThreshold && firstCheckIn > lateThreshold),
    isOvertime: overtimeMinutes >= Number(shift.min_overtime_minutes || 30),
    overtimeMinutes,
  };
}

module.exports = {
  computeAttendanceStatus,
};
