const env = require('../src/config/env');

module.exports = {
  development: {
    username: env.database.user,
    password: env.database.password,
    database: env.database.name,
    host: env.database.host,
    port: env.database.port,
    dialect: 'postgres',
    logging: false,
    dialectOptions: env.database.ssl
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false,
          },
        }
      : {},
    timezone: '+00:00',
  },
  test: {
    username: env.database.user,
    password: env.database.password,
    database: env.database.name,
    host: env.database.host,
    port: env.database.port,
    dialect: 'postgres',
    logging: false,
    timezone: '+00:00',
  },
  production: {
    username: env.database.user,
    password: env.database.password,
    database: env.database.name,
    host: env.database.host,
    port: env.database.port,
    dialect: 'postgres',
    logging: false,
    dialectOptions: env.database.ssl
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false,
          },
        }
      : {},
    timezone: '+00:00',
  },
};
