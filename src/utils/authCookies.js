const env = require('../config/env');

const ACCESS_COOKIE = 'ae_access_token';
const REFRESH_COOKIE = 'ae_refresh_token';

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

function setAuthCookies(res, { accessToken, refreshToken }) {
  if (accessToken) {
    res.cookie(
      ACCESS_COOKIE,
      accessToken,
      cookieOptions(durationToMs(env.jwt.accessExpiry, 15 * 60 * 1000))
    );
  }

  if (refreshToken) {
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      cookieOptions(durationToMs(env.jwt.refreshExpiry, 30 * 24 * 60 * 60 * 1000))
    );
  }
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions(0));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(0));
}

function getAccessTokenFromRequest(req) {
  const authorization = req.headers.authorization || '';

  if (authorization.startsWith('Bearer ')) {
    return authorization.replace('Bearer ', '').trim();
  }

  return req.cookies?.[ACCESS_COOKIE] || null;
}

function getRefreshTokenFromRequest(req) {
  return req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE] || null;
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  setAuthCookies,
  clearAuthCookies,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
};
