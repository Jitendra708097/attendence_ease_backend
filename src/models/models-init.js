/**
 * @module models/models-init
 * @description Sequelize models initialization and database setup.
 * Exports all models and sequelize instance for use throughout app.
 * This file manually imports all models - index.js also provides auto-loading.
 */
const { Sequelize, DataTypes } = require('sequelize');
const dbConfig = require('../config/database.js');

// Import all model factory functions
const ORG = require('./Organisation.js');
const BRANCH = require('./Branch.js');
const DEPT = require('./Department.js');
const EMP = require('./Employee.js');
const SHIFT = require('./Shift.js');
const ATT = require('./Attendance.js');
const ATTSESS = require('./AttendanceSession.js');
const LEAVE = require('./LeaveRequest.js');
const REG = require('./Regularisation.js');
const HOLIDAY = require('./Holiday.js');
const NOTIF = require('./Notification.js');
const DEVTOKEN = require('./DeviceToken.js');
const REFTOKEN = require('./RefreshToken.js');
const IMPEMP = require('./ImpersonationSession.js');
const AUDIT = require('./AuditLog.js');
const DEVEXC = require('./DeviceException.js');

const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  dbConfig.password,
  {
    host: dbConfig.host,
    port: dbConfig.port,
    dialect: dbConfig.dialect,
    logging: dbConfig.logging,
    pool: dbConfig.pool,
    define: {
      underscored: true,
      paranoid: true,
      timestamps: true,
    },
  }
);

// Initialize all models by calling factory functions
const db = {
  Organisation: ORG(sequelize, DataTypes),
  Branch: BRANCH(sequelize, DataTypes),
  Department: DEPT(sequelize, DataTypes),
  Employee: EMP(sequelize, DataTypes),
  Shift: SHIFT(sequelize, DataTypes),
  Attendance: ATT(sequelize, DataTypes),
  AttendanceSession: ATTSESS(sequelize, DataTypes),
  LeaveRequest: LEAVE(sequelize, DataTypes),
  Regularisation: REG(sequelize, DataTypes),
  Holiday: HOLIDAY(sequelize, DataTypes),
  Notification: NOTIF(sequelize, DataTypes),
  DeviceToken: DEVTOKEN(sequelize, DataTypes),
  RefreshToken: REFTOKEN(sequelize, DataTypes),
  ImpersonationSession: IMPEMP(sequelize, DataTypes),
  AuditLog: AUDIT(sequelize, DataTypes),
  DeviceException: DEVEXC(sequelize, DataTypes),
};

// Set up associations
Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
