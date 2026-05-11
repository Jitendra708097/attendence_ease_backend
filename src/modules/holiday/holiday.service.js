const { Op } = require('sequelize');
const { Branch, Holiday } = require('../../models');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function mapHoliday(row) {
  const today = new Date().toISOString().slice(0, 10);

  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    date: row.date,
    branchId: row.branch_id || null,
    branchName: row.branch ? row.branch.name : null,
    scope: row.branch_id ? 'branch' : 'global',
    isRecurring: Boolean(row.is_recurring),
    isUpcoming: row.date >= today,
  };
}

function buildWhere(orgId, query = {}) {
  const where = { org_id: orgId };

  if (query.branchId) {
    where[Op.or] = [{ branch_id: query.branchId }, { branch_id: null }];
  }

  if (query.scope === 'global') {
    where.branch_id = null;
  }

  if (query.scope === 'branch') {
    where.branch_id = { [Op.ne]: null };
  }

  if (query.isRecurring === 'true' || query.isRecurring === true) {
    where.is_recurring = true;
  }

  if (query.isRecurring === 'false' || query.isRecurring === false) {
    where.is_recurring = false;
  }

  if (query.year) {
    const year = String(query.year).trim();
    where.date = {
      ...(where.date || {}),
      [Op.gte]: `${year}-01-01`,
      [Op.lte]: `${year}-12-31`,
    };
  }

  if (query.month) {
    const year = String(query.year || new Date().getUTCFullYear()).trim();
    const month = String(query.month).padStart(2, '0');
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    where.date = {
      ...(where.date || {}),
      [Op.gte]: `${year}-${month}-01`,
      [Op.lte]: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  if (query.from || query.to) {
    where.date = {};
    if (query.from) where.date[Op.gte] = query.from;
    if (query.to) where.date[Op.lte] = query.to;
  }

  if (query.search) {
    where.name = { [Op.iLike]: `%${String(query.search).trim()}%` };
  }

  return where;
}

async function listHolidays(orgId, query = {}) {
  const rows = await Holiday.findAll({
    where: buildWhere(orgId, query),
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'], required: false }],
    order: [['date', 'ASC'], ['name', 'ASC']],
  });

  const holidays = rows.map(mapHoliday);
  const today = new Date().toISOString().slice(0, 10);

  return {
    holidays,
    stats: {
      total: holidays.length,
      upcoming: holidays.filter((holiday) => holiday.date >= today).length,
      global: holidays.filter((holiday) => holiday.scope === 'global').length,
      branchSpecific: holidays.filter((holiday) => holiday.scope === 'branch').length,
      recurring: holidays.filter((holiday) => holiday.isRecurring).length,
    },
    upcoming: holidays.filter((holiday) => holiday.date >= today).slice(0, 5),
  };
}

async function getHoliday(orgId, id) {
  const holiday = await Holiday.findOne({
    where: { id, org_id: orgId },
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'], required: false }],
  });

  if (!holiday) {
    throw createError('HTTP_404', 'Holiday not found', 404);
  }

  return mapHoliday(holiday);
}

async function ensureBranch(orgId, branchId) {
  if (!branchId) return null;
  const branch = await Branch.findOne({ where: { id: branchId, org_id: orgId } });
  if (!branch) {
    throw createError('HOLIDAY_002', 'Branch not found for this organisation', 422);
  }
  return branch;
}

async function ensureUniqueHoliday(orgId, { id = null, name, date, branchId }) {
  const where = {
    org_id: orgId,
    date,
    branch_id: branchId || null,
    name: { [Op.iLike]: name },
  };

  if (id) {
    where.id = { [Op.ne]: id };
  }

  const duplicate = await Holiday.findOne({ where });
  if (duplicate) {
    throw createError('HOLIDAY_005', 'A holiday with the same name, date, and branch scope already exists', 409);
  }
}

async function createHoliday(orgId, body = {}) {
  const name = String(body.name || '').trim();
  const date = String(body.date || '').trim();
  const branchId = body.branchId || body.branch_id || null;
  const description = String(body.description || '').trim();

  if (!name || !date) {
    throw createError('HOLIDAY_001', 'Holiday name and date are required', 422);
  }

  await ensureBranch(orgId, branchId);
  await ensureUniqueHoliday(orgId, { name, date, branchId });

  const holiday = await Holiday.create({
    org_id: orgId,
    branch_id: branchId,
    name,
    description,
    date,
    is_recurring: Boolean(body.isRecurring || body.is_recurring),
  });

  return getHoliday(orgId, holiday.id);
}

async function updateHoliday(orgId, id, body = {}) {
  const holiday = await Holiday.findOne({ where: { id, org_id: orgId } });

  if (!holiday) {
    throw createError('HTTP_404', 'Holiday not found', 404);
  }

  const branchId = body.branchId ?? body.branch_id ?? holiday.branch_id;
  const name = String(body.name ?? holiday.name).trim();
  const date = String(body.date ?? holiday.date).trim();
  await ensureBranch(orgId, branchId);
  await ensureUniqueHoliday(orgId, { id, name, date, branchId });

  await holiday.update({
    name,
    description: body.description !== undefined ? String(body.description || '').trim() : holiday.description,
    date,
    branch_id: branchId || null,
    is_recurring:
      typeof body.isRecurring === 'boolean'
        ? body.isRecurring
        : typeof body.is_recurring === 'boolean'
          ? body.is_recurring
          : holiday.is_recurring,
  });

  return getHoliday(orgId, holiday.id);
}

async function deleteHoliday(orgId, id) {
  const holiday = await Holiday.findOne({ where: { id, org_id: orgId } });

  if (!holiday) {
    throw createError('HTTP_404', 'Holiday not found', 404);
  }

  await holiday.destroy();
  return { id, deleted: true };
}

async function bulkImportHolidays(orgId, body = {}) {
  const rows = Array.isArray(body.holidays) ? body.holidays : [];
  const results = [];

  for (const [index, row] of rows.entries()) {
    try {
      const holiday = await createHoliday(orgId, row);
      results.push({ row: index + 1, status: 'success', holiday });
    } catch (error) {
      results.push({ row: index + 1, status: 'error', message: error.message });
    }
  }

  return { results };
}

module.exports = {
  listHolidays,
  getHoliday,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  bulkImportHolidays,
};
