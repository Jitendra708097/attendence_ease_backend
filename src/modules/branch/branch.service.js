const { Branch, Employee } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');

function mapBranch(branch) {
  return {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    isRemote: branch.is_remote,
    wifiVerificationEnabled: branch.wifi_verification_enabled,
    allowedBssids: branch.allowed_bssids || [],
    polygon: branch.geo_fence_polygons || [],
    hasGeofence: Array.isArray(branch.geo_fence_polygons) && branch.geo_fence_polygons.length >= 3,
    employeeCount: Array.isArray(branch.employees) ? branch.employees.length : branch.employeeCount || 0,
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
    const error = new Error('Branch not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  return mapBranch(branch);
}

async function createBranch(orgId, payload) {
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
    const error = new Error('Branch not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
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
    const error = new Error('Branch not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  await branch.update({
    geo_fence_polygons: polygon,
  });

  return mapBranch(branch);
}

async function deleteBranch(orgId, id) {
  const branch = await Branch.findOne({
    where: {
      id,
      org_id: orgId,
    },
  });

  if (!branch) {
    const error = new Error('Branch not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
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
  deleteBranch,
};
