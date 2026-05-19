const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { redisClient } = require('../config/redis');

const BLACKLIST_PREFIX = 'jwt_blacklist:';

function getBlacklistKey(token) {
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  return `${BLACKLIST_PREFIX}${digest}`;
}

function getTokenTtlSeconds(token) {
  const decoded = jwt.decode(token);

  if (!decoded?.exp) {
    return 0;
  }

  return Math.max(decoded.exp - Math.floor(Date.now() / 1000), 0);
}

async function blacklistToken(token) {
  if (!token) return false;

  const ttlSeconds = getTokenTtlSeconds(token);
  if (ttlSeconds <= 0) return false;

  try {
    await redisClient.set(getBlacklistKey(token), '1', 'EX', ttlSeconds);
    return true;
  } catch (error) {
    console.error('[auth] failed to blacklist JWT:', error.message);
    return false;
  }
}

async function isTokenBlacklisted(token) {
  if (!token) return false;

  try {
    const value = await redisClient.get(getBlacklistKey(token));
    return value === '1';
  } catch (error) {
    console.error('[auth] failed to check JWT blacklist:', error.message);
    return false;
  }
}

module.exports = {
  blacklistToken,
  isTokenBlacklisted,
};
