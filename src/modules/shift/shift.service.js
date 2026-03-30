const { Shift } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');

function mapShift(shift) {
  return {
    id: shift.id,
    name: shift.name,
    startTime: shift.start_time,
    endTime: shift.end_time,
    crossesMidnight: shift.crosses_midnight,
    workDays: shift.work_days || [],
    graceCheckIn: shift.grace_minutes_checkin,
    graceCheckOut: shift.grace_minutes_checkout,
    halfDayAfter: shift.half_day_after_minutes,
    absentAfter: shift.absent_after_minutes,
    otAfter: shift.overtime_after_minutes,
    minOtMins: shift.min_overtime_minutes,
    breakMins: shift.break_minutes,
    minSessionMins: shift.min_session_minutes,
    sessionCooldownMins: shift.session_cooldown_minutes,
    maxSessionsPerDay: shift.max_sessions_per_day,
  };
}

async function listShifts(orgId) {
  const shifts = await scopedModel(Shift, orgId).findAll({
    order: [['created_at', 'DESC']],
  });

  return {
    shifts: shifts.map(mapShift),
  };
}

async function createShift(orgId, payload) {
  const shift = await scopedModel(Shift, orgId).create({
    name: payload.name,
    start_time: payload.startTime,
    end_time: payload.endTime,
    crosses_midnight: payload.crossesMidnight,
    work_days: payload.workDays,
    grace_minutes_checkin: payload.graceCheckIn,
    grace_minutes_checkout: payload.graceCheckOut,
    half_day_after_minutes: payload.halfDayAfter,
    absent_after_minutes: payload.absentAfter,
    overtime_after_minutes: payload.otAfter,
    min_overtime_minutes: payload.minOtMins,
    break_minutes: payload.breakMins,
    min_session_minutes: payload.minSessionMins,
    session_cooldown_minutes: payload.sessionCooldownMins,
    max_sessions_per_day: payload.maxSessionsPerDay,
  });

  return mapShift(shift);
}

async function updateShift(orgId, id, payload) {
  const shift = await Shift.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!shift) {
    const error = new Error('Shift not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  await shift.update({
    name: payload.name ?? shift.name,
    start_time: payload.startTime ?? shift.start_time,
    end_time: payload.endTime ?? shift.end_time,
    crosses_midnight: payload.crossesMidnight ?? shift.crosses_midnight,
    work_days: payload.workDays ?? shift.work_days,
    grace_minutes_checkin: payload.graceCheckIn ?? shift.grace_minutes_checkin,
    grace_minutes_checkout: payload.graceCheckOut ?? shift.grace_minutes_checkout,
    half_day_after_minutes: payload.halfDayAfter ?? shift.half_day_after_minutes,
    absent_after_minutes: payload.absentAfter ?? shift.absent_after_minutes,
    overtime_after_minutes: payload.otAfter ?? shift.overtime_after_minutes,
    min_overtime_minutes: payload.minOtMins ?? shift.min_overtime_minutes,
    break_minutes: payload.breakMins ?? shift.break_minutes,
    min_session_minutes: payload.minSessionMins ?? shift.min_session_minutes,
    session_cooldown_minutes: payload.sessionCooldownMins ?? shift.session_cooldown_minutes,
    max_sessions_per_day: payload.maxSessionsPerDay ?? shift.max_sessions_per_day,
  });

  return mapShift(shift);
}

async function deleteShift(orgId, id) {
  const shift = await Shift.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!shift) {
    const error = new Error('Shift not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  await shift.destroy();
  return true;
}

module.exports = {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
};
