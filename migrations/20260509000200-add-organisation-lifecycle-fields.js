'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('organisations', 'suspended_at', {
        type: Sequelize.DATE,
        allowNull: true,
      }, { transaction });

      await queryInterface.addColumn('organisations', 'suspended_by', {
        type: Sequelize.UUID,
        allowNull: true,
      }, { transaction });

      await queryInterface.addColumn('organisations', 'suspension_reason', {
        type: Sequelize.TEXT,
        allowNull: true,
      }, { transaction });

      await queryInterface.addColumn('organisations', 'cancelled_at', {
        type: Sequelize.DATE,
        allowNull: true,
      }, { transaction });

      await queryInterface.addColumn('organisations', 'cancelled_by', {
        type: Sequelize.UUID,
        allowNull: true,
      }, { transaction });

      await queryInterface.addColumn('organisations', 'cancellation_reason', {
        type: Sequelize.TEXT,
        allowNull: true,
      }, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('organisations', 'cancellation_reason', { transaction }).catch(() => {});
      await queryInterface.removeColumn('organisations', 'cancelled_by', { transaction }).catch(() => {});
      await queryInterface.removeColumn('organisations', 'cancelled_at', { transaction }).catch(() => {});
      await queryInterface.removeColumn('organisations', 'suspension_reason', { transaction }).catch(() => {});
      await queryInterface.removeColumn('organisations', 'suspended_by', { transaction }).catch(() => {});
      await queryInterface.removeColumn('organisations', 'suspended_at', { transaction }).catch(() => {});
    });
  },
};
