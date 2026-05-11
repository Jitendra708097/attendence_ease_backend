const dashboardService = require('./dashboard.service');
const { ok, fail } = require('../../utils/response');

async function adminSummary(req, res) {
  try {
    const data = await dashboardService.getAdminSummary(req.org_id);
    return ok(res, data, 'Admin dashboard summary fetched');
  } catch (error) {
    return fail(res, error.code || 'DASH_001', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  adminSummary,
};
