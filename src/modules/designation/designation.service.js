const { Op } = require('sequelize');
const { Designation, Employee } = require('../../models');
const { scopedModel } = require('../../utils/scopedModel');

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function buildCodeFromName(name) {
  return normalizeCode(name);
}

async function createUniqueCode(orgId, name) {
  const baseCode = buildCodeFromName(name) || 'DESIGNATION';
  let code = baseCode;
  let suffix = 1;

  while (await Designation.findOne({ where: { org_id: orgId, code: { [Op.iLike]: code } } })) {
    suffix += 1;
    code = `${baseCode.slice(0, Math.max(1, 40 - String(suffix).length - 1))}-${suffix}`;
  }

  return code;
}

function mapDesignation(designation, employeeCounts = {}) {
  return {
    id: designation.id,
    name: designation.name,
    code: designation.code,
    totalEmployees: Number(employeeCounts[designation.id] || 0),
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
    code: await createUniqueCode(orgId, normalizedName),
    is_active: true,
  });
}

async function listDesignations(orgId) {
  const designations = await Designation.findAll({
    where: { org_id: orgId, is_active: true },
    order: [['name', 'ASC']],
  });
  const counts = await Employee.findAll({
    attributes: [
      'designation_id',
      [Employee.sequelize.fn('COUNT', Employee.sequelize.col('id')), 'totalEmployees'],
    ],
    where: {
      org_id: orgId,
      designation_id: { [Op.ne]: null },
    },
    group: ['designation_id'],
    raw: true,
  });
  const employeeCounts = counts.reduce((accumulator, row) => {
    accumulator[row.designation_id] = Number(row.totalEmployees || 0);
    return accumulator;
  }, {});

  return {
    designations: designations.map((designation) => mapDesignation(designation, employeeCounts)),
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

  const code = payload.code ? normalizeCode(payload.code) : await createUniqueCode(orgId, name);

  if (!code) {
    const error = new Error('Designation code is required');
    error.code = 'DESIG_005';
    error.statusCode = 422;
    throw error;
  }

  const existing = await Designation.findOne({
    where: {
      org_id: orgId,
      [Op.or]: [
        { name: { [Op.iLike]: name } },
        { code: { [Op.iLike]: code } },
      ],
    },
  });

  if (existing) {
    return mapDesignation(existing);
  }

  const designation = await scopedModel(Designation, orgId).create({
    name,
    code,
    is_active: payload.isActive !== false,
  });

  return mapDesignation(designation);
}

async function updateDesignation(orgId, id, payload = {}) {
  const designation = await Designation.findOne({
    where: {
      org_id: orgId,
      id,
    },
  });

  if (!designation) {
    const error = new Error('Designation not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  const name = payload.name === undefined ? designation.name : normalizeName(payload.name);
  const code = payload.code === undefined ? designation.code : normalizeCode(payload.code);

  if (!name) {
    const error = new Error('Designation name is required');
    error.code = 'DESIG_002';
    error.statusCode = 422;
    throw error;
  }

  if (!code) {
    const error = new Error('Designation code is required');
    error.code = 'DESIG_005';
    error.statusCode = 422;
    throw error;
  }

  const duplicate = await Designation.findOne({
    where: {
      org_id: orgId,
      id: { [Op.ne]: id },
      [Op.or]: [
        { name: { [Op.iLike]: name } },
        { code: { [Op.iLike]: code } },
      ],
    },
  });

  if (duplicate) {
    const error = new Error('A designation with this name or code already exists');
    error.code = 'DESIG_004';
    error.statusCode = 409;
    throw error;
  }

  await designation.update({
    name,
    code,
    is_active: typeof payload.isActive === 'boolean' ? payload.isActive : designation.is_active,
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
  updateDesignation,
  deleteDesignation,
};
