const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const departmentService = require('./department.service');

function validateDepartmentPayload(body = {}, isUpdate = false) {
  const details = [];

  if (!isUpdate && !body.name) {
    details.push({ field: 'name', message: 'Department name is required' });
  }

  return details;
}

async function listDepartments(req, res) {
  const data = await departmentService.listDepartments(req.org_id);
  return ok(res, data, 'Departments fetched');
}

async function getDepartment(req, res) {
  try {
    const data = await departmentService.getDepartmentById(req.org_id, req.params.id);
    return ok(res, data, 'Department fetched');
  } catch (error) {
    return fail(res, error.code || 'DEPT_001', error.message, error.details || [], error.statusCode || 404);
  }
}

async function createDepartment(req, res) {
  const details = validateDepartmentPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'DEPT_002', 'Invalid department payload', details, 422);
  }

  try {
    const data = await departmentService.createDepartment(req.org_id, req.body);
    await log(req.employee, 'department.create', { type: 'department', id: data.id }, null, data, req);
    return ok(res, data, 'Department created', 201);
  } catch (error) {
    return fail(res, error.code || 'DEPT_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function updateDepartment(req, res) {
  const details = validateDepartmentPayload(req.body, true);

  if (details.length > 0) {
    return fail(res, 'DEPT_004', 'Invalid department payload', details, 422);
  }

  try {
    const data = await departmentService.updateDepartment(req.org_id, req.params.id, req.body);
    await log(req.employee, 'department.update', { type: 'department', id: data.id }, null, data, req);
    return ok(res, data, 'Department updated');
  } catch (error) {
    return fail(res, error.code || 'DEPT_005', error.message, error.details || [], error.statusCode || 400);
  }
}

async function deleteDepartment(req, res) {
  try {
    await departmentService.deleteDepartment(req.org_id, req.params.id);
    await log(req.employee, 'department.delete', { type: 'department', id: req.params.id }, null, null, req);
    return ok(res, { id: req.params.id }, 'Department deleted');
  } catch (error) {
    return fail(res, error.code || 'DEPT_006', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
};
