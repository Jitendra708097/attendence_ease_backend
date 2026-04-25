const { Department, Employee } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function mapDepartment(department, employeeCount = 0) {
  return {
    id: department.id,
    name: department.name,
    parentId: department.parent_id || null,
    headEmpId: department.head_emp_id || null,
    employeeCount,
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

  const nodeMap = new Map(
    departments.map((department) => [
      department.id,
      mapDepartment(department, employeeCounts[department.id] || 0),
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
    items.forEach((item) => sortTree(item.children));
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
  });

  if (!department) {
    throw createError('HTTP_404', 'Department not found', 404);
  }

  const employeeCount = await Employee.count({
    where: {
      org_id: orgId,
      department_id: id,
      is_active: true,
    },
  });

  return mapDepartment(department, employeeCount);
}

async function createDepartment(orgId, payload) {
  await ensureParentInOrg(orgId, payload.parentId || null);

  const department = await scopedModel(Department, orgId).create({
    name: String(payload.name).trim(),
    parent_id: payload.parentId || null,
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
  await assertNoCircularReference(orgId, department.id, nextParentId);

  await department.update({
    name: payload.name ? String(payload.name).trim() : department.name,
    parent_id: nextParentId,
    head_emp_id: payload.headEmpId === undefined ? department.head_emp_id : payload.headEmpId || null,
  });

  return getDepartmentById(orgId, department.id);
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
  deleteDepartment,
};
