const { randomUUID } = require('crypto');
const { redisClient } = require('../../config/redis');

const CHALLENGES = ['blink', 'turn_left', 'smile'];

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
  const expiresAt = new Date(Date.now() + 30 * 1000).toISOString();

  await redisClient.set(
    getChallengeKey(challengeToken),
    JSON.stringify({
      orgId,
      empId,
      challengeType,
      expiresAt,
    }),
    'EX',
    30
  );

  return {
    challengeToken,
    challengeType,
    expiresAt,
  };
}

async function consumeChallenge(challengeToken) {
  if (!challengeToken || typeof challengeToken !== 'string') {
    throw createError('ATT_013', 'Invalid challenge token format', 422);
  }

  const key = getChallengeKey(challengeToken);
  const challengeData = await redisClient.get(key);

  if (!challengeData) {
    throw createError('ATT_013', 'Challenge token invalid, expired, or reused', 401);
  }

  try {
    const challenge = JSON.parse(challengeData);
    
    // Delete the challenge from Redis to prevent reuse (consume it)
    await redisClient.del(key);
    
    return challenge;
  } catch (error) {
    throw createError('ATT_013', 'Challenge token invalid, expired, or reused', 401);
  }
}

module.exports = {
  createChallenge,
  consumeChallenge,
};
