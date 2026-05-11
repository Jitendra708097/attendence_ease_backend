const { ok, fail } = require('../../utils/response');
const holidayService = require('./holiday.service');

async function list(req, res) {
  try {
    return ok(res, await holidayService.listHolidays(req.org_id, req.query), 'Holidays fetched');
  } catch (error) {
    return fail(res, error.code || 'HOLIDAY_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function get(req, res) {
  try {
    return ok(res, await holidayService.getHoliday(req.org_id, req.params.id), 'Holiday fetched');
  } catch (error) {
    return fail(res, error.code || 'HTTP_404', error.message, error.details || [], error.statusCode || 404);
  }
}

async function create(req, res) {
  try {
    return ok(res, await holidayService.createHoliday(req.org_id, req.body), 'Holiday created', 201);
  } catch (error) {
    return fail(res, error.code || 'HOLIDAY_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function update(req, res) {
  try {
    return ok(res, await holidayService.updateHoliday(req.org_id, req.params.id, req.body), 'Holiday updated');
  } catch (error) {
    return fail(res, error.code || 'HOLIDAY_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    return ok(res, await holidayService.deleteHoliday(req.org_id, req.params.id), 'Holiday deleted');
  } catch (error) {
    return fail(res, error.code || 'HTTP_404', error.message, error.details || [], error.statusCode || 404);
  }
}

async function bulkImport(req, res) {
  try {
    return ok(res, await holidayService.bulkImportHolidays(req.org_id, req.body), 'Holiday import processed');
  } catch (error) {
    return fail(res, error.code || 'HOLIDAY_004', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = { list, get, create, update, remove, bulkImport };
