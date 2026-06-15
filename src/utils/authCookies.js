const env = require('../config/env');

const COOKIE_SCOPES = {
  admin: {
    access: 'ae_admin_access_token',
    refresh: 'ae_admin_refresh_token',
  },
  superadmin: {
    access: 'ae_sa_access_token',
    refresh: 'ae_sa_refresh_token',
  },
  legacy: {
    access: 'ae_access_token',
    refresh: 'ae_refresh_token',
  },
};

const ACCESS_COOKIE = COOKIE_SCOPES.admin.access;
const REFRESH_COOKIE = COOKIE_SCOPES.admin.refresh;

function durationToMs(value, fallbackMs) {
  if (!value) return fallbackMs;

  const match = String(value).trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * (multipliers[unit] || 1);
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    maxAge,
    path: '/',
  };
}

function resolveCookieScope(scope) {
  return COOKIE_SCOPES[scope] || COOKIE_SCOPES.admin;
}

function getRequestScope(req) {
  const path = req.originalUrl || req.url || '';
  return path.startsWith('/api/v1/superadmin') || path.startsWith('/superadmin') ? 'superadmin' : 'admin';
}

function clearCookiePair(res, scope) {
  const cookies = resolveCookieScope(scope);
  res.clearCookie(cookies.access, cookieOptions(0));
  res.clearCookie(cookies.refresh, cookieOptions(0));
}

function setScopedAuthCookies(res, { accessToken, refreshToken }, scope = 'admin') {
  const cookies = resolveCookieScope(scope);

  if (accessToken) {
    res.cookie(
      cookies.access,
      accessToken,
      cookieOptions(durationToMs(env.jwt.accessExpiry, 15 * 60 * 1000))
    );
  }

  if (refreshToken) {
    res.cookie(
      cookies.refresh,
      refreshToken,
      cookieOptions(durationToMs(env.jwt.refreshExpiry, 30 * 24 * 60 * 60 * 1000))
    );
  }

  clearCookiePair(res, 'legacy');
}

function setAuthCookies(res, tokens) {
  setScopedAuthCookies(res, tokens, 'admin');
}

function setAdminAuthCookies(res, tokens) {
  setScopedAuthCookies(res, tokens, 'admin');
}

function setSuperadminAuthCookies(res, tokens) {
  setScopedAuthCookies(res, tokens, 'superadmin');
}

function clearScopedAuthCookies(res, scope = 'admin') {
  clearCookiePair(res, scope);
  clearCookiePair(res, 'legacy');
}

function clearAuthCookies(res) {
  clearScopedAuthCookies(res, 'admin');
}

function clearAdminAuthCookies(res) {
  clearScopedAuthCookies(res, 'admin');
}

function clearSuperadminAuthCookies(res) {
  clearScopedAuthCookies(res, 'superadmin');
}

function getAccessTokenFromRequest(req, scope = getRequestScope(req)) {
  const authorization = req.headers.authorization || '';

  if (authorization.startsWith('Bearer ')) {
    return authorization.replace('Bearer ', '').trim();
  }

  const cookies = resolveCookieScope(scope);
  return req.cookies?.[cookies.access] || null;
}

function getRefreshTokenFromRequest(req, scope = getRequestScope(req)) {
  const cookies = resolveCookieScope(scope);
  return req.body?.refreshToken || req.cookies?.[cookies.refresh] || null;
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  COOKIE_SCOPES,
  setAuthCookies,
  setAdminAuthCookies,
  setSuperadminAuthCookies,
  clearAuthCookies,
  clearAdminAuthCookies,
  clearSuperadminAuthCookies,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
};
