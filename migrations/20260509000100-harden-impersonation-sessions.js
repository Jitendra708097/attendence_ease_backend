'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'impersonation_sessions',
        'expires_at',
        {
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'impersonation_sessions',
        'last_seen_at',
        {
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'impersonation_sessions',
        'ended_by',
        {
          type: Sequelize.UUID,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'impersonation_sessions',
        'end_reason',
        {
          type: Sequelize.STRING,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'impersonation_sessions',
        'ended_from_ip',
        {
          type: Sequelize.STRING,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'impersonation_sessions',
        'ended_user_agent',
        {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'audit_logs',
        'impersonation_session_id',
        {
          type: Sequelize.UUID,
          allowNull: true,
        },
        { transaction }
      );

      await queryInterface.addIndex(
        'impersonation_sessions',
        ['super_admin_id', 'ended_at', 'expires_at'],
        { transaction }
      );

      await queryInterface.addIndex(
        'audit_logs',
        ['impersonation_session_id'],
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex('audit_logs', ['impersonation_session_id'], { transaction }).catch(() => {});
      await queryInterface.removeIndex('impersonation_sessions', ['super_admin_id', 'ended_at', 'expires_at'], { transaction }).catch(() => {});
      await queryInterface.removeColumn('audit_logs', 'impersonation_session_id', { transaction }).catch(() => {});
      await queryInterface.removeColumn('impersonation_sessions', 'ended_user_agent', { transaction }).catch(() => {});
      await queryInterface.removeColumn('impersonation_sessions', 'ended_from_ip', { transaction }).catch(() => {});
      await queryInterface.removeColumn('impersonation_sessions', 'end_reason', { transaction }).catch(() => {});
      await queryInterface.removeColumn('impersonation_sessions', 'ended_by', { transaction }).catch(() => {});
      await queryInterface.removeColumn('impersonation_sessions', 'last_seen_at', { transaction }).catch(() => {});
      await queryInterface.removeColumn('impersonation_sessions', 'expires_at', { transaction }).catch(() => {});
    });
  },
};
