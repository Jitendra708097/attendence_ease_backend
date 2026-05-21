'use strict';

const DEFAULT_PLANS = [
  {
    code: 'trial',
    name: 'Trial',
    description: 'Free trial for new organisations to validate attendance workflows.',
    billing_type: 'free',
    monthly_price: 0,
    yearly_price: 0,
    price_per_employee: 0,
    trial_days: 15,
    employee_limit: 10,
    branch_limit: 1,
    manager_limit: 2,
    storage_limit_mb: 1024,
    attendance_retention_days: 90,
    features: {
      mobile_attendance: true,
      web_attendance: true,
      face_verification: true,
      geofence: true,
      leave_management: true,
      regularisation: true,
      reports: 'basic',
      multi_branch: false,
      audit_logs: false,
      integrations: false,
      priority_support: false,
    },
    is_active: true,
    is_public: true,
    sort_order: 10,
  },
  {
    code: 'standard',
    name: 'Standard',
    description: 'Production attendance plan for growing teams with leave, reports, and multi-branch support.',
    billing_type: 'per_employee',
    monthly_price: 0,
    yearly_price: 0,
    price_per_employee: 100,
    trial_days: 0,
    employee_limit: null,
    branch_limit: 10,
    manager_limit: null,
    storage_limit_mb: 10240,
    attendance_retention_days: 730,
    features: {
      mobile_attendance: true,
      web_attendance: true,
      face_verification: true,
      geofence: true,
      leave_management: true,
      regularisation: true,
      reports: 'full',
      multi_branch: true,
      audit_logs: true,
      integrations: false,
      priority_support: false,
    },
    is_active: true,
    is_public: true,
    sort_order: 20,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Custom enterprise plan for high scale, advanced controls, integrations, and support.',
    billing_type: 'custom',
    monthly_price: 0,
    yearly_price: 0,
    price_per_employee: 0,
    trial_days: 0,
    employee_limit: null,
    branch_limit: null,
    manager_limit: null,
    storage_limit_mb: null,
    attendance_retention_days: null,
    features: {
      mobile_attendance: true,
      web_attendance: true,
      face_verification: true,
      geofence: true,
      leave_management: true,
      regularisation: true,
      reports: 'advanced',
      multi_branch: true,
      audit_logs: true,
      integrations: true,
      priority_support: true,
      custom_retention: true,
    },
    is_active: true,
    is_public: true,
    sort_order: 30,
  },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    await queryInterface.createTable('plan_definitions', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      code: { type: Sequelize.STRING, allowNull: false, unique: true },
      name: { type: Sequelize.STRING, allowNull: false },
      description: Sequelize.TEXT,
      billing_type: { type: Sequelize.ENUM('free', 'per_employee', 'flat', 'custom'), allowNull: false, defaultValue: 'per_employee' },
      monthly_price: { type: Sequelize.DECIMAL(12, 2), defaultValue: 0 },
      yearly_price: { type: Sequelize.DECIMAL(12, 2), defaultValue: 0 },
      price_per_employee: { type: Sequelize.DECIMAL(12, 2), defaultValue: 0 },
      trial_days: { type: Sequelize.INTEGER, defaultValue: 0 },
      employee_limit: Sequelize.INTEGER,
      branch_limit: Sequelize.INTEGER,
      manager_limit: Sequelize.INTEGER,
      storage_limit_mb: Sequelize.INTEGER,
      attendance_retention_days: Sequelize.INTEGER,
      features: { type: Sequelize.JSONB, defaultValue: {} },
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      is_public: { type: Sequelize.BOOLEAN, defaultValue: true },
      sort_order: { type: Sequelize.INTEGER, defaultValue: 0 },
      metadata: { type: Sequelize.JSONB, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.addColumn('organisations', 'plan_definition_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'plan_definitions', key: 'id' },
    });

    await queryInterface.createTable('plan_change_history', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      old_plan: Sequelize.STRING,
      new_plan: { type: Sequelize.STRING, allowNull: false },
      old_plan_definition_id: { type: Sequelize.UUID, references: { model: 'plan_definitions', key: 'id' } },
      new_plan_definition_id: { type: Sequelize.UUID, references: { model: 'plan_definitions', key: 'id' } },
      actor_id: { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } },
      reason: Sequelize.TEXT,
      effective_at: { type: Sequelize.DATE, allowNull: false },
      metadata: { type: Sequelize.JSONB, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('plan_definitions', ['is_active', 'sort_order']);
    await queryInterface.addIndex('plan_change_history', ['org_id', 'created_at']);
    await queryInterface.addIndex('plan_change_history', ['new_plan']);

    const now = new Date();
    await queryInterface.bulkInsert(
      'plan_definitions',
      DEFAULT_PLANS.map((plan) => ({
        ...plan,
        features: JSON.stringify(plan.features),
        metadata: JSON.stringify({ seeded: true }),
        created_at: now,
        updated_at: now,
      }))
    );

    await queryInterface.sequelize.query(`
      UPDATE organisations org
      SET plan_definition_id = plan_definitions.id,
          settings = COALESCE(org.settings, '{}'::jsonb) || jsonb_build_object(
            'planSnapshot',
            jsonb_build_object(
              'code', plan_definitions.code,
              'name', plan_definitions.name,
              'billingType', plan_definitions.billing_type,
              'pricePerEmployee', plan_definitions.price_per_employee,
              'monthlyPrice', plan_definitions.monthly_price,
              'yearlyPrice', plan_definitions.yearly_price,
              'employeeLimit', plan_definitions.employee_limit,
              'branchLimit', plan_definitions.branch_limit,
              'trialDays', plan_definitions.trial_days,
              'features', plan_definitions.features
            )
          )
      FROM plan_definitions
      WHERE plan_definitions.code = org.plan;
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('organisations', 'plan_definition_id');
    await queryInterface.dropTable('plan_change_history');
    await queryInterface.dropTable('plan_definitions');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS enum_plan_definitions_billing_type;');
  },
};
