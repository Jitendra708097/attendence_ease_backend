'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('holidays', 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addIndex('holidays', ['org_id', 'date', 'branch_id'], {
      name: 'idx_holidays_org_date_branch',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('holidays', 'idx_holidays_org_date_branch');
    await queryInterface.removeColumn('holidays', 'description');
  },
};
