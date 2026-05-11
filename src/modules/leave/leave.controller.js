const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const leaveService = require('./leave.service');

async function list(req, res) {
  try {
    const data = await leaveService.listOwnLeaves(req.org_id, req.employee.id, req.query);
    return ok(res, data, 'Leave requests fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function create(req, res) {
  try {
    const data = await leaveService.createLeaveRequest({
      orgId: req.org_id,
      empId: req.employee.id,
      body: req.body,
    });
    await log(req.employee, 'leave.create', { type: 'leave_request', id: data.id }, null, data, req);
    return ok(res, data, 'Leave request created', 201);
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function balance(req, res) {
  try {
    const data = await leaveService.getLeaveBalance(req.org_id, req.employee.id);
    return ok(res, data, 'Leave balance fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function pending(req, res) {
  try {
    const data = await leaveService.listPendingLeaves(req.org_id, req.query);
    return ok(res, data, 'Pending leave requests fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function adminList(req, res) {
  try {
    const data = await leaveService.listAdminLeaves(req.org_id, req.query);
    return ok(res, data, 'Leave requests fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function adminDetail(req, res) {
  try {
    const data = await leaveService.getAdminLeaveDetail(req.org_id, req.params.id);
    return ok(res, data, 'Leave request fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_007', error.message, error.details || [], error.statusCode || 400);
  }
}

async function adminContext(req, res) {
  try {
    const data = await leaveService.getAdminLeaveContext(req.org_id, req.params.id);
    return ok(res, data, 'Leave request context fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_008', error.message, error.details || [], error.statusCode || 400);
  }
}

async function calendar(req, res) {
  try {
    const data = await leaveService.listLeaveCalendar(req.org_id, req.query);
    return ok(res, data, 'Leave calendar fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_009', error.message, error.details || [], error.statusCode || 400);
  }
}

async function balances(req, res) {
  try {
    const data = await leaveService.listLeaveBalances(req.org_id, req.query);
    return ok(res, data, 'Leave balances fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function types(req, res) {
  try {
    return ok(res, leaveService.listLeaveTypes(), 'Leave types fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function approve(req, res) {
  try {
    const data = await leaveService.approveLeave({
      orgId: req.org_id,
      leaveId: req.params.id,
      approverId: req.employee.id,
    });
    await log(req.employee, 'leave.approve', { type: 'leave_request', id: data.id }, null, data, req);
    return ok(res, data, 'Leave request approved');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function reject(req, res) {
  try {
    const data = await leaveService.rejectLeave({
      orgId: req.org_id,
      leaveId: req.params.id,
      approverId: req.employee.id,
      rejectionReason: req.body.reason || req.body.note || req.body.rejectionReason || null,
    });
    await log(req.employee, 'leave.reject', { type: 'leave_request', id: data.id }, null, data, req);
    return ok(res, data, 'Leave request rejected');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_005', error.message, error.details || [], error.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    const data = await leaveService.cancelLeave({
      orgId: req.org_id,
      empId: req.employee.id,
      leaveId: req.params.id,
    });
    await log(req.employee, 'leave.cancel', { type: 'leave_request', id: req.params.id }, null, data, req);
    return ok(res, data, 'Leave request cancelled');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_006', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  list,
  create,
  balance,
  pending,
  adminList,
  adminDetail,
  adminContext,
  calendar,
  balances,
  types,
  approve,
  reject,
  remove,
};
