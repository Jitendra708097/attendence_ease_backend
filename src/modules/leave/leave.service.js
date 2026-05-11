const { Op } = require('sequelize');
const { Department, Employee, LeaveRequest } = require('../../models');
const { notifyOrgRoles, sendPush } = require('../notification/notification.service');

const DEFAULT_BALANCE_TYPES = ['annual', 'sick', 'casual', 'earned', 'optional'];

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getCurrentYearRange() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function mapLeaveTypeToBalanceKey(leaveType) {
  return String(leaveType || '').trim().toLowerCase();
}

function normalizeLeaveBalance(balance = {}) {
  return DEFAULT_BALANCE_TYPES.reduce((accumulator, type) => {
    accumulator[type] = Number(balance[type] || 0);
    return accumulator;
  }, {});
}

function calculateDaysCount({ fromDate, toDate, isHalfDay }) {
  if (isHalfDay) {
    return 0.5;
  }

  const start = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  return Math.max(Math.floor((end.getTime() - start.getTime()) / 86400000) + 1, 0);
}

function mapLeaveRequest(leave) {
  return {
    id: leave.id,
    employeeId: leave.emp_id,
    employeeName: leave.employee ? leave.employee.name : null,
    employeeCode: leave.employee ? leave.employee.emp_code : null,
    departmentId: leave.employee ? leave.employee.department_id : null,
    departmentName: leave.employee && leave.employee.department ? leave.employee.department.name : null,
    leaveType: leave.leave_type,
    fromDate: leave.from_date,
    toDate: leave.to_date,
    days: Number(leave.days_count || 0),
    daysCount: Number(leave.days_count || 0),
    isHalfDay: Boolean(leave.is_half_day),
    halfDayPeriod: leave.half_day_period,
    reason: leave.reason,
    status: leave.status,
    approverId: leave.approved_by || null,
    approverName: leave.approver ? leave.approver.name : null,
    approvedAt: leave.approved_at,
    rejectionReason: leave.rejection_reason,
    requestedDate: leave.created_at,
  };
}

function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function getEmployeeForOrg(orgId, empId) {
  const employee = await Employee.findOne({
    where: { id: empId, org_id: orgId, is_active: true },
  });

  if (!employee) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  return employee;
}

async function getLeaveBalance(orgId, empId) {
  const employee = await getEmployeeForOrg(orgId, empId);
  
  // ✅ FIX: Validate employee belongs to org
  if (employee.org_id !== orgId && employee.org_id.toString() !== orgId.toString()) {
    throw createError('HTTP_403', 'Access denied', 403);
  }
  
  const balance = normalizeLeaveBalance(employee.leave_balance || {});
  const { start, end } = getCurrentYearRange();

  const approvedLeaves = await LeaveRequest.findAll({
    where: {
      org_id: orgId,
      emp_id: empId,
      status: 'approved',
      from_date: { [Op.lte]: end },
      to_date: { [Op.gte]: start },
      deleted_at: null, // ✅ FIX: Respect soft deletes
    },
    attributes: ['leave_type', 'days_count'],
  });

  const usedByType = approvedLeaves.reduce((accumulator, leave) => {
    const key = mapLeaveTypeToBalanceKey(leave.leave_type);
    accumulator[key] = Number(accumulator[key] || 0) + Number(leave.days_count || 0);
    return accumulator;
  }, {});

  return Object.entries(balance).reduce((accumulator, [type, remaining]) => {
    const used = Number(usedByType[type] || 0);
    accumulator[type] = { total: remaining + used, used, remaining };
    return accumulator;
  }, {});
}

async function ensureNoOverlap(orgId, empId, fromDate, toDate) {
  const existing = await LeaveRequest.findOne({
    where: {
      org_id: orgId,
      emp_id: empId,
      status: { [Op.in]: ['pending', 'approved'] },
      from_date: { [Op.lte]: toDate },
      to_date: { [Op.gte]: fromDate },
    },
  });

  if (existing) {
    throw createError('LEAVE_002', 'Leave request overlaps with an existing leave record', 400);
  }
}

async function listOwnLeaves(orgId, empId, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const offset = (page - 1) * limit;

  const result = await LeaveRequest.findAndCountAll({
    where: { org_id: orgId, emp_id: empId },
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    requests: result.rows.map(mapLeaveRequest),
    hasMore: offset + result.rows.length < result.count,
    total: result.count,
    page,
  };
}

async function createLeaveRequest({ orgId, empId, body }) {
  const employee = await getEmployeeForOrg(orgId, empId);
  const leaveType = mapLeaveTypeToBalanceKey(body.leaveType || body.leave_type);
  const fromDate = body.fromDate || body.from_date;
  const toDate = body.toDate || body.to_date;
  const isHalfDay = Boolean(body.isHalfDay || body.is_half_day);
  const halfDayPeriod = body.halfDayPeriod || body.half_day_period || null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!leaveType || !fromDate || !toDate || !reason) {
    throw createError('LEAVE_001', 'Invalid leave request payload', 422);
  }

  if (new Date(`${fromDate}T00:00:00.000Z`) > new Date(`${toDate}T00:00:00.000Z`)) {
    throw createError('LEAVE_001', 'Leave end date must be after start date', 422);
  }

  await ensureNoOverlap(orgId, empId, fromDate, toDate);

  const daysCount = calculateDaysCount({ fromDate, toDate, isHalfDay });
  const balance = normalizeLeaveBalance(employee.leave_balance || {});
  const remaining = Number(balance[leaveType] || 0);

  if (remaining < daysCount) {
    throw createError('LEAVE_003', 'Insufficient leave balance', 400);
  }

  const leave = await LeaveRequest.create({
    org_id: orgId,
    emp_id: empId,
    leave_type: leaveType,
    from_date: fromDate,
    to_date: toDate,
    days_count: daysCount,
    is_half_day: isHalfDay,
    half_day_period: isHalfDay ? halfDayPeriod : null,
    reason,
    status: 'pending',
  });

  await notifyOrgRoles(
    orgId,
    ['admin'],
    {
      type: 'leave_request_submitted',
      title: 'New leave request',
      body: `${employee.name} requested ${leave.leave_type} leave from ${leave.from_date} to ${leave.to_date}.`,
      actionUrl: '/leaves',
      data: { leave_id: leave.id },
    },
    {
      excludeEmployeeIds: [empId],
    }
  );

  return mapLeaveRequest(leave);
}

async function listPendingLeaves(orgId, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const leaves = await LeaveRequest.findAll({
    where: { org_id: orgId, status: 'pending' },
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'name', 'leave_balance'] }],
    order: [['created_at', 'DESC']],
    limit,
  });

  return { leaves: leaves.map(mapLeaveRequest) };
}

function buildAdminLeaveWhere(orgId, query = {}) {
  const where = { org_id: orgId };
  const requestId = query.requestId || query.leaveId || query.id;
  const employeeId = query.employeeId || query.empId;
  const status = String(query.status || '').trim();
  const leaveType = String(query.type || query.leaveType || '').trim().toLowerCase();
  const dateFrom = query.dateFrom || query.fromDate || null;
  const dateTo = query.dateTo || query.toDate || null;

  if (requestId) {
    where.id = requestId;
    return where;
  }

  if (status) {
    where.status = status;
  }

  if (employeeId) {
    where.emp_id = employeeId;
  }

  if (leaveType) {
    where.leave_type = leaveType;
  }

  if (dateFrom && dateTo) {
    where.from_date = { [Op.lte]: dateTo };
    where.to_date = { [Op.gte]: dateFrom };
  } else if (dateFrom) {
    where.to_date = { [Op.gte]: dateFrom };
  } else if (dateTo) {
    where.from_date = { [Op.lte]: dateTo };
  }

  return where;
}

function buildAdminEmployeeInclude(query = {}) {
  const employeeWhere = {};
  const departmentId = query.departmentId || query.dept || null;
  const search = String(query.search || '').trim();

  if (departmentId) {
    employeeWhere.department_id = departmentId;
  }

  if (search) {
    employeeWhere[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { email: { [Op.iLike]: `%${search}%` } },
      { emp_code: { [Op.iLike]: `%${search}%` } },
    ];
  }

  return {
    model: Employee,
    as: 'employee',
    attributes: ['id', 'name', 'email', 'emp_code', 'department_id', 'leave_balance'],
    required: Boolean(departmentId || search),
    where: Object.keys(employeeWhere).length ? employeeWhere : undefined,
    include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
  };
}

function buildLeaveInclude(query = {}) {
  return [
    buildAdminEmployeeInclude(query),
    { model: Employee, as: 'approver', attributes: ['id', 'name', 'emp_code', 'email'], required: false },
  ];
}

async function listAdminLeaves(orgId, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const offset = (page - 1) * limit;
  const where = buildAdminLeaveWhere(orgId, query);
  const statsWhere = buildAdminLeaveWhere(orgId, { ...query, status: undefined });
  const include = buildLeaveInclude(query);

  const result = await LeaveRequest.findAndCountAll({
    where,
    include,
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  const statsRows = await LeaveRequest.findAll({
    where: statsWhere,
    include,
    attributes: ['status', 'days_count', 'from_date', 'to_date'],
  });

  const stats = ['pending', 'approved', 'rejected', 'cancelled'].reduce((accumulator, status) => {
    accumulator[status] = statsRows.filter((leave) => leave.status === status).length;
    return accumulator;
  }, {});
  const today = getTodayDate();
  stats.pendingDays = statsRows
    .filter((leave) => leave.status === 'pending')
    .reduce((total, leave) => total + Number(leave.days_count || 0), 0);
  stats.approvedDays = statsRows
    .filter((leave) => leave.status === 'approved')
    .reduce((total, leave) => total + Number(leave.days_count || 0), 0);
  stats.employeesOnLeaveToday = statsRows.filter(
    (leave) => leave.status === 'approved' && leave.from_date <= today && leave.to_date >= today
  ).length;
  stats.totalRequestedDays = statsRows.reduce((total, leave) => total + Number(leave.days_count || 0), 0);

  return {
    leaves: result.rows.map(mapLeaveRequest),
    stats,
    page,
    total: result.count,
    hasMore: offset + result.rows.length < result.count,
  };
}

async function getAdminLeaveDetail(orgId, leaveId) {
  const leave = await LeaveRequest.findOne({
    where: { id: leaveId, org_id: orgId },
    include: buildLeaveInclude(),
  });

  if (!leave) {
    throw createError('HTTP_404', 'Leave request not found', 404);
  }

  return { leave: mapLeaveRequest(leave) };
}

async function getAdminLeaveContext(orgId, leaveId) {
  const leave = await LeaveRequest.findOne({
    where: { id: leaveId, org_id: orgId },
    include: buildLeaveInclude(),
  });

  if (!leave) {
    throw createError('HTTP_404', 'Leave request not found', 404);
  }

  const employee = await getEmployeeForOrg(orgId, leave.emp_id);
  const [balance, overlaps, recentHistory] = await Promise.all([
    getLeaveBalance(orgId, leave.emp_id),
    LeaveRequest.findAll({
      where: {
        org_id: orgId,
        id: { [Op.ne]: leave.id },
        status: { [Op.in]: ['pending', 'approved'] },
        from_date: { [Op.lte]: leave.to_date },
        to_date: { [Op.gte]: leave.from_date },
      },
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: ['id', 'name', 'emp_code', 'department_id'],
          required: true,
          where: employee.department_id ? { department_id: employee.department_id } : undefined,
          include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
        },
      ],
      order: [['from_date', 'ASC']],
      limit: 10,
    }),
    LeaveRequest.findAll({
      where: {
        org_id: orgId,
        emp_id: leave.emp_id,
        id: { [Op.ne]: leave.id },
      },
      include: buildLeaveInclude(),
      order: [['created_at', 'DESC']],
      limit: 5,
    }),
  ]);

  return {
    leave: mapLeaveRequest(leave),
    balance,
    selectedBalance: balance[mapLeaveTypeToBalanceKey(leave.leave_type)] || null,
    overlaps: overlaps.map(mapLeaveRequest),
    recentHistory: recentHistory.map(mapLeaveRequest),
  };
}

async function listLeaveCalendar(orgId, query = {}) {
  const where = buildAdminLeaveWhere(orgId, {
    ...query,
    status: query.status || 'approved',
  });
  const leaves = await LeaveRequest.findAll({
    where,
    include: buildLeaveInclude(query),
    order: [['from_date', 'ASC']],
    limit: Math.min(Math.max(Number(query.limit || 500), 1), 1000),
  });

  return {
    leaves: leaves.map(mapLeaveRequest),
  };
}

async function listLeaveBalances(orgId, query = {}) {
  const where = {
    org_id: orgId,
    is_active: true,
    role: { [Op.in]: ['admin', 'manager', 'employee'] },
  };

  if (query.departmentId || query.dept) {
    where.department_id = query.departmentId || query.dept;
  }

  const employees = await Employee.findAll({
    where,
    attributes: ['id', 'name', 'emp_code', 'leave_balance', 'department_id'],
    include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
    order: [['name', 'ASC']],
  });

  return {
    balances: employees.map((employee) => ({
      employeeId: employee.id,
      employeeName: employee.name,
      employeeCode: employee.emp_code,
      departmentName: employee.department ? employee.department.name : null,
      balance: normalizeLeaveBalance(employee.leave_balance || {}),
    })),
  };
}

function listLeaveTypes() {
  return {
    types: DEFAULT_BALANCE_TYPES.map((type) => ({
      type,
      label: `${type.charAt(0).toUpperCase()}${type.slice(1)} Leave`,
      halfDayAllowed: true,
      paid: true,
      yearlyDefaultBalance: type === 'sick' ? 8 : type === 'optional' ? 2 : 12,
    })),
  };
}

async function approveLeave({ orgId, leaveId, approverId }) {
  const leave = await LeaveRequest.findOne({
    where: { id: leaveId, org_id: orgId, status: 'pending' },
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'name', 'leave_balance'] }],
  });

  if (!leave) {
    throw createError('HTTP_404', 'Leave request not found', 404);
  }

  const employee = await getEmployeeForOrg(orgId, leave.emp_id);
  const balanceKey = mapLeaveTypeToBalanceKey(leave.leave_type);
  const balance = normalizeLeaveBalance(employee.leave_balance || {});
  const daysCount = Number(leave.days_count || 0);

  if (Number(balance[balanceKey] || 0) < daysCount) {
    throw createError('LEAVE_003', 'Insufficient leave balance', 400);
  }

  balance[balanceKey] = Number(balance[balanceKey] || 0) - daysCount;

  await employee.update({ leave_balance: balance });
  await leave.update({
    status: 'approved',
    approved_by: approverId,
    approved_at: new Date(),
    rejection_reason: null,
  });

  await sendPush([leave.emp_id], {
    type: 'leave_approved',
    title: 'Leave approved',
    body: `${leave.leave_type} leave from ${leave.from_date} to ${leave.to_date} has been approved.`,
    actionUrl: `attendease://leave/${leave.id}`,
    data: { leave_id: leave.id },
  });

  return mapLeaveRequest(leave);
}

async function rejectLeave({ orgId, leaveId, approverId, rejectionReason }) {
  const leave = await LeaveRequest.findOne({
    where: { id: leaveId, org_id: orgId, status: 'pending' },
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'name'] }],
  });

  if (!leave) {
    throw createError('HTTP_404', 'Leave request not found', 404);
  }

  await leave.update({
    status: 'rejected',
    approved_by: approverId,
    approved_at: new Date(),
    rejection_reason: rejectionReason || null,
  });

  await sendPush([leave.emp_id], {
    type: 'leave_rejected',
    title: 'Leave rejected',
    body: rejectionReason || 'Your leave request has been rejected.',
    actionUrl: `attendease://leave/${leave.id}`,
    data: { leave_id: leave.id },
  });

  return mapLeaveRequest(leave);
}

async function cancelLeave({ orgId, empId, leaveId }) {
  const leave = await LeaveRequest.findOne({
    where: { id: leaveId, org_id: orgId, emp_id: empId, status: 'pending' },
  });

  if (!leave) {
    throw createError('HTTP_404', 'Leave request not found', 404);
  }

  await leave.update({ status: 'cancelled' });
  return { cancelled: true, id: leaveId };
}

module.exports = {
  getLeaveBalance,
  listOwnLeaves,
  listAdminLeaves,
  getAdminLeaveDetail,
  getAdminLeaveContext,
  listLeaveCalendar,
  listLeaveBalances,
  listLeaveTypes,
  createLeaveRequest,
  listPendingLeaves,
  approveLeave,
  rejectLeave,
  cancelLeave,
};
