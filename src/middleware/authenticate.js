const { unauthorized } = require('../utils/response');
const { verifyAccessToken } = require('../utils/auth');

function authenticate(req, res, next) {
  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return unauthorized(res, 'AUTH_001', 'Missing or invalid authorization token');
  }

  const token = authorization.replace('Bearer ', '').trim();

  try {
    const payload = verifyAccessToken(token);
    req.employee = {
      id: payload.id,
      orgId: payload.orgId || null,
      role: payload.role,
      impersonatedBy: payload.impersonatedBy || null,
    };
    return next();
  } catch (error) {
    return unauthorized(res, 'AUTH_001', 'Invalid or expired access token');
  }
}

module.exports = authenticate;
