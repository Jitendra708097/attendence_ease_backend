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
    return ok(res, await leaveService.listLeaveTypes(req.org_id), 'Leave types fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function upsertType(req, res) {
  try {
    const data = await leaveService.upsertLeaveType({ orgId: req.org_id, body: req.body });
    await log(req.employee, 'leave_type.upsert', { type: 'leave_type', id: data.type.id }, null, data, req);
    return ok(res, data, 'Leave type saved');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_026', error.message, error.details || [], error.statusCode || 400);
  }
}

async function policies(req, res) {
  try {
    const data = await leaveService.listLeavePolicies(req.org_id);
    return ok(res, data, 'Leave policies fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_031', error.message, error.details || [], error.statusCode || 400);
  }
}

async function upsertPolicy(req, res) {
  try {
    const data = await leaveService.upsertLeavePolicy({
      orgId: req.org_id,
      body: { ...req.body, id: req.params.id || req.body.id },
    });
    await log(req.employee, 'leave_policy.upsert', { type: 'leave_policy', id: data.policy.id }, null, data, req);
    return ok(res, data, 'Leave policy saved');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_031', error.message, error.details || [], error.statusCode || 400);
  }
}

async function preview(req, res) {
  try {
    const data = await leaveService.validateLeavePayload({
      orgId: req.org_id,
      empId: req.employee.id,
      body: req.body,
    });
    return ok(
      res,
      {
        leaveType: data.leaveType.code,
        leaveTypeName: data.leaveType.name,
        days: data.daysCount,
        balanceBefore: data.balanceBefore,
        balanceAfter: Number((data.balanceBefore - data.daysCount).toFixed(2)),
        policy: data.policySnapshot,
        validation: data.validationSnapshot,
      },
      'Leave request validated'
    );
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
      notes: req.body.note || req.body.notes || null,
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
      actorId: req.employee.id,
      reason: req.body?.reason || req.body?.note || null,
    });
    await log(req.employee, 'leave.cancel', { type: 'leave_request', id: req.params.id }, null, data, req);
    return ok(res, data, 'Leave request cancelled');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function approveCancellation(req, res) {
  try {
    const data = await leaveService.approveCancellation({
      orgId: req.org_id,
      leaveId: req.params.id,
      approverId: req.employee.id,
      reason: req.body.reason || req.body.note || null,
    });
    await log(req.employee, 'leave.cancel_approve', { type: 'leave_request', id: req.params.id }, null, data, req);
    return ok(res, data, 'Leave cancellation approved');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_028', error.message, error.details || [], error.statusCode || 400);
  }
}

async function adjustBalance(req, res) {
  try {
    const data = await leaveService.adjustLeaveBalance({
      orgId: req.org_id,
      empId: req.body.employeeId || req.body.empId || req.params.employeeId,
      leaveType: req.body.leaveType || req.body.type,
      days: req.body.days,
      actorId: req.employee.id,
      reason: req.body.reason || req.body.note,
    });
    await log(req.employee, 'leave_balance.adjust', { type: 'employee', id: data.employeeId }, null, data, req);
    return ok(res, data, 'Leave balance adjusted');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_025', error.message, error.details || [], error.statusCode || 400);
  }
}

async function ledger(req, res) {
  try {
    const data = await leaveService.listLedger(req.org_id, req.query);
    return ok(res, data, 'Leave ledger fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_029', error.message, error.details || [], error.statusCode || 400);
  }
}

async function payrollReport(req, res) {
  try {
    const data = await leaveService.getPayrollReport(req.org_id, req.query);
    return ok(res, data, 'Leave payroll report fetched');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_030', error.message, error.details || [], error.statusCode || 400);
  }
}

async function payrollLock(req, res) {
  try {
    const data = await leaveService.setPayrollLock({
      orgId: req.org_id,
      actorId: req.employee.id,
      body: req.body,
    });
    await log(req.employee, 'leave.payroll_lock', { type: 'payroll_lock', id: data.lock.id }, null, data, req);
    return ok(res, data, 'Payroll lock saved');
  } catch (error) {
    return fail(res, error.code || 'LEAVE_027', error.message, error.details || [], error.statusCode || 400);
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
  upsertType,
  policies,
  upsertPolicy,
  preview,
  approve,
  reject,
  remove,
  approveCancellation,
  adjustBalance,
  ledger,
  payrollReport,
  payrollLock,
};
