const Bull = require('bull');
const { createRedisConnection } = require('../config/redis');

function createQueueClient(type, queueName) {
  return createRedisConnection({
    connectionName: `attendease:bull:${queueName}:${type}`,
    lazyConnect: false,
    ...(type === 'bclient' || type === 'subscriber'
      ? {
          enableReadyCheck: false,
          maxRetriesPerRequest: null,
        }
      : {}),
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

function createQueue(name) {
  return new Bull(name, {
    createClient: (type) => createQueueClient(type, name),
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
