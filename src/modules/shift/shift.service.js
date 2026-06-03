const { Op } = require('sequelize');
const { Department, Designation, Employee, Shift } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');
const { notifyOrgRoles } = require('../notification/notification.service');

function mapShift(shift) {
  const assignedEmployees = Array.isArray(shift.employees) ? shift.employees : [];

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
    employeeCount: assignedEmployees.length,
  };
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function payloadValue(payload, field, fallback) {
  return Object.prototype.hasOwnProperty.call(payload, field) ? payload[field] : fallback;
}

async function listShifts(orgId) {
  const shifts = await scopedModel(Shift, orgId).findAll({
    include: [
      {
        model: Employee,
        as: 'employees',
        attributes: ['id'],
        required: false,
        where: {
          role: { [Op.ne]: 'superadmin' },
        },
      },
    ],
    order: [['created_at', 'DESC']],
  });

  return {
    shifts: shifts.map(mapShift),
  };
}

async function getShiftById(orgId, id) {
  const shift = await Shift.findOne({
    where: {
      id,
      org_id: orgId,
    },
    include: [
      {
        model: Employee,
        as: 'employees',
        attributes: ['id'],
        required: false,
        where: {
          role: { [Op.ne]: 'superadmin' },
        },
      },
    ],
  });

  if (!shift) {
    const error = new Error('Shift not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  return mapShift(shift);
}

async function listShiftEmployees(orgId, id) {
  await getShiftById(orgId, id);

  const employees = await Employee.findAll({
    where: {
      org_id: orgId,
      shift_id: id,
      role: { [Op.ne]: 'superadmin' },
    },
    attributes: ['id', 'name', 'email', 'emp_code', 'role', 'designation_id', 'is_active', 'branch_id', 'department_id'],
    include: [
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      { model: Designation, as: 'designation', attributes: ['id', 'name'], required: false },
    ],
    order: [['name', 'ASC']],
  });

  return {
    employees: employees.map((employee) => ({
      id: employee.id,
      name: employee.name,
      email: employee.email,
      empCode: employee.emp_code,
      role: employee.role,
      designationId: employee.designation_id,
      designationName: employee.designation ? employee.designation.name : null,
      status: employee.is_active ? 'active' : 'inactive',
      departmentId: employee.department_id,
      departmentName: employee.department ? employee.department.name : null,
    })),
    total: employees.length,
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
    break_minutes: optionalNumber(payload.breakMins),
    min_session_minutes: optionalNumber(payload.minSessionMins),
    session_cooldown_minutes: optionalNumber(payload.sessionCooldownMins),
    max_sessions_per_day: optionalNumber(payload.maxSessionsPerDay),
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
    break_minutes: optionalNumber(payloadValue(payload, 'breakMins', shift.break_minutes)),
    min_session_minutes: optionalNumber(payloadValue(payload, 'minSessionMins', shift.min_session_minutes)),
    session_cooldown_minutes: optionalNumber(payloadValue(payload, 'sessionCooldownMins', shift.session_cooldown_minutes)),
    max_sessions_per_day: optionalNumber(payloadValue(payload, 'maxSessionsPerDay', shift.max_sessions_per_day)),
  });

  await notifyOrgRoles(orgId, ['admin', 'manager'], {
    type: 'shift_changed',
    title: 'Shift updated',
    body: `${shift.name} shift timing or rules were updated.`,
    actionUrl: '/shifts',
    data: {
      shift_id: shift.id,
      priority: 'normal',
      status: 'completed',
    },
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

  const employeeCount = await Employee.count({
    where: {
      org_id: orgId,
      shift_id: id,
      role: { [Op.ne]: 'superadmin' },
    },
  });

  if (employeeCount > 0) {
    const error = new Error(`Cannot delete shift while ${employeeCount} employee(s) are assigned`);
    error.code = 'SHIFT_IN_USE';
    error.statusCode = 409;
    throw error;
  }

  await shift.destroy();
  return true;
}

module.exports = {
  listShifts,
  getShiftById,
  listShiftEmployees,
  createShift,
  updateShift,
  deleteShift,
};
