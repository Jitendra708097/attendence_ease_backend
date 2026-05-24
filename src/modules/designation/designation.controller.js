const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const designationService = require('./designation.service');

async function listDesignations(req, res) {
  const data = await designationService.listDesignations(req.org_id);
  return ok(res, data, 'Designations fetched');
}

async function createDesignation(req, res) {
  try {
    const data = await designationService.createDesignation(req.org_id, req.body);
    await log(req.employee, 'designation.create', { type: 'designation', id: data.id }, null, data, req);
    return ok(res, data, 'Designation created', 201);
  } catch (error) {
    return fail(res, error.code || 'DESIG_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function deleteDesignation(req, res) {
  try {
    await designationService.deleteDesignation(req.org_id, req.params.id);
    await log(req.employee, 'designation.delete', { type: 'designation', id: req.params.id }, null, null, req);
    return ok(res, { id: req.params.id }, 'Designation deleted');
  } catch (error) {
    return fail(res, error.code || 'DESIG_003', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  listDesignations,
  createDesignation,
  deleteDesignation,
};
