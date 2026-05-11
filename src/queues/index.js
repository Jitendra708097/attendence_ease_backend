const Bull = require('bull');
const { redisOptions } = require('../config/redis');

function buildQueueRedisOptions() {
  if (typeof redisOptions === 'string') {
    return redisOptions;
  }

  return {
    host: redisOptions.host,
    port: redisOptions.port,
    username: redisOptions.username,
    password: redisOptions.password,
  };
}

const defaultJobOptions = {
  removeOnComplete: true,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
};

function createQueue(name) {
  return new Bull(name, {
    redis: buildQueueRedisOptions(),
    defaultJobOptions,
  });
}

const queues = {
  autoAbsent: createQueue('auto-absent'),
  checkoutGrace: createQueue('checkout-grace'),
  faceEnrollment: createQueue('face-enrollment'),
  notification: createQueue('notification'),
  reportGeneration: createQueue('report-generation'),
  offlineSync: createQueue('offline-sync'),
};

async function closeQueues() {
  await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
}

module.exports = {
  ...queues,
  closeQueues,
};
