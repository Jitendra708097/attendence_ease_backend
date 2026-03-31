const { Organisation } = require('../../models');
const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const employeeService = require('./employee.service');
const { validateEmployeePayload } = require('./employee.validators');

async function listEmployees(req, res) {
  const data = await employeeService.listEmployees(req.org_id, req.query);
  return ok(res, data, 'Employees fetched');
}

async function getEmployee(req, res) {
  try {
    const data = await employeeService.getEmployeeById(req.org_id, req.params.id);
    return ok(res, data, 'Employee fetched');
  } catch (error) {
    return fail(res, error.code || 'EMP_001', error.message, [], error.statusCode || 404);
  }
}

async function createEmployee(req, res) {
  const details = validateEmployeePayload(req.body);

  if (details.length > 0) {
    return fail(res, 'EMP_003', 'Invalid employee payload', details, 422);
  }

  try {
    const organisation = await Organisation.findOne({
      where: { id: req.org_id },
      attributes: ['id', 'slug', 'name'],
    });
    const data = await employeeService.createEmployee(req.org_id, organisation, req.body);
    await log(req.employee, 'employee.create', { type: 'employee', id: data.id }, null, data, req);
    return ok(res, data, 'Employee created', 201);
  } catch (error) {
    return fail(res, error.code || 'EMP_004', error.message, [], error.statusCode || 400);
  }
}

async function updateEmployee(req, res) {
  const details = validateEmployeePayload(req.body, true);

  if (details.length > 0) {
    return fail(res, 'EMP_005', 'Invalid employee payload', details, 422);
  }

  try {
    const data = await employeeService.updateEmployee(req.org_id, req.params.id, req.body);
    await log(req.employee, 'employee.update', { type: 'employee', id: data.id }, null, data, req);
    return ok(res, data, 'Employee updated');
  } catch (error) {
    return fail(res, error.code || 'EMP_006', error.message, [], error.statusCode || 400);
  }
}

async function deleteEmployee(req, res) {
  try {
    await employeeService.deleteEmployee(req.org_id, req.params.id);
    await log(req.employee, 'employee.delete', { type: 'employee', id: req.params.id }, null, null, req);
    return ok(res, { id: req.params.id }, 'Employee deleted');
  } catch (error) {
    return fail(res, error.code || 'EMP_007', error.message, [], error.statusCode || 404);
  }
}

async function bulkUpload(req, res) {
  if (!req.file) {
    return fail(res, 'EMP_008', 'Excel file is required', [], 400);
  }

  try {
    const organisation = await Organisation.findOne({
      where: { id: req.org_id },
      attributes: ['id', 'slug', 'name'],
    });
    const data = await employeeService.bulkUpload(req.org_id, organisation, req.file.buffer);
    await log(req.employee, 'employee.bulk_upload', { type: 'employee_bulk_upload', id: req.employee.id }, null, { count: data.length }, req);
    return ok(res, data, 'Bulk upload processed');
  } catch (error) {
    return fail(res, error.code || 'EMP_009', error.message, [], error.statusCode || 400);
  }
}

async function attendanceSummary(req, res) {
  try {
    const data = await employeeService.attendanceSummary(req.org_id, req.params.id);
    return ok(res, data, 'Attendance summary fetched');
  } catch (error) {
    return fail(res, error.code || 'EMP_010', error.message, [], error.statusCode || 400);
  }
}

module.exports = {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  bulkUpload,
  attendanceSummary,
};
