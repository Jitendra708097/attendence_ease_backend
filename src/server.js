const env = require('./config/env');
const { connectDatabase } = require('./config/database');
const { connectRedis, redisClient } = require('./config/redis');
const app = require('./app');
const { registerQueues, closeQueues } = require('./queues/bootstrap');

let server;
let shuttingDown = false;

async function startServer() {
  const connectionResults = await Promise.allSettled([connectDatabase(), connectRedis()]);

  if (connectionResults[0].status === 'fulfilled') {
    console.log('[bootstrap] Connected to PostgreSQL');
  } else {
    console.error('[bootstrap] PostgreSQL connection failed:', connectionResults[0].reason.message);
  }

  if (connectionResults[1].status === 'fulfilled') {
    console.log('[bootstrap] Connected to Redis');
  } else {
    console.error('[bootstrap] Redis connection failed:', connectionResults[1].reason.message);
  }

  if (env.nodeEnv === 'production' && connectionResults.some((result) => result.status === 'rejected')) {
    throw new Error('Failed to connect to required external services');
  }

  registerQueues();

  server = app.listen(env.port,'0.0.0.0', () => {
    console.log(`[bootstrap] Server listening on port ${env.port}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[bootstrap] Port ${env.port} is already in use`);
      process.exit(1);
    }

    console.error('[bootstrap] Server error:', error);
    process.exit(1);
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[bootstrap] Received ${signal}, shutting down...`);

  if (!server) {
    process.exit(0);
  }

  server.close(async () => {
    try {
      await closeQueues();
      console.log('[bootstrap] Queue connections closed');
    } catch (error) {
      console.error('[bootstrap] Failed to close queues cleanly:', error.message);
    }

    try {
      if (redisClient.status === 'ready' || redisClient.status === 'connect') {
        await redisClient.quit();
        console.log('[bootstrap] Redis connection closed');
      }
    } catch (error) {
      console.error('[bootstrap] Failed to close Redis cleanly:', error.message);
    }

    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGUSR2', () => {
  shutdown('SIGUSR2').finally(() => {
    process.kill(process.pid, 'SIGUSR2');
  });
});

startServer().catch((error) => {
  console.error('[bootstrap] Startup failed:', error);
  process.exit(1);
});
