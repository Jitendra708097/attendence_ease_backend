'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('attendance', 'late_by_minutes', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('attendance', 'is_early_checkout', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('attendance', 'early_by_minutes', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('attendance', 'check_out_type', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('attendance', 'source', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'self',
    });
    await queryInterface.addColumn('attendance', 'auto_absent_overridden', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('attendance', 'face_match_score', {
      type: Sequelize.DECIMAL(4, 3),
      allowNull: true,
    });
    await queryInterface.addColumn('attendance', 'face_match_source', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('attendance', 'checkout_grace_job_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('attendance', 'checkout_grace_job_id');
    await queryInterface.removeColumn('attendance', 'face_match_source');
    await queryInterface.removeColumn('attendance', 'face_match_score');
    await queryInterface.removeColumn('attendance', 'auto_absent_overridden');
    await queryInterface.removeColumn('attendance', 'source');
    await queryInterface.removeColumn('attendance', 'check_out_type');
    await queryInterface.removeColumn('attendance', 'early_by_minutes');
    await queryInterface.removeColumn('attendance', 'is_early_checkout');
    await queryInterface.removeColumn('attendance', 'late_by_minutes');
  },
};
