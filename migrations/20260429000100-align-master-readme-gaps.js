'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        "ALTER TYPE enum_attendance_status ADD VALUE IF NOT EXISTS 'regularisation_pending';",
        { transaction }
      );

      await queryInterface.addColumn(
        'attendance',
        'client_record_id',
        {
          type: Sequelize.UUID,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addIndex(
        'attendance',
        ['org_id', 'client_record_id'],
        {
          unique: true,
          where: {
            client_record_id: {
              [Sequelize.Op.ne]: null,
            },
          },
          transaction,
        }
      );

      await queryInterface.addColumn(
        'employees',
        'notification_preferences',
        {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: {},
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'device_tokens',
        'is_active',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        { transaction }
      );

      await queryInterface.addIndex(
        'device_tokens',
        ['org_id', 'emp_id', 'is_active'],
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex('device_tokens', ['org_id', 'emp_id', 'is_active'], { transaction }).catch(() => {});
      await queryInterface.removeColumn('device_tokens', 'is_active', { transaction }).catch(() => {});
      await queryInterface.removeColumn('employees', 'notification_preferences', { transaction }).catch(() => {});
      await queryInterface.removeIndex('attendance', ['org_id', 'client_record_id'], { transaction }).catch(() => {});
      await queryInterface.removeColumn('attendance', 'client_record_id', { transaction }).catch(() => {});
    });
  },
};
