const { ImpersonationSession } = require('../models');
const { unauthorized } = require('../utils/response');
const { verifyAccessToken } = require('../utils/auth');

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return unauthorized(res, 'AUTH_001', 'Missing or invalid authorization token');
  }

  const token = authorization.replace('Bearer ', '').trim();

  try {
    const payload = verifyAccessToken(token);

    if (payload.isImpersonated) {
      if (!payload.impersonationSessionId) {
        return unauthorized(res, 'AUTH_001', 'Invalid impersonation token');
      }

      const session = await ImpersonationSession.findOne({
        where: {
          id: payload.impersonationSessionId,
          ended_at: null,
        },
        attributes: ['id', 'ended_at'],
      });

      if (!session) {
        return unauthorized(res, 'AUTH_001', 'Impersonation session has ended');
      }
    }

    req.employee = {
      id: payload.id,
      orgId: payload.orgId || null,
      role: payload.role,
      branch_id: payload.branchId || null,
      impersonatedBy: payload.impersonatedBy || null,
      isImpersonated: Boolean(payload.isImpersonated),
      impersonationSessionId: payload.impersonationSessionId || null,
    };
    return next();
  } catch (error) {
    return unauthorized(res, 'AUTH_001', 'Invalid or expired access token');
  }
}

module.exports = authenticate;
