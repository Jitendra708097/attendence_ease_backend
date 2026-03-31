const Bull = require('bull');
const { redisOptions } = require('../config/redis');

function normalizeRedisConfig(options) {
  if (typeof options === 'string') {
    return options;
  }

  return {
    host: options.host,
    port: options.port,
    username: options.username,
    password: options.password,
  };
}

const queueConnection = normalizeRedisConfig(redisOptions);
const defaultJobOptions = {
  removeOnComplete: true,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
};

const queues = {
  autoAbsent: new Bull('auto-absent', {
    redis: queueConnection,
    defaultJobOptions,
  }),
  checkoutGrace: new Bull('checkout-grace', {
    redis: queueConnection,
    defaultJobOptions,
  }),
  faceEnrollment: new Bull('face-enrollment', {
    redis: queueConnection,
    defaultJobOptions,
  }),
  notification: new Bull('notification', {
    redis: queueConnection,
    defaultJobOptions,
  }),
  reportGeneration: new Bull('report-generation', {
    redis: queueConnection,
    defaultJobOptions,
  }),
  offlineSync: new Bull('offline-sync', {
    redis: queueConnection,
    defaultJobOptions,
  }),
};

module.exports = queues;
