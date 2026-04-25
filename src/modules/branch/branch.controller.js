const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const branchService = require('./branch.service');

function validateBranchPayload(body = {}) {
  const details = [];

  if (!body.name) {
    details.push({ field: 'name', message: 'Branch name is required' });
  }

  return details;
}

function validatePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return [{ field: 'polygon', message: 'Polygon must contain at least 3 points' }];
  }

  return [];
}

async function listBranches(req, res) {
  const data = await branchService.listBranches(req.org_id);
  return ok(res, data, 'Branches fetched');
}

async function getBranch(req, res) {
  try {
    const data = await branchService.getBranchById(req.org_id, req.params.id);
    return ok(res, data, 'Branch fetched');
  } catch (error) {
    return fail(res, error.code || 'BRANCH_001', error.message, [], error.statusCode || 404);
  }
}

async function createBranch(req, res) {
  const details = validateBranchPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'BRANCH_002', 'Invalid branch payload', details, 422);
  }

  try {
    const data = await branchService.createBranch(req.org_id, req.body);
    await log(req.employee, 'branch.create', { type: 'branch', id: data.id }, null, data, req);
    return ok(res, data, 'Branch created', 201);
  } catch (error) {
    return fail(res, error.code || 'BRANCH_003', error.message, [], error.statusCode || 400);
  }
}

async function updateBranch(req, res) {
  const details = validateBranchPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'BRANCH_004', 'Invalid branch payload', details, 422);
  }

  try {
    const data = await branchService.updateBranch(req.org_id, req.params.id, req.body);
    await log(req.employee, 'branch.update', { type: 'branch', id: data.id }, null, data, req);
    return ok(res, data, 'Branch updated');
  } catch (error) {
    return fail(res, error.code || 'BRANCH_005', error.message, [], error.statusCode || 400);
  }
}

async function getGeofence(req, res) {
  try {
    const data = await branchService.getBranchById(req.org_id, req.params.id);
    return ok(res, { polygon: data.polygon || [] }, 'Geofence fetched');
  } catch (error) {
    return fail(res, error.code || 'BRANCH_006', error.message, [], error.statusCode || 404);
  }
}

async function updateGeofence(req, res) {
  const details = validatePolygon(req.body.polygon);

  if (details.length > 0) {
    return fail(res, 'BRANCH_007', 'Invalid geofence payload', details, 422);
  }

  try {
    const data = await branchService.updateGeofence(req.org_id, req.params.id, req.body.polygon);
    await log(req.employee, 'branch.update_geofence', { type: 'branch', id: data.id }, null, { polygon: data.polygon }, req);
    return ok(res, data, 'Geofence updated');
  } catch (error) {
    return fail(res, error.code || 'BRANCH_008', error.message, [], error.statusCode || 400);
  }
}

async function deleteBranch(req, res) {
  try {
    await branchService.deleteBranch(req.org_id, req.params.id);
    await log(req.employee, 'branch.delete', { type: 'branch', id: req.params.id }, null, null, req);
    return ok(res, { id: req.params.id }, 'Branch deleted');
  } catch (error) {
    return fail(res, error.code || 'BRANCH_009', error.message, [], error.statusCode || 404);
  }
}

/**
 * Get current employee's branch geofence
 * Used by mobile app to fetch premise boundary polygon
 */
async function getCurrentBranchGeofence(req, res) {
  try {
    const employee = req.employee;
    if (!employee?.branch_id) {
      return fail(res, 'BRANCH_010', 'Employee has no assigned branch', [], 404);
    }

    const branch = await branchService.getBranchById(req.org_id, employee.branch_id);
    if (!branch) {
      return fail(res, 'BRANCH_011', 'Branch not found', [], 404);
    }

    return ok(res, branch, 'Current branch geofence fetched');
  } catch (error) {
    return fail(res, error.code || 'BRANCH_012', error.message, [], error.statusCode || 400);
  }
}

module.exports = {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  getGeofence,
  updateGeofence,
  deleteBranch,
  getCurrentBranchGeofence,
};
