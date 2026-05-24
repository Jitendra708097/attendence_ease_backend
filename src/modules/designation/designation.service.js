const { Op } = require('sequelize');
const { Designation, Employee } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function mapDesignation(designation) {
  return {
    id: designation.id,
    name: designation.name,
    description: designation.description || null,
    isActive: Boolean(designation.is_active),
  };
}

async function findDesignationByIdOrName(orgId, { designationId, designationName }, { createIfMissing = false } = {}) {
  const normalizedName = normalizeName(designationName);

  if (!designationId && !normalizedName) {
    return null;
  }

  const where = {
    org_id: orgId,
    is_active: true,
    [Op.or]: [
      ...(designationId ? [{ id: designationId }] : []),
      ...(normalizedName ? [{ name: { [Op.iLike]: normalizedName } }] : []),
    ],
  };

  const existing = await Designation.findOne({ where });
  if (existing) {
    return existing;
  }

  if (!createIfMissing || !normalizedName) {
    const error = new Error('Invalid designation');
    error.code = 'DESIG_001';
    error.statusCode = 400;
    throw error;
  }

  return scopedModel(Designation, orgId).create({
    name: normalizedName,
    is_active: true,
  });
}

async function listDesignations(orgId) {
  const designations = await Designation.findAll({
    where: { org_id: orgId, is_active: true },
    order: [['name', 'ASC']],
  });

  return {
    designations: designations.map(mapDesignation),
  };
}

async function createDesignation(orgId, payload = {}) {
  const name = normalizeName(payload.name);

  if (!name) {
    const error = new Error('Designation name is required');
    error.code = 'DESIG_002';
    error.statusCode = 422;
    throw error;
  }

  const existing = await Designation.findOne({
    where: {
      org_id: orgId,
      name: { [Op.iLike]: name },
    },
  });

  if (existing) {
    return mapDesignation(existing);
  }

  const designation = await scopedModel(Designation, orgId).create({
    name,
    description: payload.description || null,
    is_active: payload.isActive !== false,
  });

  return mapDesignation(designation);
}

async function deleteDesignation(orgId, id) {
  const assignedCount = await Employee.count({
    where: {
      org_id: orgId,
      designation_id: id,
    },
  });

  if (assignedCount > 0) {
    const error = new Error('Reassign employees before deleting this designation');
    error.code = 'DESIG_003';
    error.statusCode = 400;
    throw error;
  }

  const deletedCount = await Designation.destroy({
    where: {
      org_id: orgId,
      id,
    },
  });

  if (!deletedCount) {
    const error = new Error('Designation not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  return true;
}

module.exports = {
  findDesignationByIdOrName,
  listDesignations,
  createDesignation,
  deleteDesignation,
};
