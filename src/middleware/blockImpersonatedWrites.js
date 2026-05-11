const { fail } = require('../utils/response');

function blockImpersonatedWrites(req, res, next) {
  if (req.employee?.isImpersonated) {
    return fail(
      res,
      'AUTH_012',
      'This action is blocked during a superadmin impersonation session',
      [],
      403
    );
  }

  return next();
}

module.exports = blockImpersonatedWrites;
