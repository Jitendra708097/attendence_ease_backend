const { fail } = require('../../utils/response');

function requireSuperadmin(req, res, next) {
  if (!req.employee) {
    return fail(res, 'AUTH_001', 'Authentication required', [], 401);
  }

  if (req.employee.role !== 'superadmin') {
    return fail(res, 'AUTH_003', 'Superadmin access required', [], 403);
  }

  return next();
}

module.exports = requireSuperadmin;
