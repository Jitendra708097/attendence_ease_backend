const crypto = require('crypto');
const XLSX = require('xlsx');
const { Op } = require('sequelize');
const { Employee, Branch, Department, Shift, Attendance } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');
const { getPagingData } = require('../../utils/pagination');
const { hashValue } = require('../../utils/auth');
const { notification } = require('../../queues');

function randomTempPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

async function resolveEmployeeReferences(orgId, payload) {
  const branch = await Branch.findOne({ where: { id: payload.branchId, org_id: orgId } });
  const shift = await Shift.findOne({ where: { id: payload.shiftId, org_id: orgId } });
  const department = payload.departmentId
    ? await Department.findOne({ where: { id: payload.departmentId, org_id: orgId } })
    : null;

  if (!branch || !shift || (payload.departmentId && !department)) {
    const error = new Error('Invalid employee references');
    error.code = 'EMP_002';
    error.statusCode = 400;
    throw error;
  }

  return {
    branch,
    shift,
    department,
  };
}

async function generateEmpCode(orgId, orgSlug) {
  const count = await Employee.count({
    where: {
      org_id: orgId,
    },
  });

  const nextNumber = String(count + 1).padStart(4, '0');
  return `${String(orgSlug).toUpperCase()}-${nextNumber}`;
}

function mapEmployee(employee) {
  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    phone: employee.phone,
    role: employee.role,
    empCode: employee.emp_code,
    status: employee.is_active ? 'active' : 'inactive',
    branchId: employee.branch_id,
    branchName: employee.branch?.name || null,
    departmentId: employee.department_id,
    departmentName: employee.department?.name || null,
    shiftId: employee.shift_id,
    shiftName: employee.shift?.name || null,
    faceEnrolled: Boolean(employee.face_embedding_id || employee.face_embedding_local),
    requiresPasswordChange: !employee.password_changed,
  };
}

async function listEmployees(orgId, query) {
  const page = Number.parseInt(query.page, 10) || 1;
  const limit = Math.min(Number.parseInt(query.limit, 10) || 20, 100);
  const offset = (page - 1) * limit;
  const where = {
    org_id: orgId,
  };

  if (query.branch) {
    where.branch_id = query.branch;
  }

  if (query.dept) {
    where.department_id = query.dept;
  }

  if (query.status === 'active') {
    where.is_active = true;
  }

  if (query.status === 'inactive') {
    where.is_active = false;
  }

  if (query.search) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${query.search}%` } },
      { email: { [Op.iLike]: `%${query.search}%` } },
      { emp_code: { [Op.iLike]: `%${query.search}%` } },
    ];
  }

  const result = await Employee.findAndCountAll({
    where,
    include: [
      { model: Branch, as: 'branch', attributes: ['id', 'name'] },
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      { model: Shift, as: 'shift', attributes: ['id', 'name'] },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  const paging = getPagingData(result, page, limit);

  return {
    employees: paging.rows.map(mapEmployee),
    pagination: {
      page: paging.page,
      limit: paging.limit,
      count: paging.count,
      totalPages: paging.totalPages,
    },
  };
}

async function getEmployeeById(orgId, id) {
  const employee = await Employee.findOne({
    where: {
      id,
      org_id: orgId,
    },
    include: [
      { model: Branch, as: 'branch', attributes: ['id', 'name'] },
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
      { model: Shift, as: 'shift', attributes: ['id', 'name'] },
    ],
  });

  if (!employee) {
    const error = new Error('Employee not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  return mapEmployee(employee);
}

async function createEmployee(orgId, organisation, payload) {
  await resolveEmployeeReferences(orgId, payload);

  const tempPassword = randomTempPassword();
  const passwordHash = await hashValue(tempPassword);
  const empCode = payload.empCode || (await generateEmpCode(orgId, organisation.slug));

  const employee = await scopedModel(Employee, orgId).create({
    branch_id: payload.branchId,
    department_id: payload.departmentId || null,
    shift_id: payload.shiftId,
    emp_code: empCode,
    name: payload.name,
    email: String(payload.email).trim().toLowerCase(),
    phone: payload.phone || null,
    role: payload.role,
    password_hash: passwordHash,
    temp_password: tempPassword,
    password_changed: false,
    leave_balance: payload.leaveBalance || {},
  });

  await notification.add(
    'send_welcome_email',
    {
      orgId,
      employeeId: employee.id,
      email: employee.email,
      phone: employee.phone,
      organisationName: organisation.name,
      employeeName: employee.name,
      tempPassword,
    },
    {
      jobId: `send_welcome_email_${employee.id}`,
      removeOnComplete: true,
    }
  );

  return getEmployeeById(orgId, employee.id);
}

async function updateEmployee(orgId, id, payload) {
  const employee = await Employee.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!employee) {
    const error = new Error('Employee not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  if (payload.branchId || payload.shiftId || payload.departmentId) {
    await resolveEmployeeReferences(orgId, {
      branchId: payload.branchId || employee.branch_id,
      shiftId: payload.shiftId || employee.shift_id,
      departmentId: payload.departmentId || employee.department_id,
    });
  }

  await employee.update({
    name: payload.name ?? employee.name,
    email: payload.email ? String(payload.email).trim().toLowerCase() : employee.email,
    phone: payload.phone ?? employee.phone,
    role: payload.role ?? employee.role,
    branch_id: payload.branchId ?? employee.branch_id,
    department_id: payload.departmentId ?? employee.department_id,
    shift_id: payload.shiftId ?? employee.shift_id,
    is_active: typeof payload.isActive === 'boolean' ? payload.isActive : employee.is_active,
  });

  return getEmployeeById(orgId, employee.id);
}

async function deleteEmployee(orgId, id) {
  const employee = await Employee.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!employee) {
    const error = new Error('Employee not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  await employee.destroy();
  return true;
}

async function attendanceSummary(orgId, id) {
  const summary = await Attendance.findAll({
    where: {
      org_id: orgId,
      emp_id: id,
    },
    attributes: ['status'],
  });

  return summary.reduce(
    (accumulator, item) => {
      accumulator.total += 1;
      accumulator[item.status] = (accumulator[item.status] || 0) + 1;
      return accumulator;
    },
    { total: 0 }
  );
}

async function bulkUpload(orgId, organisation, fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const results = [];

  for (const [index, row] of rows.entries()) {
    try {
      const created = await createEmployee(orgId, organisation, {
        name: row.name,
        email: row.email,
        phone: row.phone,
        branchId: row.branch_id,
        departmentId: row.department_id || null,
        shiftId: row.shift_id,
        role: row.role || 'employee',
        empCode: row.emp_code || null,
      });

      results.push({
        row: index + 2,
        email: row.email,
        status: 'success',
        message: `Created ${created.name}`,
      });
    } catch (error) {
      results.push({
        row: index + 2,
        email: row.email,
        status: 'error',
        message: error.message,
      });
    }
  }

  return results;
}

module.exports = {
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  attendanceSummary,
  bulkUpload,
};
