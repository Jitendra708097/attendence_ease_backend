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

async function consumeChallenge(token) {
  const key = getChallengeKey(token);
  const response = await redisClient.multi().get(key).del(key).exec();
  const payload = response && response[0] ? response[0][1] : null;
  const deleted = response && response[1] ? response[1][1] : 0;

  if (!payload || deleted !== 1) {
    return null;
  }

  return JSON.parse(payload);
}

module.exports = {
  createChallenge,
  consumeChallenge,
};
