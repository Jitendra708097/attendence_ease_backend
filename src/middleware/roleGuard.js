const { fail } = require('../utils/response');

function roleGuard(...allowedRoles) {
  return function roleGuardMiddleware(req, res, next) {
    if (!req.employee) {
      return fail(res, 'AUTH_001', 'Authentication required', [], 401);
    }

    if (!allowedRoles.includes(req.employee.role)) {
      return fail(res, 'AUTH_003', 'Insufficient permissions', [], 403);
    }

    return next();
  };
}

module.exports = roleGuard;
