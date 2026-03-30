const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const shiftService = require('./shift.service');

function validateShiftPayload(body = {}) {
  const details = [];

  if (!body.name) {
    details.push({ field: 'name', message: 'Shift name is required' });
  }

  if (!body.startTime) {
    details.push({ field: 'startTime', message: 'Start time is required' });
  }

  if (!body.endTime) {
    details.push({ field: 'endTime', message: 'End time is required' });
  }

  if (!Array.isArray(body.workDays) || body.workDays.length === 0) {
    details.push({ field: 'workDays', message: 'At least one work day is required' });
  }

  return details;
}

async function listShifts(req, res) {
  const data = await shiftService.listShifts(req.org_id);
  return ok(res, data, 'Shifts fetched');
}

async function createShift(req, res) {
  const details = validateShiftPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'SHIFT_001', 'Invalid shift payload', details, 422);
  }

  try {
    const data = await shiftService.createShift(req.org_id, req.body);
    await log(req.employee, 'shift.create', { type: 'shift', id: data.id }, null, data, req);
    return ok(res, data, 'Shift created', 201);
  } catch (error) {
    return fail(res, error.code || 'SHIFT_002', error.message, [], error.statusCode || 400);
  }
}

async function updateShift(req, res) {
  const details = validateShiftPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'SHIFT_003', 'Invalid shift payload', details, 422);
  }

  try {
    const data = await shiftService.updateShift(req.org_id, req.params.id, req.body);
    await log(req.employee, 'shift.update', { type: 'shift', id: data.id }, null, data, req);
    return ok(res, data, 'Shift updated');
  } catch (error) {
    return fail(res, error.code || 'SHIFT_004', error.message, [], error.statusCode || 400);
  }
}

async function deleteShift(req, res) {
  try {
    await shiftService.deleteShift(req.org_id, req.params.id);
    await log(req.employee, 'shift.delete', { type: 'shift', id: req.params.id }, null, null, req);
    return ok(res, { id: req.params.id }, 'Shift deleted');
  } catch (error) {
    return fail(res, error.code || 'SHIFT_005', error.message, [], error.statusCode || 404);
  }
}

module.exports = {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
};
