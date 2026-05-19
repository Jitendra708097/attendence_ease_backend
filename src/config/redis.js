const Redis = require('ioredis');
const env = require('./env');

// console.log("env: ",env);

const redisOptions = env.redis.url
  ? {
      url: env.redis.url,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    }
  : {
      host: env.redis.host,
      port: env.redis.port,
      username: env.redis.username,
      password: env.redis.password,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    };

const redisClient = redisOptions.url
  ? new Redis(redisOptions.url, {
      lazyConnect: redisOptions.lazyConnect,
      maxRetriesPerRequest: redisOptions.maxRetriesPerRequest,
    })
  : new Redis(redisOptions);

redisClient.on('error', (error) => {
  console.error('[redis] connection error:', error.message);
});

function createRedisConnection(overrides = {}) {
  const { omitMaxRetriesPerRequest = false, ...redisOverrides } = overrides;

  if (redisOptions.url) {
    const options = {
      lazyConnect: redisOptions.lazyConnect,
      ...redisOverrides,
    };

    if (!omitMaxRetriesPerRequest) {
      options.maxRetriesPerRequest = redisOptions.maxRetriesPerRequest;
    }

    return new Redis(redisOptions.url, options);
  }

  const options = {
    ...redisOptions,
    ...redisOverrides,
  };

  if (omitMaxRetriesPerRequest) {
    delete options.maxRetriesPerRequest;
  }

  return new Redis(options);
}

async function connectRedis() {
  if (redisClient.status === 'ready' || redisClient.status === 'connect') {
    return redisClient;
  }

  await redisClient.connect();
  return redisClient;
}

module.exports = {
  Redis,
  redisClient,
  redisOptions,
  createRedisConnection,
  connectRedis,
};
