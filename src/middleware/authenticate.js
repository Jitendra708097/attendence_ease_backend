const { ImpersonationSession } = require('../models');
const { unauthorized } = require('../utils/response');
const { verifyAccessToken } = require('../utils/auth');

const IMPERSONATION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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
        attributes: ['id', 'started_at', 'ended_at', 'expires_at', 'last_seen_at'],
      });

      if (!session) {
        return unauthorized(res, 'AUTH_001', 'Impersonation session has ended');
      }

      const now = new Date();
      const expiresAt = session.expires_at || new Date(new Date(session.started_at).getTime() + 4 * 60 * 60 * 1000);
      const expired = expiresAt <= now;
      const lastSeenAt = session.last_seen_at || session.started_at;
      const idleExpired = lastSeenAt && now.getTime() - new Date(lastSeenAt).getTime() > IMPERSONATION_IDLE_TIMEOUT_MS;

      if (expired || idleExpired) {
        await session.update({
          ended_at: now,
          ended_by: payload.impersonatedBy || null,
          end_reason: expired ? 'expired' : 'idle_timeout',
          ended_from_ip: req.ip,
          ended_user_agent: req.headers['user-agent'] || null,
        });

        return unauthorized(
          res,
          'AUTH_001',
          expired ? 'Impersonation session has expired' : 'Impersonation session ended due to inactivity'
        );
      }

      await session.update({ last_seen_at: now });
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
