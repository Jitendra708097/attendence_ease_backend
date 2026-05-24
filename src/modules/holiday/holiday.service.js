const { Op } = require('sequelize');
const XLSX = require('xlsx');
const { Branch, Holiday } = require('../../models');

const HOLIDAY_IMPORT_MAX_ROWS = 500;

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

function normalizeCellValue(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeHeader(value) {
  return normalizeCellValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && normalizeCellValue(row[key]) !== '') {
      return row[key];
    }
  }
  return '';
}

function formatDateParts(year, month, day) {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function normalizeExcelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return formatDateParts(parsed.y, parsed.m, parsed.d);
    }
  }

  const text = normalizeCellValue(value);
  if (!text) return '';

  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return formatDateParts(isoMatch[1], isoMatch[2], isoMatch[3]);
  }

  const slashMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (slashMatch) {
    const first = Number(slashMatch[1]);
    const second = Number(slashMatch[2]);
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    return formatDateParts(year, month, day);
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }

  return text;
}

function normalizeBoolean(value) {
  const text = normalizeCellValue(value).toLowerCase();
  return ['true', 'yes', 'y', '1', 'recurring', 'yearly'].includes(text);
}

function mapImportRow(row = {}, branchesByName = new Map()) {
  const normalized = Object.entries(row).reduce((accumulator, [key, value]) => {
    accumulator[normalizeHeader(key)] = value;
    return accumulator;
  }, {});

  const branchId = normalizeCellValue(pickValue(normalized, ['branch_id', 'branchid']));
  const branchName = normalizeCellValue(pickValue(normalized, ['branch_name', 'branch', 'location']));
  const branch = branchName ? branchesByName.get(branchName.toLowerCase()) : null;

  return {
    name: normalizeCellValue(pickValue(normalized, ['name', 'holiday_name', 'holiday', 'title'])),
    date: normalizeExcelDate(pickValue(normalized, ['date', 'holiday_date'])),
    branchId: branchId || branch?.id || null,
    isRecurring: normalizeBoolean(pickValue(normalized, ['is_recurring', 'isrecurring', 'recurring', 'yearly'])),
    description: normalizeCellValue(pickValue(normalized, ['description', 'note', 'notes'])),
  };
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
  const branches = await Branch.findAll({ where: { org_id: orgId }, attributes: ['id', 'name'] });
  const branchesByName = new Map(branches.map((branch) => [branch.name.toLowerCase(), branch]));
  const results = [];

  if (rows.length > HOLIDAY_IMPORT_MAX_ROWS) {
    throw createError('HOLIDAY_004', `You can import at most ${HOLIDAY_IMPORT_MAX_ROWS} holidays at a time`, 422);
  }

  for (const [index, row] of rows.entries()) {
    try {
      const holiday = await createHoliday(orgId, mapImportRow(row, branchesByName));
      results.push({ row: index + 1, status: 'success', holiday });
    } catch (error) {
      results.push({ row: index + 1, status: 'error', message: error.message });
    }
  }

  return {
    total: rows.length,
    created: results.filter((result) => result.status === 'success').length,
    failed: results.filter((result) => result.status === 'error').length,
    results,
  };
}

async function importHolidaysFromFile(orgId, fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!sheet) {
    throw createError('HOLIDAY_004', 'Excel sheet is empty', 422);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return bulkImportHolidays(orgId, { holidays: rows });
}

module.exports = {
  HOLIDAY_IMPORT_MAX_ROWS,
  listHolidays,
  getHoliday,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  bulkImportHolidays,
  importHolidaysFromFile,
};
