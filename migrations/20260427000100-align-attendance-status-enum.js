'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        "ALTER TYPE enum_attendance_status ADD VALUE IF NOT EXISTS 'pending';",
        { transaction }
      );
      await queryInterface.sequelize.query(
        "ALTER TYPE enum_attendance_status ADD VALUE IF NOT EXISTS 'incomplete';",
        { transaction }
      );
    });
  },

  async down() {
    // PostgreSQL enum value removal is intentionally omitted.
  },
};
