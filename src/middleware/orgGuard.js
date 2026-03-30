const { fail } = require('../utils/response');

function orgGuard(req, res, next) {
  if (!req.employee) {
    return fail(res, 'AUTH_001', 'Authentication required', [], 401);
  }

  if (req.employee.role === 'superadmin') {
    req.org_id = req.params.orgId || req.body.orgId || null;
    return next();
  }

  req.org_id = req.employee.orgId;
  return next();
}

module.exports = orgGuard;
