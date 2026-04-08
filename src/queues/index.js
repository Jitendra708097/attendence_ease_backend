const Bull = require('bull');
const { Redis, redisOptions } = require('../config/redis');

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

let sharedClient = null;
let sharedSubscriber = null;

function buildRedisClient() {
  const options = buildQueueRedisOptions();

  if (typeof options === 'string') {
    return new Redis(options, {
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });
  }

  return new Redis({
    ...options,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
}

function createQueue(name) {
  return new Bull(name, {
    createClient(type) {
      switch (type) {
        case 'client':
          if (!sharedClient) {
            sharedClient = buildRedisClient();
          }
          return sharedClient;
        case 'subscriber':
          if (!sharedSubscriber) {
            sharedSubscriber = buildRedisClient();
          }
          return sharedSubscriber;
        case 'bclient':
          return buildRedisClient();
        default:
          return buildRedisClient();
      }
    },
    defaultJobOptions,
  });
}

const defaultJobOptions = {
  removeOnComplete: true,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
};

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

  if (sharedSubscriber) {
    await sharedSubscriber.quit().catch(() => {});
    sharedSubscriber = null;
  }

  if (sharedClient) {
    await sharedClient.quit().catch(() => {});
    sharedClient = null;
  }
}

module.exports = {
  ...queues,
  closeQueues,
};
