const { Employee, ImpersonationSession } = require('../models');
const { unauthorized } = require('../utils/response');
const { verifyAccessToken } = require('../utils/auth');
const { getAccessTokenFromRequest } = require('../utils/authCookies');
const { isTokenBlacklisted } = require('../utils/jwtBlacklist');

const IMPERSONATION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

async function authenticate(req, res, next) {
  const token = getAccessTokenFromRequest(req);

  if (!token) {
    return unauthorized(res, 'AUTH_001', 'Missing or invalid authorization token');
  }

  try {
    if (await isTokenBlacklisted(token)) {
      return unauthorized(res, 'AUTH_001', 'Token has been revoked');
    }

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

    const employee = await Employee.findOne({
      where: {
        id: payload.id,
        ...(payload.orgId ? { org_id: payload.orgId } : {}),
        is_active: true,
      },
      attributes: ['id', 'org_id', 'role', 'branch_id'],
    });

    if (!employee) {
      return unauthorized(res, 'AUTH_006', 'Account is suspended or deleted');
    }

    req.employee = {
      id: employee.id,
      orgId: employee.role === 'superadmin' ? null : employee.org_id,
      role: employee.role,
      branch_id: employee.branch_id || null,
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
