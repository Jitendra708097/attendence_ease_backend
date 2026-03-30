const { Sequelize } = require('sequelize');
const env = require('./env');

const databaseConfig = {
  host: env.database.host,
  port: env.database.port,
  database: env.database.name,
  username: env.database.user,
  password: env.database.password,
  dialect: 'postgres',
  logging: env.nodeEnv === 'development' ? console.log : false,
  dialectOptions: env.database.ssl
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      }
    : {},
  define: {
    underscored: true,
    freezeTableName: true,
    timestamps: true,
  },
  timezone: '+00:00',
};

const sequelize = new Sequelize(databaseConfig);

async function connectDatabase() {
  await sequelize.authenticate();
  return sequelize;
}

module.exports = {
  Sequelize,
  sequelize,
  connectDatabase,
  databaseConfig,
};
