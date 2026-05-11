'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'notifications',
        'data',
        {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: {},
        },
        { transaction }
      ).catch(() => {});

      await queryInterface.addColumn(
        'device_tokens',
        'platform',
        {
          type: Sequelize.STRING(20),
          allowNull: true,
        },
        { transaction }
      ).catch(() => {});

      await queryInterface.addIndex(
        'device_tokens',
        ['emp_id'],
        {
          where: { is_active: true },
          name: 'device_tokens_active_emp_id_idx',
          transaction,
        }
      ).catch(() => {});

      await queryInterface.addIndex(
        'notifications',
        ['emp_id'],
        {
          where: { is_read: false },
          name: 'notifications_unread_emp_id_idx',
          transaction,
        }
      ).catch(() => {});
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex('notifications', 'notifications_unread_emp_id_idx', { transaction }).catch(() => {});
      await queryInterface.removeIndex('device_tokens', 'device_tokens_active_emp_id_idx', { transaction }).catch(() => {});
      await queryInterface.removeColumn('device_tokens', 'platform', { transaction }).catch(() => {});
      await queryInterface.removeColumn('notifications', 'data', { transaction }).catch(() => {});
    });
  },
};
