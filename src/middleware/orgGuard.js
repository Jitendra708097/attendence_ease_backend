const { Organisation } = require('../models');
const { fail } = require('../utils/response');

async function orgGuard(req, res, next) {
  if (!req.employee) {
    return fail(res, 'AUTH_001', 'Authentication required', [], 401);
  }

  if (req.employee.role === 'superadmin') {
    return fail(res, 'AUTH_003', 'Use an impersonation session for organisation-scoped access', [], 403);
  }

  req.org_id = req.employee.orgId;

  const org = await Organisation.findOne({
    where: {
      id: req.org_id,
      is_active: true,
      cancelled_at: null,
    },
    attributes: ['id'],
  });

  if (!org) {
    return fail(res, 'AUTH_007', 'Organisation account is suspended or inactive', [], 403);
  }

  return next();
}

module.exports = orgGuard;
