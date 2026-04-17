'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('employees', 'password_reset_otp_hash', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    await queryInterface.addColumn('employees', 'password_reset_expires_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('employees', 'password_reset_requested_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addIndex('employees', ['email', 'password_reset_expires_at'], {
      name: 'employees_email_password_reset_expires_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('employees', 'employees_email_password_reset_expires_idx');
    await queryInterface.removeColumn('employees', 'password_reset_requested_at');
    await queryInterface.removeColumn('employees', 'password_reset_expires_at');
    await queryInterface.removeColumn('employees', 'password_reset_otp_hash');
  },
};
