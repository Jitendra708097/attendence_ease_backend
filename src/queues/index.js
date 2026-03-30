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

const queues = {
  checkoutGrace: new Bull('checkout-grace', { redis: queueConnection }),
  faceEnrollment: new Bull('face-enrollment', { redis: queueConnection }),
  notification: new Bull('notification', { redis: queueConnection }),
};

module.exports = queues;
