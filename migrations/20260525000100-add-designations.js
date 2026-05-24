'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    await queryInterface.createTable('designations', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      description: Sequelize.TEXT,
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.addColumn('employees', 'designation_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'designations', key: 'id' },
    });

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX designations_org_lower_name_active
      ON designations (org_id, lower(name))
      WHERE deleted_at IS NULL;
    `);
    await queryInterface.addIndex('employees', ['org_id', 'designation_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('employees', ['org_id', 'designation_id']);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS designations_org_lower_name_active;');
    await queryInterface.removeColumn('employees', 'designation_id');
    await queryInterface.dropTable('designations');
  },
};
