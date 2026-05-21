const { randomUUID } = require('crypto');
const { redisClient } = require('../../config/redis');

const CHALLENGES = ['blink', 'blink', 'blink', 'blink', 'turn_left', 'turn_right'];
const CHALLENGE_TTL_SECONDS = 180;

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getChallengeKey(token) {
  return `attendance_challenge:${token}`;
}

async function createChallenge({ orgId, empId }) {
  const challengeToken = randomUUID();
  const challengeType = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

  await redisClient.set(
    getChallengeKey(challengeToken),
    JSON.stringify({
      orgId,
      empId,
      challengeType,
      expiresAt,
    }),
    'EX',
    CHALLENGE_TTL_SECONDS
  );

  return {
    challengeToken,
    challengeType,
    expiresAt,
  };
}

async function readChallenge(challengeToken) {
  if (!challengeToken || typeof challengeToken !== 'string') {
    throw createError('ATT_013', 'Invalid challenge token format', 422);
  }

  const key = getChallengeKey(challengeToken);
  const challengeData = await redisClient.get(key);

  if (!challengeData) {
    throw createError('ATT_013', 'Challenge token invalid, expired, or reused', 401);
  }

  try {
    return JSON.parse(challengeData);
  } catch (error) {
    throw createError('ATT_013', 'Challenge token invalid, expired, or reused', 401);
  }
}

async function consumeChallenge(challengeToken) {
  const challenge = await readChallenge(challengeToken);
  await redisClient.del(getChallengeKey(challengeToken));
  return challenge;
}

module.exports = {
  createChallenge,
  readChallenge,
  consumeChallenge,
};
