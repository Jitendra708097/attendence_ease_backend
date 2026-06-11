'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        "ALTER TYPE enum_device_exceptions_status ADD VALUE IF NOT EXISTS 'rejected';",
        { transaction }
      );
    });
  },

  async down() {
    // PostgreSQL enum value removal is intentionally omitted.
  },
};
