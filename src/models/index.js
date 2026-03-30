/**
 * @module models/index
 * @description Sequelize model loader and association setup.
 *
 * Reuses the single Sequelize instance created in config/database.js
 * so there is ONE connection pool across the entire application.
 *
 * Loads every *.js file in this directory (except index.js and models-init.js),
 * calls each factory function, and runs associate() on all models.
 *
 * Usage:
 *   const { models, sequelize, Sequelize } = require('./models/index.js');
 *   // or, for convenience:
 *   const db = require('./models/index.js');
 *   db.Employee.findOne(...)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Reuse the singleton — avoids opening a second connection pool
const { sequelize } = require('../config/database.js');
const { Sequelize }  = require('sequelize');

const db = {};

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-LOAD ALL MODEL FILES
// ─────────────────────────────────────────────────────────────────────────────

const EXCLUDED = new Set(['index.js', 'models-init.js']);

fs.readdirSync(__dirname)
  .filter((file) => file.endsWith('.js') && !EXCLUDED.has(file))
  .forEach((file) => {
    try {
      const factory = require(path.join(__dirname, file));
      const model   = factory(sequelize, Sequelize.DataTypes);
      db[model.name] = model;
    } catch (err) {
      console.error(`[models/index] Failed to load model from ${file}:`, err.message);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// RUN ASSOCIATIONS
// ─────────────────────────────────────────────────────────────────────────────

Object.values(db).forEach((model) => {
  if (typeof model.associate === 'function') {
    model.associate(db);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

db.sequelize = sequelize;
db.Sequelize = Sequelize;
db.models    = db; // convenience alias so `db.models.Employee` also works

module.exports = db;