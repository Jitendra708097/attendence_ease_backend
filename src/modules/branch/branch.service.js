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

function metersPerDegreeLng(lat) {
  return 111320 * Math.cos((Number(lat) * Math.PI) / 180);
}

function getReferenceLat(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return 0;
  }

  return points.reduce((sum, point) => sum + Number(point.lat || 0), 0) / points.length;
}

function toMetricPoint(point, referenceLat) {
  return {
    x: Number(point.lng) * (metersPerDegreeLng(referenceLat) || 1),
    y: Number(point.lat) * 111320,
  };
}

function getDistanceMeters(pointA, pointB) {
  const referenceLat = (Number(pointA.lat) + Number(pointB.lat)) / 2;
  const a = toMetricPoint(pointA, referenceLat);
  const b = toMetricPoint(pointB, referenceLat);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getOrientation(pointA, pointB, pointC) {
  const value =
    (pointB.y - pointA.y) * (pointC.x - pointB.x) -
    (pointB.x - pointA.x) * (pointC.y - pointB.y);

  if (Math.abs(value) < 1e-9) {
    return 0;
  }

  return value > 0 ? 1 : 2;
}

function isOnSegment(pointA, pointB, pointC) {
  return (
    pointB.x <= Math.max(pointA.x, pointC.x) + 1e-9 &&
    pointB.x + 1e-9 >= Math.min(pointA.x, pointC.x) &&
    pointB.y <= Math.max(pointA.y, pointC.y) + 1e-9 &&
    pointB.y + 1e-9 >= Math.min(pointA.y, pointC.y)
  );
}

function doSegmentsIntersect(a1, a2, b1, b2) {
  const orientation1 = getOrientation(a1, a2, b1);
  const orientation2 = getOrientation(a1, a2, b2);
  const orientation3 = getOrientation(b1, b2, a1);
  const orientation4 = getOrientation(b1, b2, a2);

  if (orientation1 !== orientation2 && orientation3 !== orientation4) {
    return true;
  }

  return (
    (orientation1 === 0 && isOnSegment(a1, b1, a2)) ||
    (orientation2 === 0 && isOnSegment(a1, b2, a2)) ||
    (orientation3 === 0 && isOnSegment(b1, a1, b2)) ||
    (orientation4 === 0 && isOnSegment(b1, a2, b2))
  );
}

function analyzePolygonQuality(polygon = []) {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    return {
      areaSqMeters: 0,
      perimeterMeters: 0,
      warnings: [],
    };
  }

  const points = polygon
    .map((point) => ({
      lat: Number(point?.lat),
      lng: Number(point?.lng),
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  if (points.length < 3) {
    return {
      areaSqMeters: 0,
      perimeterMeters: points.length === 2 ? Math.round(getDistanceMeters(points[0], points[1])) : 0,
      warnings: ['Add at least 3 points to create a usable boundary.'],
    };
  }

  const referenceLat = getReferenceLat(points);
  const metricPoints = points.map((point) => toMetricPoint(point, referenceLat));
  const warnings = [];
  const seenPoints = new Set();
  let perimeterMeters = 0;
  let shoelace = 0;
  let duplicatePointCount = 0;
  let shortEdgeCount = 0;

  for (let index = 0; index < points.length; index += 1) {
    const nextIndex = (index + 1) % points.length;
    const point = points[index];
    const nextPoint = points[nextIndex];
    const metricPoint = metricPoints[index];
    const nextMetricPoint = metricPoints[nextIndex];
    const key = `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;

    if (seenPoints.has(key)) {
      duplicatePointCount += 1;
    }
    seenPoints.add(key);

    const edgeLength = getDistanceMeters(point, nextPoint);
    perimeterMeters += edgeLength;
    if (edgeLength < 2) {
      shortEdgeCount += 1;
    }

    shoelace += metricPoint.x * nextMetricPoint.y - nextMetricPoint.x * metricPoint.y;
  }

  const areaSqMeters = Math.round(Math.abs(shoelace) / 2);
  let hasSelfIntersection = false;

  for (let i = 0; i < metricPoints.length; i += 1) {
    const iNext = (i + 1) % metricPoints.length;

    for (let j = i + 1; j < metricPoints.length; j += 1) {
      const jNext = (j + 1) % metricPoints.length;
      const sharesVertex = i === j || iNext === j || i === jNext || iNext === jNext;

      if (!sharesVertex && doSegmentsIntersect(metricPoints[i], metricPoints[iNext], metricPoints[j], metricPoints[jNext])) {
        hasSelfIntersection = true;
        break;
      }
    }

    if (hasSelfIntersection) {
      break;
    }
  }

  if (duplicatePointCount > 0) {
    warnings.push('Remove duplicate points from the boundary.');
  }
  if (shortEdgeCount > 0) {
    warnings.push('Some boundary points are extremely close together.');
  }
  if (hasSelfIntersection) {
    warnings.push('Boundary lines cross each other. Redraw the polygon in one direction.');
  }
  if (areaSqMeters > 0 && areaSqMeters < 25) {
    warnings.push('Boundary area looks very small for an office.');
  }
  if (areaSqMeters > 200000) {
    warnings.push('Boundary area looks unusually large. Confirm it does not include public areas.');
  }

  return {
    areaSqMeters,
    perimeterMeters: Math.round(perimeterMeters),
    warnings,
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

function mapBranch(branch) {
  const polygon = branch.geo_fence_polygons || [];
  const employeeCount = Array.isArray(branch.employees) ? branch.employees.length : branch.employeeCount || 0;
  const quality = analyzePolygonQuality(polygon);

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
    geofenceAreaSqMeters: quality.areaSqMeters,
    geofencePerimeterMeters: quality.perimeterMeters,
    geofenceWarnings: quality.warnings,
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
