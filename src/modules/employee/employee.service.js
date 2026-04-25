const crypto = require('crypto');
const XLSX = require('xlsx');
const { Op } = require('sequelize');
const { Employee, Branch, Department, Shift, Attendance } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');
const { getPagingData } = require('../../utils/pagination');
const { hashValue } = require('../../utils/auth');
const { notification } = require('../../queues');

const BULK_UPLOAD_MAX_ROWS = 500;

function getTenantEmployeeWhere(orgId, extraWhere = {}) {
  return {
    org_id: orgId,
    role: {
      [Op.ne]: 'superadmin',
    },
    ...extraWhere,
  };
}

function randomTempPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

function normalizeCellValue(value) {
  return String(value == null ? '' : value).trim();
}

function buildEmpCodePrefix(orgSlug) {
  const parts = String(orgSlug || '')
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return 'EMP';
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 6).toUpperCase();
  }

  return parts
    .slice(0, 6)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function findReferenceByIdOrName(model, orgId, value, label, required = true) {
  const normalizedValue = normalizeCellValue(value);

  if (!normalizedValue) {
    if (!required) {
      return null;
    }

    const error = new Error(`${label} is required`);
    error.code = 'EMP_002';
    error.statusCode = 400;
    throw error;
  }

  const record = await model.findOne({
    where: {
      org_id: orgId,
      [Op.or]: [
        ...(looksLikeUuid(normalizedValue) ? [{ id: normalizedValue }] : []),
        { name: { [Op.iLike]: normalizedValue } },
      ],
    },
  });

  if (!record && required) {
    const error = new Error(`Invalid ${label}`);
    error.code = 'EMP_002';
    error.statusCode = 400;
    throw error;
  }

  return record;
}

async function resolveEmployeeReferences(orgId, payload) {
  const branch = await findReferenceByIdOrName(Branch, orgId, payload.branchId, 'branch');
  const shift = await findReferenceByIdOrName(Shift, orgId, payload.shiftId, 'shift');
  const department = await findReferenceByIdOrName(Department, orgId, payload.departmentId, 'department', false);

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

function mapBulkUploadRow(row = {}) {
  return {
    name: normalizeCellValue(row.name),
    email: normalizeCellValue(row.email).toLowerCase(),
    phone: normalizeCellValue(row.phone) || null,
    branchId: normalizeCellValue(row.branch_id || row.branch_name || row.branch),
    departmentId: normalizeCellValue(row.department_id || row.department_name || row.department) || null,
    shiftId: normalizeCellValue(row.shift_id || row.shift_name || row.shift),
    role: normalizeCellValue(row.role || 'employee').toLowerCase() || 'employee',
    empCode: normalizeCellValue(row.emp_code) || null,
  };
}

async function generateEmpCode(orgId, orgSlug) {
  const count = await Employee.count({
    where: getTenantEmployeeWhere(orgId),
  });

  const nextNumber = String(count + 1).padStart(4, '0');
  return `${buildEmpCodePrefix(orgSlug)}-${nextNumber}`;
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
    faceEnrolled: Boolean(employee.is_face_enrolled || employee.face_embedding_id || employee.face_embedding_local),
    requiresPasswordChange: !employee.password_changed,
  };
}

async function listEmployees(orgId, query) {
  const page = Number.parseInt(query.page, 10) || 1;
  const limit = Math.min(Number.parseInt(query.limit, 10) || 20, 100);
  const offset = (page - 1) * limit;
  const where = getTenantEmployeeWhere(orgId);

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
    where: getTenantEmployeeWhere(orgId, { id }),
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
  if (payload.role === 'superadmin') {
    const error = new Error('Invalid employee role');
    error.code = 'EMP_002';
    error.statusCode = 400;
    throw error;
  }

  const references = await resolveEmployeeReferences(orgId, payload);

  const tempPassword = randomTempPassword();
  const passwordHash = await hashValue(tempPassword);
  const empCode = payload.empCode || (await generateEmpCode(orgId, organisation.slug));

  const employee = await scopedModel(Employee, orgId).create({
    branch_id: references.branch.id,
    department_id: references.department ? references.department.id : null,
    shift_id: references.shift.id,
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
    where: getTenantEmployeeWhere(orgId, { id }),
  });

  if (!employee) {
    const error = new Error('Employee not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  if (payload.branchId || payload.shiftId || payload.departmentId) {
    const references = await resolveEmployeeReferences(orgId, {
      branchId: payload.branchId || employee.branch_id,
      shiftId: payload.shiftId || employee.shift_id,
      departmentId: payload.departmentId || employee.department_id,
    });

    payload.branchId = references.branch.id;
    payload.shiftId = references.shift.id;
    payload.departmentId = references.department ? references.department.id : null;
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
    where: getTenantEmployeeWhere(orgId, { id }),
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

async function deleteEmployees(orgId, ids = []) {
  const normalizedIds = Array.from(new Set((ids || []).filter(Boolean)));

  if (normalizedIds.length === 0) {
    const error = new Error('Employee ids are required');
    error.code = 'EMP_011';
    error.statusCode = 422;
    throw error;
  }

  const employees = await Employee.findAll({
    where: getTenantEmployeeWhere(orgId, {
      id: {
        [Op.in]: normalizedIds,
      },
    }),
    attributes: ['id'],
  });

  const foundIds = employees.map((employee) => employee.id);

  if (foundIds.length !== normalizedIds.length) {
    const error = new Error('One or more employees were not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  await Employee.destroy({
    where: {
      org_id: orgId,
      id: {
        [Op.in]: normalizedIds,
      },
    },
  });

  return {
    deletedCount: normalizedIds.length,
    ids: normalizedIds,
  };
}

async function attendanceSummary(orgId, id) {
  const employee = await Employee.findOne({
    where: getTenantEmployeeWhere(orgId, { id }),
    attributes: ['id'],
  });

  if (!employee) {
    const error = new Error('Employee not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

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

  if (rows.length > BULK_UPLOAD_MAX_ROWS) {
    const error = new Error(`You can upload at most ${BULK_UPLOAD_MAX_ROWS} employees at a time`);
    error.code = 'EMP_009';
    error.statusCode = 422;
    throw error;
  }

  for (const [index, row] of rows.entries()) {
    try {
      const created = await createEmployee(orgId, organisation, mapBulkUploadRow(row));

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
  BULK_UPLOAD_MAX_ROWS,
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  deleteEmployees,
  attendanceSummary,
  bulkUpload,
};
