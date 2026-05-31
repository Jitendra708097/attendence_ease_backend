'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_feedback', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      org_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'organisations',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      emp_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'employees',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      rating: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      feedback_type: {
        type: Sequelize.ENUM('bug', 'suggestion', 'confusing', 'other'),
        allowNull: false,
      },
      message: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      employee_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      employee_email: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      employee_phone: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      employee_code: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      app_context: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      deleted_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex('user_feedback', ['org_id', 'created_at']);
    await queryInterface.addIndex('user_feedback', ['emp_id', 'created_at']);
    await queryInterface.addIndex('user_feedback', ['feedback_type']);
    await queryInterface.addIndex('user_feedback', ['rating']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_feedback');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_user_feedback_feedback_type";');
  },
};
