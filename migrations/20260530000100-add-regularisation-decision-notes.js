'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'regularisations',
        'manager_notes',
        {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'regularisations',
        'final_notes',
        {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('regularisations', 'final_notes', { transaction }).catch(() => {});
      await queryInterface.removeColumn('regularisations', 'manager_notes', { transaction }).catch(() => {});
    });
  },
};
