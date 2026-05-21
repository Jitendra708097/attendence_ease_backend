const { Op } = require('sequelize');
const {
  Attendance,
  Department,
  Employee,
  Holiday,
  LeaveApprovalWorkflow,
  LeaveBalanceLedger,
  LeavePolicy,
  LeaveRequest,
  LeaveType,
  PayrollLock,
  Shift,
  sequelize,
} = require('../../models');
const { notifyOrgRoles, sendPush } = require('../notification/notification.service');

const DEFAULT_BALANCE_TYPES = ['annual', 'sick', 'casual', 'earned', 'optional', 'unpaid', 'comp_off'];
const DEFAULT_TYPE_CONFIG = {
  annual: { label: 'Annual Leave', yearlyDefaultBalance: 12, noticeDays: 7, paid: true },
  sick: { label: 'Sick Leave', yearlyDefaultBalance: 8, noticeDays: 0, paid: true, requiresDocumentAfterDays: 2 },
  casual: { label: 'Casual Leave', yearlyDefaultBalance: 12, noticeDays: 1, paid: true, maxConsecutiveDays: 3 },
  earned: { label: 'Earned Leave', yearlyDefaultBalance: 12, noticeDays: 7, paid: true },
  optional: { label: 'Optional Leave', yearlyDefaultBalance: 2, noticeDays: 3, paid: true },
  unpaid: { label: 'Unpaid Leave', yearlyDefaultBalance: 0, noticeDays: 0, paid: false, allowNegativeBalance: true },
  comp_off: { label: 'Comp Off', yearlyDefaultBalance: 0, noticeDays: 0, paid: true },
};

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

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10);
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function getDateRange(fromDate, toDate) {
  const dates = [];
  for (let current = dateOnly(fromDate); current && current <= toDate; current = addDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function getYearStart() {
  return `${new Date().getUTCFullYear()}-01-01`;
}

function normalizeLeaveBalance(balance = {}) {
  const normalized = Object.entries(balance || {}).reduce((accumulator, [type, value]) => {
    accumulator[mapLeaveTypeToBalanceKey(type)] = Number(value || 0);
    return accumulator;
  }, {});

  return DEFAULT_BALANCE_TYPES.reduce((accumulator, type) => {
    accumulator[type] = Number(balance[type] || 0);
    return accumulator;
  }, normalized);
}

async function ensureDefaultLeaveSetup(orgId, transaction = null) {
  const existingTypeCount = await LeaveType.count({ where: { org_id: orgId }, transaction });
  if (existingTypeCount === 0) {
    await LeaveType.bulkCreate(
      DEFAULT_BALANCE_TYPES.map((type, index) => {
        const config = DEFAULT_TYPE_CONFIG[type];
        return {
          org_id: orgId,
          code: type,
          name: config.label,
          yearly_default_balance: config.yearlyDefaultBalance,
          is_paid: config.paid,
          half_day_allowed: true,
          allow_negative_balance: Boolean(config.allowNegativeBalance),
          notice_days: config.noticeDays,
          max_consecutive_days: config.maxConsecutiveDays || null,
          requires_document_after_days: config.requiresDocumentAfterDays || null,
          sort_order: index,
        };
      }),
      { transaction }
    );
  }

  const workflow = await LeaveApprovalWorkflow.findOne({
    where: { org_id: orgId, is_default: true, is_active: true },
    transaction,
  });

  const defaultWorkflow = workflow || await LeaveApprovalWorkflow.create(
    {
      org_id: orgId,
      name: 'Default Leave Approval',
      levels: [
        { level: 1, role: 'manager', scope: 'department' },
        { level: 2, role: 'admin', scope: 'org' },
      ],
      is_default: true,
      is_active: true,
    },
    { transaction }
  );

  const existingPolicy = await LeavePolicy.findOne({
    where: { org_id: orgId, is_default: true, is_active: true },
    transaction,
  });

  if (!existingPolicy) {
    await LeavePolicy.create(
      {
        org_id: orgId,
        name: 'Default Leave Policy',
        scope_type: 'org',
        effective_from: getYearStart(),
        entitlements: DEFAULT_BALANCE_TYPES.reduce((accumulator, type) => {
          accumulator[type] = DEFAULT_TYPE_CONFIG[type].yearlyDefaultBalance;
          return accumulator;
        }, {}),
        approval_workflow_id: defaultWorkflow.id,
        is_default: true,
        is_active: true,
      },
      { transaction }
    );
  }
}

function calculateCalendarDays({ fromDate, toDate, isHalfDay }) {
  if (isHalfDay) {
    return 0.5;
  }

  const start = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  return Math.max(Math.floor((end.getTime() - start.getTime()) / 86400000) + 1, 0);
}

async function getLeaveTypeRecord(orgId, leaveType, transaction = null) {
  await ensureDefaultLeaveSetup(orgId, transaction);
  const code = mapLeaveTypeToBalanceKey(leaveType);
  const record = await LeaveType.findOne({
    where: { org_id: orgId, code, is_active: true },
    transaction,
  });

  if (!record) {
    throw createError('LEAVE_010', 'Invalid leave type for this organisation', 422);
  }

  return record;
}

async function getEffectiveLeavePolicy(orgId, employee, date, transaction = null) {
  await ensureDefaultLeaveSetup(orgId, transaction);
  const lookupDate = date || getTodayDate();
  const scopeCandidates = [
    { scope_type: 'employee', scope_id: employee.id },
    { scope_type: 'department', scope_id: employee.department_id },
    { scope_type: 'branch', scope_id: employee.branch_id },
    { scope_type: 'org', scope_id: null },
  ].filter((item) => item.scope_type === 'org' || item.scope_id);

  for (const candidate of scopeCandidates) {
    const policy = await LeavePolicy.findOne({
      where: {
        org_id: orgId,
        is_active: true,
        scope_type: candidate.scope_type,
        ...(candidate.scope_id ? { scope_id: candidate.scope_id } : {}),
        effective_from: { [Op.lte]: lookupDate },
        [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: lookupDate } }],
      },
      include: [{ model: LeaveApprovalWorkflow, as: 'approvalWorkflow', required: false }],
      order: [['created_at', 'DESC']],
      transaction,
    });

    if (policy) {
      return policy;
    }
  }

  return LeavePolicy.findOne({
    where: { org_id: orgId, is_default: true, is_active: true },
    include: [{ model: LeaveApprovalWorkflow, as: 'approvalWorkflow', required: false }],
    transaction,
  });
}

async function countPolicyDays({ orgId, employee, leaveType, fromDate, toDate, isHalfDay, transaction = null }) {
  if (isHalfDay) {
    return 0.5;
  }

  const dates = getDateRange(fromDate, toDate);
  const holidayRows = leaveType.include_holidays ? [] : await Holiday.findAll({
    where: {
      org_id: orgId,
      date: { [Op.in]: dates },
      [Op.or]: [{ branch_id: null }, { branch_id: employee.branch_id }],
    },
    attributes: ['date'],
    transaction,
  });
  const holidays = new Set(holidayRows.map((holiday) => holiday.date));
  const shift = await Shift.findOne({ where: { id: employee.shift_id, org_id: orgId }, transaction });
  const workDays = Array.isArray(shift?.work_days) && shift.work_days.length > 0
    ? new Set(shift.work_days)
    : new Set([1, 2, 3, 4, 5]);

  return dates.reduce((total, date) => {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const normalizedWeekday = weekday === 0 ? 7 : weekday;
    const isWeekend = !workDays.has(normalizedWeekday);

    if (!leaveType.include_weekends && isWeekend) return total;
    if (!leaveType.include_holidays && holidays.has(date)) return total;
    return total + 1;
  }, 0);
}

async function isPayrollLocked(orgId, fromDate, toDate, transaction = null) {
  const lock = await PayrollLock.findOne({
    where: {
      org_id: orgId,
      status: 'locked',
      period_start: { [Op.lte]: toDate },
      period_end: { [Op.gte]: fromDate },
    },
    transaction,
  });

  return Boolean(lock);
}

function buildPolicySnapshot(policy, leaveType) {
  return {
    policyId: policy?.id || null,
    policyName: policy?.name || null,
    workflowId: policy?.approval_workflow_id || null,
    leaveTypeId: leaveType.id,
    leaveType: leaveType.code,
    halfDayAllowed: leaveType.half_day_allowed,
    includeWeekends: leaveType.include_weekends,
    includeHolidays: leaveType.include_holidays,
    allowNegativeBalance: leaveType.allow_negative_balance,
    maxNegativeBalance: toNumber(leaveType.max_negative_balance),
    paid: leaveType.is_paid,
  };
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
    leaveTypeId: leave.leave_type_id || null,
    leaveTypeName: leave.leaveTypeRecord ? leave.leaveTypeRecord.name : leave.leave_type,
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
    managerApproverId: leave.manager_approved_by || null,
    managerApproverName: leave.managerApprover ? leave.managerApprover.name : null,
    finalApproverId: leave.final_approved_by || null,
    finalApproverName: leave.finalApprover ? leave.finalApprover.name : null,
    approvalLevel: Number(leave.approval_level || 1),
    approvalNotes: leave.approval_notes,
    approvedAt: leave.approved_at,
    rejectionReason: leave.rejection_reason,
    documentUrl: leave.document_url,
    cancellationReason: leave.cancellation_reason,
    cancellationRequestedBy: leave.cancellation_requested_by || null,
    cancellationRequestedAt: leave.cancellation_requested_at,
    cancellationApprovedBy: leave.cancellation_approved_by || null,
    cancellationApprovedAt: leave.cancellation_approved_at,
    payrollLocked: Boolean(leave.payroll_locked),
    payrollPeriod: leave.payroll_period || null,
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

async function recordLedgerEntry({
  orgId,
  empId,
  leaveTypeRecord,
  leaveType,
  transactionType,
  days,
  balanceAfter,
  requestId = null,
  actorId = null,
  reason = null,
  effectiveDate = null,
  metadata = {},
  transaction = null,
}) {
  return LeaveBalanceLedger.create(
    {
      org_id: orgId,
      emp_id: empId,
      leave_type_id: leaveTypeRecord?.id || null,
      leave_type: leaveTypeRecord?.code || mapLeaveTypeToBalanceKey(leaveType),
      transaction_type: transactionType,
      days,
      balance_after: balanceAfter,
      request_id: requestId,
      actor_id: actorId,
      reason,
      effective_date: effectiveDate || getTodayDate(),
      metadata,
    },
    { transaction }
  );
}

async function applyBalanceDelta({
  orgId,
  empId,
  leaveTypeRecord,
  delta,
  transactionType,
  requestId = null,
  actorId = null,
  reason = null,
  effectiveDate = null,
  metadata = {},
  transaction,
}) {
  const employee = await Employee.findOne({
    where: { id: empId, org_id: orgId, is_active: true },
    lock: transaction ? true : undefined,
    transaction,
  });

  if (!employee) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  const balance = normalizeLeaveBalance(employee.leave_balance || {});
  const key = leaveTypeRecord.code;
  const nextBalance = Number((toNumber(balance[key]) + Number(delta)).toFixed(2));
  balance[key] = nextBalance;

  await employee.update({ leave_balance: balance }, { transaction });
  await recordLedgerEntry({
    orgId,
    empId,
    leaveTypeRecord,
    transactionType,
    days: Number(delta),
    balanceAfter: nextBalance,
    requestId,
    actorId,
    reason,
    effectiveDate,
    metadata,
    transaction,
  });

  return { employee, balance, remaining: nextBalance };
}

async function seedOpeningLedgerIfMissing(orgId, employee, transaction = null) {
  const existing = await LeaveBalanceLedger.count({
    where: { org_id: orgId, emp_id: employee.id },
    transaction,
  });

  if (existing > 0) {
    return;
  }

  await ensureDefaultLeaveSetup(orgId, transaction);
  const leaveTypes = await LeaveType.findAll({ where: { org_id: orgId }, transaction });
  const leaveTypeByCode = leaveTypes.reduce((accumulator, item) => {
    accumulator[item.code] = item;
    return accumulator;
  }, {});
  const balance = normalizeLeaveBalance(employee.leave_balance || {});

  for (const [type, value] of Object.entries(balance)) {
    if (Number(value || 0) !== 0) {
      await recordLedgerEntry({
        orgId,
        empId: employee.id,
        leaveTypeRecord: leaveTypeByCode[type] || null,
        leaveType: type,
        transactionType: 'opening',
        days: value,
        balanceAfter: value,
        reason: 'Opening balance',
        effectiveDate: getTodayDate(),
        metadata: { source: 'employee.leave_balance' },
        transaction,
      });
    }
  }
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
    { model: Employee, as: 'managerApprover', attributes: ['id', 'name', 'emp_code', 'email'], required: false },
    { model: Employee, as: 'finalApprover', attributes: ['id', 'name', 'emp_code', 'email'], required: false },
    { model: LeaveType, as: 'leaveTypeRecord', attributes: ['id', 'code', 'name', 'is_paid', 'half_day_allowed'], required: false },
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

async function getLeaveBalance(orgId, empId) {
  const employee = await getEmployeeForOrg(orgId, empId);
  await ensureDefaultLeaveSetup(orgId);
  await seedOpeningLedgerIfMissing(orgId, employee);

  const leaveTypes = await LeaveType.findAll({
    where: { org_id: orgId, is_active: true },
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });
  const balance = normalizeLeaveBalance(employee.leave_balance || {});
  const { start, end } = getCurrentYearRange();
  const approvedLeaves = await LeaveRequest.findAll({
    where: {
      org_id: orgId,
      emp_id: empId,
      status: 'approved',
      from_date: { [Op.lte]: end },
      to_date: { [Op.gte]: start },
    },
    attributes: ['leave_type', 'days_count'],
  });
  const usedByType = approvedLeaves.reduce((accumulator, leave) => {
    const key = mapLeaveTypeToBalanceKey(leave.leave_type);
    accumulator[key] = Number(accumulator[key] || 0) + Number(leave.days_count || 0);
    return accumulator;
  }, {});

  return leaveTypes.reduce((accumulator, leaveType) => {
    const type = leaveType.code;
    const remaining = Number(balance[type] || 0);
    const used = Number(usedByType[type] || 0);
    accumulator[type] = {
      leaveTypeId: leaveType.id,
      label: leaveType.name,
      paid: leaveType.is_paid,
      halfDayAllowed: leaveType.half_day_allowed,
      total: Number((remaining + used).toFixed(2)),
      used,
      remaining,
    };
    return accumulator;
  }, {});
}

async function validateLeavePayload({ orgId, empId, body, transaction = null }) {
  const employee = await getEmployeeForOrg(orgId, empId);
  const leaveType = await getLeaveTypeRecord(orgId, body.leaveType || body.leave_type, transaction);
  const policy = await getEffectiveLeavePolicy(orgId, employee, body.fromDate || body.from_date, transaction);
  const fromDate = dateOnly(body.fromDate || body.from_date);
  const toDate = dateOnly(body.toDate || body.to_date);
  const isHalfDay = Boolean(body.isHalfDay || body.is_half_day);
  const halfDayPeriod = body.halfDayPeriod || body.half_day_period || null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const documentUrl = body.documentUrl || body.document_url || null;

  if (!fromDate || !toDate || !reason) {
    throw createError('LEAVE_001', 'Invalid leave request payload', 422);
  }

  if (fromDate > toDate) {
    throw createError('LEAVE_001', 'Leave end date must be after start date', 422);
  }

  if (isHalfDay && fromDate !== toDate) {
    throw createError('LEAVE_011', 'Half-day leave must be for a single date', 422);
  }

  if (isHalfDay && !leaveType.half_day_allowed) {
    throw createError('LEAVE_012', 'Half-day leave is not allowed for this leave type', 422);
  }

  if (isHalfDay && !['morning', 'afternoon'].includes(halfDayPeriod)) {
    throw createError('LEAVE_013', 'Half-day period must be morning or afternoon', 422);
  }

  const daysCount = await countPolicyDays({
    orgId,
    employee,
    leaveType,
    fromDate,
    toDate,
    isHalfDay,
    transaction,
  });

  if (daysCount <= 0) {
    throw createError('LEAVE_014', 'Selected dates do not include working leave days', 422);
  }

  if (toNumber(leaveType.min_request_days) && daysCount < toNumber(leaveType.min_request_days)) {
    throw createError('LEAVE_015', `Minimum request duration is ${leaveType.min_request_days} day(s)`, 422);
  }

  if (leaveType.max_request_days && daysCount > toNumber(leaveType.max_request_days)) {
    throw createError('LEAVE_016', `Maximum request duration is ${leaveType.max_request_days} day(s)`, 422);
  }

  if (leaveType.max_consecutive_days && calculateCalendarDays({ fromDate, toDate }) > leaveType.max_consecutive_days) {
    throw createError('LEAVE_017', `Leave cannot exceed ${leaveType.max_consecutive_days} consecutive day(s)`, 422);
  }

  const today = getTodayDate();
  const noticeDays = toNumber(leaveType.notice_days);
  if (noticeDays > 0 && fromDate < addDays(today, noticeDays)) {
    throw createError('LEAVE_018', `${leaveType.name} requires ${noticeDays} day(s) advance notice`, 422);
  }

  if (leaveType.requires_document_after_days && daysCount > toNumber(leaveType.requires_document_after_days) && !documentUrl) {
    throw createError('LEAVE_019', 'Supporting document is required for this leave request', 422);
  }

  await ensureNoOverlap(orgId, empId, fromDate, toDate);

  const balance = normalizeLeaveBalance(employee.leave_balance || {});
  const remaining = Number(balance[leaveType.code] || 0);
  const floor = leaveType.allow_negative_balance ? -Math.abs(toNumber(leaveType.max_negative_balance)) : 0;
  if (remaining - daysCount < floor) {
    throw createError('LEAVE_003', 'Insufficient leave balance', 400);
  }

  return {
    employee,
    leaveType,
    policy,
    fromDate,
    toDate,
    isHalfDay,
    halfDayPeriod,
    reason,
    documentUrl,
    daysCount,
    balanceBefore: remaining,
    policySnapshot: buildPolicySnapshot(policy, leaveType),
    validationSnapshot: {
      calendarDays: calculateCalendarDays({ fromDate, toDate, isHalfDay }),
      workingDays: daysCount,
      validatedAt: new Date().toISOString(),
    },
  };
}

async function createLeaveRequest({ orgId, empId, body }) {
  return sequelize.transaction(async (transaction) => {
    const payload = await validateLeavePayload({ orgId, empId, body, transaction });
    const leave = await LeaveRequest.create(
      {
        org_id: orgId,
        emp_id: empId,
        leave_type_id: payload.leaveType.id,
        leave_type: payload.leaveType.code,
        from_date: payload.fromDate,
        to_date: payload.toDate,
        days_count: payload.daysCount,
        is_half_day: payload.isHalfDay,
        half_day_period: payload.isHalfDay ? payload.halfDayPeriod : null,
        reason: payload.reason,
        document_url: payload.documentUrl,
        status: 'pending',
        approval_level: 1,
        policy_snapshot: payload.policySnapshot,
        validation_snapshot: payload.validationSnapshot,
      },
      { transaction }
    );

    await notifyOrgRoles(
      orgId,
      ['admin', 'manager'],
      {
        type: 'leave_request_submitted',
        title: 'New leave request',
        body: `${payload.employee.name} requested ${payload.leaveType.name} from ${leave.from_date} to ${leave.to_date}.`,
        actionUrl: '/leaves',
        data: { leave_id: leave.id },
      },
      { excludeEmployeeIds: [empId] }
    );

    leave.employee = payload.employee;
    leave.leaveTypeRecord = payload.leaveType;
    return mapLeaveRequest(leave);
  });
}

async function assertApproverCanAct({ orgId, approver, leave, action }) {
  if (approver.id === leave.emp_id) {
    throw createError('LEAVE_020', 'Employees cannot approve or reject their own leave', 403);
  }

  if (['admin', 'superadmin'].includes(approver.role)) {
    return 'final';
  }

  if (approver.role !== 'manager') {
    throw createError('AUTH_003', 'Insufficient permissions', 403);
  }

  const employee = leave.employee || await getEmployeeForOrg(orgId, leave.emp_id);
  if (!employee.department_id || employee.department_id !== approver.department_id) {
    throw createError('LEAVE_021', 'Manager can only review leave for employees in their department', 403);
  }

  if (action === 'final') {
    throw createError('LEAVE_022', 'Manager approval requires admin final approval', 403);
  }

  return 'manager';
}

async function recomputeAttendanceForLeave(leave, transaction = null) {
  const attendanceService = require('../attendance/attendance.service');
  if (typeof attendanceService.recomputeLeaveAttendance === 'function') {
    await attendanceService.recomputeLeaveAttendance({
      orgId: leave.org_id,
      empId: leave.emp_id,
      fromDate: leave.from_date,
      toDate: leave.to_date,
      transaction,
    });
  }
}

async function approveLeave({ orgId, leaveId, approverId, notes = null }) {
  return sequelize.transaction(async (transaction) => {
    const leave = await LeaveRequest.findOne({
      where: { id: leaveId, org_id: orgId, status: { [Op.in]: ['pending', 'manager_approved'] } },
      include: buildLeaveInclude(),
      lock: true,
      transaction,
    });

    if (!leave) {
      throw createError('HTTP_404', 'Leave request not found', 404);
    }

    if (await isPayrollLocked(orgId, leave.from_date, leave.to_date, transaction)) {
      throw createError('LEAVE_023', 'Leave dates fall inside a locked payroll period', 423);
    }

    const approver = await getEmployeeForOrg(orgId, approverId);
    const approvalMode = await assertApproverCanAct({ orgId, approver, leave, action: leave.status === 'pending' ? 'manager' : 'final' });

    if (approvalMode === 'manager' && leave.status === 'pending') {
      await leave.update(
        {
          status: 'manager_approved',
          approval_level: 2,
          manager_approved_by: approverId,
          manager_approved_at: new Date(),
          approval_notes: notes || leave.approval_notes,
        },
        { transaction }
      );
      return mapLeaveRequest(leave);
    }

    const leaveType = leave.leaveTypeRecord || await getLeaveTypeRecord(orgId, leave.leave_type, transaction);
    const employee = await Employee.findOne({
      where: { id: leave.emp_id, org_id: orgId, is_active: true },
      lock: true,
      transaction,
    });
    const balance = normalizeLeaveBalance(employee.leave_balance || {});
    const daysCount = Number(leave.days_count || 0);
    const floor = leaveType.allow_negative_balance ? -Math.abs(toNumber(leaveType.max_negative_balance)) : 0;

    if (Number(balance[leaveType.code] || 0) - daysCount < floor) {
      throw createError('LEAVE_003', 'Insufficient leave balance', 400);
    }

    await applyBalanceDelta({
      orgId,
      empId: leave.emp_id,
      leaveTypeRecord: leaveType,
      delta: -daysCount,
      transactionType: 'debit',
      requestId: leave.id,
      actorId: approverId,
      reason: 'Leave approved',
      effectiveDate: leave.from_date,
      transaction,
    });

    await leave.update(
      {
        status: 'approved',
        approval_level: 99,
        approved_by: approverId,
        approved_at: new Date(),
        final_approved_by: approverId,
        final_approved_at: new Date(),
        rejection_reason: null,
        approval_notes: notes || leave.approval_notes,
      },
      { transaction }
    );

    await recomputeAttendanceForLeave(leave, transaction);
    await sendPush([leave.emp_id], {
      type: 'leave_approved',
      title: 'Leave approved',
      body: `${leave.leave_type} leave from ${leave.from_date} to ${leave.to_date} has been approved.`,
      actionUrl: `attendease://leave/${leave.id}`,
      data: { leave_id: leave.id },
    });

    return mapLeaveRequest(leave);
  });
}

async function rejectLeave({ orgId, leaveId, approverId, rejectionReason }) {
  if (!rejectionReason || !String(rejectionReason).trim()) {
    throw createError('LEAVE_024', 'Rejection reason is required', 422);
  }

  return sequelize.transaction(async (transaction) => {
    const leave = await LeaveRequest.findOne({
      where: { id: leaveId, org_id: orgId, status: { [Op.in]: ['pending', 'manager_approved', 'cancellation_pending'] } },
      include: buildLeaveInclude(),
      lock: true,
      transaction,
    });

    if (!leave) {
      throw createError('HTTP_404', 'Leave request not found', 404);
    }

    const approver = await getEmployeeForOrg(orgId, approverId);
    await assertApproverCanAct({ orgId, approver, leave, action: 'reject' });

    if (leave.status === 'cancellation_pending') {
      await leave.update(
        {
          status: 'approved',
          rejection_reason: rejectionReason,
          cancellation_reason: null,
          cancellation_requested_by: null,
          cancellation_requested_at: null,
        },
        { transaction }
      );
      return mapLeaveRequest(leave);
    }

    await leave.update(
      {
        status: 'rejected',
        approved_by: approverId,
        approved_at: new Date(),
        rejection_reason: rejectionReason,
      },
      { transaction }
    );

    await sendPush([leave.emp_id], {
      type: 'leave_rejected',
      title: 'Leave rejected',
      body: rejectionReason,
      actionUrl: `attendease://leave/${leave.id}`,
      data: { leave_id: leave.id },
    });

    return mapLeaveRequest(leave);
  });
}

async function cancelLeave({ orgId, empId, leaveId, actorId = null, reason = null, approveNow = false }) {
  return sequelize.transaction(async (transaction) => {
    const leave = await LeaveRequest.findOne({
      where: { id: leaveId, org_id: orgId, emp_id: empId, status: { [Op.in]: ['pending', 'approved'] } },
      include: buildLeaveInclude(),
      lock: true,
      transaction,
    });

    if (!leave) {
      throw createError('HTTP_404', 'Leave request not found', 404);
    }

    if (leave.status === 'pending') {
      await leave.update({ status: 'cancelled', cancellation_reason: reason || null }, { transaction });
      return { cancelled: true, id: leaveId, status: 'cancelled' };
    }

    if (await isPayrollLocked(orgId, leave.from_date, leave.to_date, transaction)) {
      throw createError('LEAVE_023', 'Leave dates fall inside a locked payroll period', 423);
    }

    if (!approveNow) {
      await leave.update(
        {
          status: 'cancellation_pending',
          cancellation_reason: reason || null,
          cancellation_requested_by: actorId || empId,
          cancellation_requested_at: new Date(),
        },
        { transaction }
      );
      return { cancelled: false, id: leaveId, status: 'cancellation_pending' };
    }

    const leaveType = leave.leaveTypeRecord || await getLeaveTypeRecord(orgId, leave.leave_type, transaction);
    await applyBalanceDelta({
      orgId,
      empId: leave.emp_id,
      leaveTypeRecord: leaveType,
      delta: Number(leave.days_count || 0),
      transactionType: 'refund',
      requestId: leave.id,
      actorId: actorId || empId,
      reason: reason || 'Approved leave cancelled',
      effectiveDate: getTodayDate(),
      transaction,
    });

    await leave.update(
      {
        status: 'cancelled',
        cancellation_reason: reason || null,
        cancellation_approved_by: actorId || empId,
        cancellation_approved_at: new Date(),
      },
      { transaction }
    );
    await recomputeAttendanceForLeave(leave, transaction);
    return { cancelled: true, id: leaveId, status: 'cancelled' };
  });
}

async function approveCancellation({ orgId, leaveId, approverId, reason = null }) {
  const leave = await LeaveRequest.findOne({
    where: { id: leaveId, org_id: orgId, status: 'cancellation_pending' },
    include: buildLeaveInclude(),
  });

  if (!leave) {
    throw createError('HTTP_404', 'Leave request not found', 404);
  }

  const approver = await getEmployeeForOrg(orgId, approverId);
  await assertApproverCanAct({ orgId, approver, leave, action: 'final' });
  return cancelLeave({
    orgId,
    empId: leave.emp_id,
    leaveId,
    actorId: approverId,
    reason: reason || leave.cancellation_reason,
    approveNow: true,
  });
}

async function adjustLeaveBalance({ orgId, empId, leaveType, days, actorId, reason }) {
  if (!reason || !String(reason).trim()) {
    throw createError('LEAVE_025', 'Adjustment reason is required', 422);
  }

  return sequelize.transaction(async (transaction) => {
    const employee = await getEmployeeForOrg(orgId, empId);
    const leaveTypeRecord = await getLeaveTypeRecord(orgId, leaveType, transaction);
    const result = await applyBalanceDelta({
      orgId,
      empId,
      leaveTypeRecord,
      delta: Number(days || 0),
      transactionType: 'adjustment',
      actorId,
      reason,
      effectiveDate: getTodayDate(),
      transaction,
    });
    return {
      employeeId: employee.id,
      leaveType: leaveTypeRecord.code,
      remaining: result.remaining,
    };
  });
}

async function listLedger(orgId, query = {}) {
  const where = { org_id: orgId };
  if (query.employeeId || query.empId) where.emp_id = query.employeeId || query.empId;
  if (query.type || query.leaveType) where.leave_type = mapLeaveTypeToBalanceKey(query.type || query.leaveType);

  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
  const page = Math.max(Number(query.page || 1), 1);
  const offset = (page - 1) * limit;
  const result = await LeaveBalanceLedger.findAndCountAll({
    where,
    include: [
      { model: Employee, as: 'employee', attributes: ['id', 'name', 'emp_code'], required: false },
      { model: Employee, as: 'actor', attributes: ['id', 'name', 'emp_code'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    entries: result.rows.map((entry) => ({
      id: entry.id,
      employeeId: entry.emp_id,
      employeeName: entry.employee?.name || null,
      leaveType: entry.leave_type,
      transactionType: entry.transaction_type,
      days: Number(entry.days || 0),
      balanceAfter: Number(entry.balance_after || 0),
      requestId: entry.request_id,
      actorName: entry.actor?.name || null,
      reason: entry.reason,
      effectiveDate: entry.effective_date,
      createdAt: entry.created_at,
    })),
    page,
    total: result.count,
    hasMore: offset + result.rows.length < result.count,
  };
}

async function listLeaveTypes(orgId = null) {
  if (!orgId) {
    return {
      types: DEFAULT_BALANCE_TYPES.map((type) => ({
        type,
        label: DEFAULT_TYPE_CONFIG[type].label,
        halfDayAllowed: true,
        paid: DEFAULT_TYPE_CONFIG[type].paid,
        yearlyDefaultBalance: DEFAULT_TYPE_CONFIG[type].yearlyDefaultBalance,
      })),
    };
  }

  await ensureDefaultLeaveSetup(orgId);
  const types = await LeaveType.findAll({
    where: { org_id: orgId, is_active: true },
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });

  return {
    types: types.map((item) => ({
      id: item.id,
      type: item.code,
      code: item.code,
      label: item.name,
      name: item.name,
      halfDayAllowed: item.half_day_allowed,
      paid: item.is_paid,
      yearlyDefaultBalance: Number(item.yearly_default_balance || 0),
      noticeDays: item.notice_days,
      maxConsecutiveDays: item.max_consecutive_days,
      requiresDocumentAfterDays: item.requires_document_after_days ? Number(item.requires_document_after_days) : null,
      allowNegativeBalance: item.allow_negative_balance,
    })),
  };
}

async function upsertLeaveType({ orgId, body }) {
  const code = mapLeaveTypeToBalanceKey(body.code || body.type || body.name);
  if (!code || !body.name) {
    throw createError('LEAVE_026', 'Leave type code and name are required', 422);
  }

  const [record] = await LeaveType.findOrCreate({
    where: { org_id: orgId, code },
    defaults: {
      org_id: orgId,
      code,
      name: body.name,
    },
  });

  await record.update({
    name: body.name,
    description: body.description ?? record.description,
    is_paid: typeof body.paid === 'boolean' ? body.paid : typeof body.isPaid === 'boolean' ? body.isPaid : record.is_paid,
    half_day_allowed: typeof body.halfDayAllowed === 'boolean' ? body.halfDayAllowed : record.half_day_allowed,
    include_weekends: typeof body.includeWeekends === 'boolean' ? body.includeWeekends : record.include_weekends,
    include_holidays: typeof body.includeHolidays === 'boolean' ? body.includeHolidays : record.include_holidays,
    allow_negative_balance: typeof body.allowNegativeBalance === 'boolean' ? body.allowNegativeBalance : record.allow_negative_balance,
    max_negative_balance: body.maxNegativeBalance ?? record.max_negative_balance,
    notice_days: body.noticeDays ?? record.notice_days,
    max_consecutive_days: body.maxConsecutiveDays ?? record.max_consecutive_days,
    min_request_days: body.minRequestDays ?? record.min_request_days,
    max_request_days: body.maxRequestDays ?? record.max_request_days,
    requires_document_after_days: body.requiresDocumentAfterDays ?? record.requires_document_after_days,
    yearly_default_balance: body.yearlyDefaultBalance ?? record.yearly_default_balance,
    is_active: typeof body.isActive === 'boolean' ? body.isActive : record.is_active,
  });

  return { type: mapLeaveRequestType(record) };
}

function mapLeaveRequestType(item) {
  return {
    id: item.id,
    code: item.code,
    type: item.code,
    name: item.name,
    label: item.name,
    paid: item.is_paid,
    halfDayAllowed: item.half_day_allowed,
    yearlyDefaultBalance: Number(item.yearly_default_balance || 0),
  };
}

function mapLeavePolicy(policy) {
  return {
    id: policy.id,
    name: policy.name,
    scopeType: policy.scope_type,
    scopeId: policy.scope_id,
    effectiveFrom: policy.effective_from,
    effectiveTo: policy.effective_to,
    accrualFrequency: policy.accrual_frequency,
    entitlements: policy.entitlements || {},
    carryForward: policy.carry_forward || {},
    approvalWorkflowId: policy.approval_workflow_id,
    approvalWorkflowName: policy.approvalWorkflow?.name || null,
    isDefault: Boolean(policy.is_default),
    isActive: Boolean(policy.is_active),
    settings: policy.settings || {},
    createdAt: policy.created_at,
  };
}

async function listLeavePolicies(orgId) {
  await ensureDefaultLeaveSetup(orgId);
  const [policies, workflows] = await Promise.all([
    LeavePolicy.findAll({
      where: { org_id: orgId },
      include: [{ model: LeaveApprovalWorkflow, as: 'approvalWorkflow', required: false }],
      order: [
        ['is_default', 'DESC'],
        ['scope_type', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
    LeaveApprovalWorkflow.findAll({
      where: { org_id: orgId, is_active: true },
      order: [['is_default', 'DESC'], ['name', 'ASC']],
    }),
  ]);

  return {
    policies: policies.map(mapLeavePolicy),
    workflows: workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      levels: workflow.levels || [],
      autoApprove: Boolean(workflow.auto_approve),
      isDefault: Boolean(workflow.is_default),
    })),
  };
}

async function upsertLeavePolicy({ orgId, body }) {
  await ensureDefaultLeaveSetup(orgId);
  const name = String(body.name || '').trim();
  const scopeType = body.scopeType || body.scope_type || 'org';
  const scopeId = body.scopeId || body.scope_id || null;
  const effectiveFrom = dateOnly(body.effectiveFrom || body.effective_from || getYearStart());

  if (!name) {
    throw createError('LEAVE_031', 'Policy name is required', 422);
  }

  if (!['org', 'branch', 'department', 'employee'].includes(scopeType)) {
    throw createError('LEAVE_032', 'Invalid policy scope', 422);
  }

  if (scopeType !== 'org' && !scopeId) {
    throw createError('LEAVE_033', 'Policy scope target is required', 422);
  }

  const workflow = body.approvalWorkflowId || body.approval_workflow_id
    ? await LeaveApprovalWorkflow.findOne({
      where: { id: body.approvalWorkflowId || body.approval_workflow_id, org_id: orgId, is_active: true },
    })
    : await LeaveApprovalWorkflow.findOne({ where: { org_id: orgId, is_default: true, is_active: true } });

  if (!workflow) {
    throw createError('LEAVE_034', 'Approval workflow not found', 422);
  }

  const entitlements = Object.entries(body.entitlements || {}).reduce((accumulator, [key, value]) => {
    const number = Number(value || 0);
    if (Number.isFinite(number)) {
      accumulator[mapLeaveTypeToBalanceKey(key)] = number;
    }
    return accumulator;
  }, {});

  const settings = {
    ...(body.settings || {}),
    halfDayAllowed: body.halfDayAllowed,
    includeWeekends: body.includeWeekends,
    includeHolidays: body.includeHolidays,
    noticeDays: body.noticeDays,
    maxConsecutiveDays: body.maxConsecutiveDays,
    requiresDocumentAfterDays: body.requiresDocumentAfterDays,
    allowNegativeBalance: body.allowNegativeBalance,
  };

  return sequelize.transaction(async (transaction) => {
    const [policy] = await LeavePolicy.findOrCreate({
      where: body.id ? { id: body.id, org_id: orgId } : {
        org_id: orgId,
        scope_type: scopeType,
        scope_id: scopeType === 'org' ? null : scopeId,
        effective_from: effectiveFrom,
      },
      defaults: {
        org_id: orgId,
        name,
        scope_type: scopeType,
        scope_id: scopeType === 'org' ? null : scopeId,
        effective_from: effectiveFrom,
      },
      transaction,
    });

    await policy.update(
      {
        name,
        scope_type: scopeType,
        scope_id: scopeType === 'org' ? null : scopeId,
        effective_from: effectiveFrom,
        effective_to: body.effectiveTo || body.effective_to ? dateOnly(body.effectiveTo || body.effective_to) : null,
        accrual_frequency: body.accrualFrequency || body.accrual_frequency || 'yearly',
        entitlements,
        carry_forward: body.carryForward || body.carry_forward || {},
        approval_workflow_id: workflow.id,
        is_default: scopeType === 'org' ? Boolean(body.isDefault ?? body.is_default ?? true) : false,
        is_active: body.isActive ?? body.is_active ?? true,
        settings,
      },
      { transaction }
    );

    if (policy.is_default) {
      await LeavePolicy.update(
        { is_default: false },
        {
          where: {
            org_id: orgId,
            id: { [Op.ne]: policy.id },
            scope_type: 'org',
          },
          transaction,
        }
      );
      await policy.update({ is_default: true }, { transaction });
    }

    return { policy: mapLeavePolicy(policy) };
  });
}

async function getPayrollReport(orgId, query = {}) {
  const dateFrom = query.dateFrom || query.fromDate || getYearStart();
  const dateTo = query.dateTo || query.toDate || getTodayDate();
  const leaves = await LeaveRequest.findAll({
    where: {
      org_id: orgId,
      status: 'approved',
      from_date: { [Op.lte]: dateTo },
      to_date: { [Op.gte]: dateFrom },
    },
    include: buildLeaveInclude(query),
    order: [['from_date', 'ASC']],
  });

  const rows = leaves.map((leave) => ({
    employeeId: leave.emp_id,
    employeeName: leave.employee?.name || null,
    employeeCode: leave.employee?.emp_code || null,
    leaveType: leave.leave_type,
    paid: leave.leaveTypeRecord ? leave.leaveTypeRecord.is_paid : true,
    fromDate: leave.from_date,
    toDate: leave.to_date,
    days: Number(leave.days_count || 0),
    lopDays: leave.leaveTypeRecord && !leave.leaveTypeRecord.is_paid ? Number(leave.days_count || 0) : 0,
  }));

  const summary = rows.reduce((accumulator, row) => {
    accumulator.totalDays += row.days;
    accumulator.lopDays += row.lopDays;
    accumulator.paidDays += row.paid ? row.days : 0;
    return accumulator;
  }, { totalDays: 0, paidDays: 0, lopDays: 0 });

  return { dateFrom, dateTo, summary, rows };
}

async function setPayrollLock({ orgId, actorId, body }) {
  const periodStart = dateOnly(body.periodStart || body.period_start || body.dateFrom);
  const periodEnd = dateOnly(body.periodEnd || body.period_end || body.dateTo);
  if (!periodStart || !periodEnd || periodStart > periodEnd) {
    throw createError('LEAVE_027', 'Valid payroll period is required', 422);
  }

  const [lock] = await PayrollLock.findOrCreate({
    where: { org_id: orgId, period_start: periodStart, period_end: periodEnd },
    defaults: {
      org_id: orgId,
      period_start: periodStart,
      period_end: periodEnd,
      locked_by: actorId,
      locked_at: new Date(),
      status: body.status || 'locked',
      notes: body.notes || null,
    },
  });

  await lock.update({
    status: body.status || 'locked',
    locked_by: actorId,
    locked_at: new Date(),
    notes: body.notes || lock.notes,
  });

  return { lock };
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
  approveCancellation,
  adjustLeaveBalance,
  listLedger,
  upsertLeaveType,
  listLeavePolicies,
  upsertLeavePolicy,
  getPayrollReport,
  setPayrollLock,
  validateLeavePayload,
};
