const { Attendance, Branch, Department, Designation, Employee } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');
const { checkGeofence, distanceToPolygonMeters } = require('../geofence/geofence.service');
const { notifyOrgRoles } = require('../notification/notification.service');
const planService = require('../plan/plan.service');

function createHttpError(message, statusCode, code) {
  const error = new Error(message);
  error.code = code || `HTTP_${statusCode}`;
  error.statusCode = statusCode;
  return error;
}

function getGeofenceQuality(branch) {
  const polygon = branch.geo_fence_polygons || branch.polygon || [];

  if (branch.is_remote || branch.isRemote) {
    return 'remote_not_required';
  }

  if (!Array.isArray(polygon) || polygon.length === 0) {
    return 'missing';
  }

  if (polygon.length < 3) {
    return 'too_few_points';
  }

  return 'valid';
}

function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function mapBranch(branch) {
  const polygon = branch.geo_fence_polygons || [];
  const employeeCount = Array.isArray(branch.employees) ? branch.employees.length : branch.employeeCount || 0;

  return {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    isRemote: branch.is_remote,
    wifiVerificationEnabled: branch.wifi_verification_enabled,
    allowedBssids: branch.allowed_bssids || [],
    polygon,
    polygonPointCount: Array.isArray(polygon) ? polygon.length : 0,
    hasGeofence: Array.isArray(polygon) && polygon.length >= 3,
    geofenceQuality: getGeofenceQuality(branch),
    employeeCount,
    canDelete: employeeCount === 0,
  };
}

async function listBranches(orgId) {
  const branches = await scopedModel(Branch, orgId).findAll({
    include: [
      {
        model: Employee,
        as: 'employees',
        attributes: ['id'],
        required: false,
      },
    ],
    order: [['created_at', 'DESC']],
  });

  return {
    branches: branches.map(mapBranch),
  };
}

async function getBranchById(orgId, id) {
  const branch = await Branch.findOne({
    where: {
      id,
      org_id: orgId,
    },
    include: [
      {
        model: Employee,
        as: 'employees',
        attributes: ['id'],
        required: false,
      },
    ],
  });

  if (!branch) {
    throw createHttpError('Branch not found', 404);
  }

  return mapBranch(branch);
}

async function createBranch(orgId, payload) {
  await planService.assertBranchLimit(orgId, 1);

  const branch = await scopedModel(Branch, orgId).create({
    name: payload.name,
    address: payload.address || null,
    is_remote: Boolean(payload.isRemote),
    wifi_verification_enabled: Boolean(payload.wifiVerificationEnabled),
    allowed_bssids: payload.allowedBssids || [],
    geo_fence_polygons: payload.polygon || [],
  });

  return mapBranch(branch);
}

async function updateBranch(orgId, id, payload) {
  const branch = await Branch.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!branch) {
    throw createHttpError('Branch not found', 404);
  }

  await branch.update({
    name: payload.name ?? branch.name,
    address: payload.address ?? branch.address,
    is_remote: typeof payload.isRemote === 'boolean' ? payload.isRemote : branch.is_remote,
    wifi_verification_enabled:
      typeof payload.wifiVerificationEnabled === 'boolean'
        ? payload.wifiVerificationEnabled
        : branch.wifi_verification_enabled,
    allowed_bssids: payload.allowedBssids ?? branch.allowed_bssids,
  });

  await notifyOrgRoles(orgId, ['admin', 'manager'], {
    type: 'branch_updated',
    title: 'Branch settings updated',
    body: `${branch.name} branch settings were updated.`,
    actionUrl: '/branches',
    data: {
      branch_id: branch.id,
      priority: 'low',
      status: 'completed',
    },
  });

  return mapBranch(branch);
}

async function updateGeofence(orgId, id, polygon) {
  const branch = await Branch.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!branch) {
    throw createHttpError('Branch not found', 404);
  }

  await branch.update({
    geo_fence_polygons: polygon,
  });

  await notifyOrgRoles(orgId, ['admin', 'manager'], {
    type: 'branch_geofence_changed',
    title: polygon.length > 0 ? 'Branch geofence updated' : 'Branch geofence cleared',
    body: `${branch.name} geofence now has ${polygon.length} polygon point${polygon.length === 1 ? '' : 's'}.`,
    actionUrl: '/branches',
    data: {
      branch_id: branch.id,
      priority: polygon.length >= 3 ? 'normal' : 'high',
      status: polygon.length >= 3 ? 'completed' : 'action_needed',
    },
  });

  return mapBranch(branch);
}

async function listBranchEmployees(orgId, id) {
  await getBranchById(orgId, id);

  const employees = await Employee.findAll({
    where: {
      org_id: orgId,
      branch_id: id,
    },
    attributes: ['id', 'emp_code', 'name', 'email', 'phone', 'role', 'is_active', 'is_face_enrolled', 'designation_id'],
    include: [
      {
        model: Department,
        as: 'department',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: Designation,
        as: 'designation',
        attributes: ['id', 'name'],
        required: false,
      },
    ],
    order: [['name', 'ASC']],
  });

  return {
    employees: employees.map((employee) => ({
      id: employee.id,
      empCode: employee.emp_code,
      name: employee.name,
      email: employee.email,
      phone: employee.phone,
      role: employee.role,
      designationId: employee.designation_id,
      designationName: employee.designation ? employee.designation.name : null,
      status: employee.is_active ? 'active' : 'inactive',
      isFaceEnrolled: Boolean(employee.is_face_enrolled),
      department: employee.department
        ? {
            id: employee.department.id,
            name: employee.department.name,
          }
        : null,
    })),
  };
}

async function getBranchTodayStats(orgId, id) {
  await getBranchById(orgId, id);

  const date = getTodayDate();
  const [employeeCount, attendanceRows] = await Promise.all([
    Employee.count({
      where: {
        org_id: orgId,
        branch_id: id,
        is_active: true,
      },
    }),
    Attendance.findAll({
      where: {
        org_id: orgId,
        branch_id: id,
        date,
      },
      attributes: ['id', 'status', 'first_check_in', 'last_check_out', 'is_late'],
    }),
  ]);

  const checkedInCount = attendanceRows.filter((record) => Boolean(record.first_check_in)).length;
  const presentCount = attendanceRows.filter((record) => record.status === 'present').length;
  const lateCount = attendanceRows.filter((record) => Boolean(record.is_late)).length;
  const absentCount = attendanceRows.filter((record) => record.status === 'absent').length;
  const incompleteCount = attendanceRows.filter((record) => record.status === 'incomplete').length;

  return {
    date,
    employeeCount,
    markedCount: attendanceRows.length,
    checkedInCount,
    presentCount,
    absentCount,
    lateCount,
    incompleteCount,
    notMarkedCount: Math.max(employeeCount - attendanceRows.length, 0),
  };
}

async function testBranchCoordinate(orgId, id, payload = {}) {
  const branch = await Branch.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!branch) {
    throw createHttpError('Branch not found', 404);
  }

  const lat = Number(payload.lat);
  const lng = Number(payload.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw createHttpError('Valid latitude and longitude are required', 422, 'BRANCH_INVALID_COORDINATE');
  }

  const polygon = branch.geo_fence_polygons || [];
  const hasGeofence = Array.isArray(polygon) && polygon.length >= 3;

  if (branch.is_remote) {
    return {
      branchId: branch.id,
      lat,
      lng,
      inside: true,
      geofenceRequired: false,
      geofenceQuality: 'remote_not_required',
      distanceMeters: 0,
    };
  }

  if (!hasGeofence) {
    return {
      branchId: branch.id,
      lat,
      lng,
      inside: false,
      geofenceRequired: true,
      geofenceQuality: getGeofenceQuality(branch),
      distanceMeters: null,
    };
  }

  const point = { lat, lng };
  const inside = checkGeofence(point, branch);

  return {
    branchId: branch.id,
    lat,
    lng,
    inside,
    geofenceRequired: true,
    geofenceQuality: 'valid',
    distanceMeters: Math.round(distanceToPolygonMeters(point, polygon)),
  };
}

async function deleteBranch(orgId, id) {
  const branch = await Branch.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!branch) {
    throw createHttpError('Branch not found', 404);
  }

  const employeeCount = await Employee.count({
    where: {
      org_id: orgId,
      branch_id: id,
    },
  });

  if (employeeCount > 0) {
    throw createHttpError(
      `Branch has ${employeeCount} assigned employee${employeeCount === 1 ? '' : 's'}. Reassign them before deleting.`,
      409,
      'BRANCH_HAS_EMPLOYEES'
    );
  }

  await branch.destroy();
  return true;
}

module.exports = {
  listBranches,
  getBranchById,
  createBranch,
  updateBranch,
  updateGeofence,
  listBranchEmployees,
  getBranchTodayStats,
  testBranchCoordinate,
  deleteBranch,
};
