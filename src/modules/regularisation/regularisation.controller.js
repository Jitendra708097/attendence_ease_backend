const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const regularisationService = require('./regularisation.service');

async function create(req, res) {
  try {
    const data = await regularisationService.createRegularisation({
      orgId: req.org_id,
      empId: req.employee.id,
      body: req.body,
    });
    await log(req.employee, 'regularisation.create', { type: 'regularisation', id: data.id }, null, data, req);
    return ok(res, data, 'Regularisation request created', 201);
  } catch (error) {
    return fail(res, error.code || 'REG_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function pending(req, res) {
  try {
    const data = await regularisationService.listPendingRegularisations({
      orgId: req.org_id,
      role: req.employee.role,
      employeeId: req.employee.id,
      query: req.query,
    });
    return ok(res, data, 'Regularisation requests fetched');
  } catch (error) {
    return fail(res, error.code || 'REG_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function managerApprove(req, res) {
  try {
    const data = await regularisationService.managerApproveRegularisation({
      orgId: req.org_id,
      regularisationId: req.params.id,
      approverId: req.employee.id,
    });
    await log(req.employee, 'regularisation.manager_approve', { type: 'regularisation', id: data.id }, null, data, req);
    return ok(res, data, 'Regularisation request approved by manager');
  } catch (error) {
    return fail(res, error.code || 'REG_007', error.message, error.details || [], error.statusCode || 400);
  }
}

async function approve(req, res) {
  try {
    const data = await regularisationService.approveRegularisation({
      orgId: req.org_id,
      regularisationId: req.params.id,
      approverId: req.employee.id,
    });
    await log(req.employee, 'regularisation.approve', { type: 'regularisation', id: data.id }, null, data, req);
    return ok(res, data, 'Regularisation request approved');
  } catch (error) {
    return fail(res, error.code || 'REG_008', error.message, error.details || [], error.statusCode || 400);
  }
}

async function reject(req, res) {
  try {
    const data = await regularisationService.rejectRegularisation({
      orgId: req.org_id,
      regularisationId: req.params.id,
      approverId: req.employee.id,
      rejectionReason: req.body.reason || req.body.note || req.body.rejectionReason || null,
    });
    await log(req.employee, 'regularisation.reject', { type: 'regularisation', id: data.id }, null, data, req);
    return ok(res, data, 'Regularisation request rejected');
  } catch (error) {
    return fail(res, error.code || 'REG_009', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  create,
  pending,
  managerApprove,
  approve,
  reject,
};
