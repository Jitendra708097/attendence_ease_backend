const { Sequelize, sequelize, connectDatabase, databaseConfig } = require('./database');

module.exports = {
  Sequelize,
  sequelize,
  connectDatabase,
  ...databaseConfig,
};
