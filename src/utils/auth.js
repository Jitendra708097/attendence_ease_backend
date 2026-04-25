const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

function signAccessToken(payload, options = {}) {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: options.expiresIn || env.jwt.accessExpiry,
  });
}

function signRefreshToken(payload, options = {}) {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: options.expiresIn || env.jwt.refreshExpiry,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

async function hashValue(value) {
  return bcrypt.hash(value, 10);
}

async function compareValue(value, hash) {
  return bcrypt.compare(value, hash);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashValue,
  compareValue,
};
