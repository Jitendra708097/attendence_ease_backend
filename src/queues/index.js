const Bull = require('bull');
const { createRedisConnection } = require('../config/redis');

let sharedQueueClient = null;
let sharedQueueSubscriber = null;

function getSharedQueueClient() {
  if (!sharedQueueClient) {
    sharedQueueClient = createRedisConnection({
      connectionName: 'attendease:bull:client',
    });
    sharedQueueClient.setMaxListeners(30);
  }

  return sharedQueueClient;
}

function getSharedQueueSubscriber() {
  if (!sharedQueueSubscriber) {
    sharedQueueSubscriber = createRedisConnection({
      connectionName: 'attendease:bull:subscriber',
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });
    sharedQueueSubscriber.setMaxListeners(30);
  }

  return sharedQueueSubscriber;
}

function createQueueClient(type) {
  if (type === 'client') {
    return getSharedQueueClient();
  }

  if (type === 'subscriber') {
    return getSharedQueueSubscriber();
  }

  return createRedisConnection({
    connectionName: `attendease:bull:${type}`,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
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
    createClient: createQueueClient,
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
  await Promise.allSettled(
    [sharedQueueClient, sharedQueueSubscriber]
      .filter(Boolean)
      .map((client) => client.quit())
  );
  sharedQueueClient = null;
  sharedQueueSubscriber = null;
}

module.exports = {
  ...queues,
  closeQueues,
};
