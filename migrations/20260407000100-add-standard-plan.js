'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_organisations_plan"
      ADD VALUE IF NOT EXISTS 'standard';
    `);

    await queryInterface.sequelize.query(`
      UPDATE organisations
      SET plan = 'standard'
      WHERE plan IN ('starter', 'growth', 'enterprise');
    `);
  },

  async down() {
    // Postgres enums cannot safely remove values in a simple down migration.
  },
};
