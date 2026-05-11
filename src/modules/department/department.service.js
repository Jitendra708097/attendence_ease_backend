const { Op } = require('sequelize');
const { Attendance, Branch, Department, Employee, Shift } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function mapEmployee(employee) {
  return {
    id: employee.id,
    name: employee.name,
    empCode: employee.emp_code,
    email: employee.email,
    phone: employee.phone,
    role: employee.role,
    status: employee.is_active ? 'active' : 'inactive',
    branchName: employee.branch ? employee.branch.name : null,
    shiftName: employee.shift ? employee.shift.name : null,
    isFaceEnrolled: Boolean(employee.is_face_enrolled),
  };
}

function mapDepartment(department, meta = {}) {
  const employeeCount = Number(meta.employeeCount || 0);
  const childCount = Number(meta.childCount || 0);

  return {
    id: department.id,
    name: department.name,
    parentId: department.parent_id || null,
    headEmpId: department.head_emp_id || null,
    parentDepartment: department.parentDepartment
      ? {
          id: department.parentDepartment.id,
          name: department.parentDepartment.name,
        }
      : null,
    headEmployee: department.headEmployee
      ? {
          id: department.headEmployee.id,
          name: department.headEmployee.name,
          empCode: department.headEmployee.emp_code,
          email: department.headEmployee.email,
        }
      : null,
    employeeCount,
    directEmployeeCount: employeeCount,
    childCount,
    totalEmployeeCountIncludingChildren: Number(meta.totalEmployeeCountIncludingChildren || employeeCount),
    canDelete: employeeCount === 0 && childCount === 0,
    children: [],
  };
}

async function ensureParentInOrg(orgId, parentId, currentDepartmentId = null) {
  if (!parentId) {
    return null;
  }

  if (currentDepartmentId && currentDepartmentId === parentId) {
    throw createError('DEPT_007', 'Department cannot be its own parent', 400);
  }

  const parent = await Department.findOne({
    where: {
      id: parentId,
      org_id: orgId,
    },
  });

  if (!parent) {
    throw createError('DEPT_008', 'Parent department not found', 404);
  }

  return parent;
}

async function ensureHeadEmployeeInOrg(orgId, headEmpId) {
  if (!headEmpId) {
    return null;
  }

  const employee = await Employee.findOne({
    where: {
      id: headEmpId,
      org_id: orgId,
      is_active: true,
    },
  });

  if (!employee) {
    throw createError('DEPT_012', 'Department head employee not found in this organisation', 404);
  }

  return employee;
}

async function assertUniqueDepartmentName(orgId, name, parentId = null, currentDepartmentId = null) {
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    throw createError('DEPT_002', 'Department name is required', 422);
  }

  const where = {
    org_id: orgId,
    name: {
      [Op.iLike]: trimmedName,
    },
    parent_id: parentId || null,
  };

  if (currentDepartmentId) {
    where.id = {
      [Op.ne]: currentDepartmentId,
    };
  }

  const existing = await Department.findOne({ where });

  if (existing) {
    throw createError('DEPT_013', 'A department with this name already exists under the same parent', 409);
  }
}

async function assertNoCircularReference(orgId, departmentId, parentId) {
  let currentParentId = parentId;

  while (currentParentId) {
    if (currentParentId === departmentId) {
      throw createError('DEPT_009', 'Department hierarchy cannot contain cycles', 400);
    }

    const current = await Department.findOne({
      where: {
        id: currentParentId,
        org_id: orgId,
      },
      attributes: ['id', 'parent_id'],
    });

    currentParentId = current ? current.parent_id : null;
  }
}

async function listDepartments(orgId) {
  const [departments, employees] = await Promise.all([
    scopedModel(Department, orgId).findAll({
      include: [
        { model: Department, as: 'parentDepartment', attributes: ['id', 'name'], required: false },
        { model: Employee, as: 'headEmployee', attributes: ['id', 'name', 'emp_code', 'email'], required: false },
      ],
      order: [['name', 'ASC']],
    }),
    scopedModel(Employee, orgId).findAll({
      attributes: ['id', 'department_id'],
      where: {
        is_active: true,
      },
    }),
  ]);

  const employeeCounts = employees.reduce((accumulator, employee) => {
    if (employee.department_id) {
      accumulator[employee.department_id] = (accumulator[employee.department_id] || 0) + 1;
    }

    return accumulator;
  }, {});

  const childCounts = departments.reduce((accumulator, department) => {
    if (department.parent_id) {
      accumulator[department.parent_id] = (accumulator[department.parent_id] || 0) + 1;
    }

    return accumulator;
  }, {});

  const nodeMap = new Map(
    departments.map((department) => [
      department.id,
      mapDepartment(department, {
        employeeCount: employeeCounts[department.id] || 0,
        childCount: childCounts[department.id] || 0,
      }),
    ])
  );

  const roots = [];

  nodeMap.forEach((node) => {
    if (node.parentId && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortTree = (items) => {
    items.sort((left, right) => left.name.localeCompare(right.name));
    items.forEach((item) => {
      sortTree(item.children);
      item.childCount = item.children.length;
      item.totalEmployeeCountIncludingChildren =
        item.directEmployeeCount +
        item.children.reduce((sum, child) => sum + child.totalEmployeeCountIncludingChildren, 0);
      item.canDelete = item.directEmployeeCount === 0 && item.childCount === 0;
    });
    return items;
  };

  return {
    departments: sortTree(roots),
  };
}

async function getDepartmentById(orgId, id) {
  const department = await Department.findOne({
    where: {
      id,
      org_id: orgId,
    },
    include: [
      { model: Department, as: 'parentDepartment', attributes: ['id', 'name'], required: false },
      { model: Employee, as: 'headEmployee', attributes: ['id', 'name', 'emp_code', 'email'], required: false },
    ],
  });

  if (!department) {
    throw createError('HTTP_404', 'Department not found', 404);
  }

  const [employeeCount, childCount] = await Promise.all([
    Employee.count({
      where: {
        org_id: orgId,
        department_id: id,
        is_active: true,
      },
    }),
    Department.count({
      where: {
        org_id: orgId,
        parent_id: id,
      },
    }),
  ]);

  return mapDepartment(department, { employeeCount, childCount });
}

async function createDepartment(orgId, payload) {
  const name = String(payload.name || '').trim();
  const parentId = payload.parentId || null;

  await ensureParentInOrg(orgId, parentId);
  await ensureHeadEmployeeInOrg(orgId, payload.headEmpId || null);
  await assertUniqueDepartmentName(orgId, name, parentId);

  const department = await scopedModel(Department, orgId).create({
    name,
    parent_id: parentId,
    head_emp_id: payload.headEmpId || null,
  });

  return getDepartmentById(orgId, department.id);
}

async function updateDepartment(orgId, id, payload) {
  const department = await Department.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!department) {
    throw createError('HTTP_404', 'Department not found', 404);
  }

  const nextParentId =
    payload.parentId === undefined
      ? department.parent_id
      : payload.parentId || null;

  await ensureParentInOrg(orgId, nextParentId, department.id);
  await ensureHeadEmployeeInOrg(orgId, payload.headEmpId === undefined ? department.head_emp_id : payload.headEmpId || null);
  await assertNoCircularReference(orgId, department.id, nextParentId);
  await assertUniqueDepartmentName(orgId, payload.name || department.name, nextParentId, department.id);

  await department.update({
    name: payload.name ? String(payload.name).trim() : department.name,
    parent_id: nextParentId,
    head_emp_id: payload.headEmpId === undefined ? department.head_emp_id : payload.headEmpId || null,
  });

  return getDepartmentById(orgId, department.id);
}

async function listDepartmentEmployees(orgId, id) {
  await getDepartmentById(orgId, id);

  const employees = await Employee.findAll({
    where: {
      org_id: orgId,
      department_id: id,
    },
    attributes: ['id', 'name', 'emp_code', 'email', 'phone', 'role', 'is_active', 'is_face_enrolled'],
    include: [
      { model: Branch, as: 'branch', attributes: ['id', 'name'], required: false },
      { model: Shift, as: 'shift', attributes: ['id', 'name'], required: false },
    ],
    order: [['name', 'ASC']],
  });

  return {
    employees: employees.map(mapEmployee),
    total: employees.length,
  };
}

async function getDepartmentStats(orgId, id) {
  await getDepartmentById(orgId, id);

  const date = getTodayDate();
  const [employeeCount, childCount, attendanceRows] = await Promise.all([
    Employee.count({
      where: {
        org_id: orgId,
        department_id: id,
        is_active: true,
      },
    }),
    Department.count({
      where: {
        org_id: orgId,
        parent_id: id,
      },
    }),
    Attendance.findAll({
      where: {
        org_id: orgId,
        date,
      },
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: [],
          required: true,
          where: {
            org_id: orgId,
            department_id: id,
          },
        },
      ],
      attributes: ['id', 'status', 'first_check_in', 'is_late'],
    }),
  ]);

  return {
    date,
    employeeCount,
    childCount,
    markedCount: attendanceRows.length,
    checkedInCount: attendanceRows.filter((record) => Boolean(record.first_check_in)).length,
    presentCount: attendanceRows.filter((record) => record.status === 'present').length,
    absentCount: attendanceRows.filter((record) => record.status === 'absent').length,
    lateCount: attendanceRows.filter((record) => Boolean(record.is_late)).length,
    notMarkedCount: Math.max(employeeCount - attendanceRows.length, 0),
  };
}

async function deleteDepartment(orgId, id) {
  const department = await Department.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!department) {
    throw createError('HTTP_404', 'Department not found', 404);
  }

  const [childCount, employeeCount] = await Promise.all([
    Department.count({
      where: {
        org_id: orgId,
        parent_id: id,
      },
    }),
    Employee.count({
      where: {
        org_id: orgId,
        department_id: id,
        is_active: true,
      },
    }),
  ]);

  if (childCount > 0) {
    throw createError('DEPT_010', 'Delete or move child departments first', 400);
  }

  if (employeeCount > 0) {
    throw createError('DEPT_011', 'Reassign employees before deleting this department', 400);
  }

  await department.destroy();
  return true;
}

module.exports = {
  listDepartments,
  getDepartmentById,
  createDepartment,
  updateDepartment,
  listDepartmentEmployees,
  getDepartmentStats,
  deleteDepartment,
};
