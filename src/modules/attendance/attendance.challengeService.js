const { randomUUID } = require('crypto');
const { redisClient } = require('../../config/redis');

const CHALLENGES = ['blink', 'turn_left', 'smile'];

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

async function consumeChallenge(challengeToken, result, req) {
  if (!challengeToken || typeof challengeToken !== 'string') {
    throw createError('ATT_013', 'Invalid challenge token format', 422);
  }

  const now = new Date();
  const challenge = await Challenge.findOne({
    where: {
      token: challengeToken,
      consumed: false,
      expires_at: { [Op.gt]: now },
    },
  }, { lock: 'UPDATE' });

  if (!challenge) {
    throw createError('ATT_013', 'Challenge token invalid, expired, or reused', 401);
  }

  // Validate challenge matches the result
  if (challenge.challenge_type !== result.challengeType) {
    throw createError('ATT_014', 'Challenge type mismatch', 422);
  }

  // Mark as consumed atomically
  await challenge.update(
    { consumed: true, consumed_at: now },
    { transaction: req.transaction }
  );

  return challenge;
}

module.exports = {
  createChallenge,
  consumeChallenge,
};
