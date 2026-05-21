'use strict';

const DEFAULT_LEAVE_TYPES = [
  ['annual', 'Annual Leave', 12, true, true, 7],
  ['sick', 'Sick Leave', 8, true, true, 0],
  ['casual', 'Casual Leave', 12, true, true, 1],
  ['earned', 'Earned Leave', 12, true, true, 7],
  ['optional', 'Optional Leave', 2, true, true, 3],
  ['unpaid', 'Unpaid Leave', 0, false, true, 0],
  ['comp_off', 'Comp Off', 0, true, true, 0],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_leave_requests_status') THEN
          ALTER TYPE enum_leave_requests_status ADD VALUE IF NOT EXISTS 'manager_approved';
          ALTER TYPE enum_leave_requests_status ADD VALUE IF NOT EXISTS 'cancellation_pending';
        END IF;
      END
      $$;
    `);

    await queryInterface.createTable('leave_approval_workflows', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      levels: {
        type: Sequelize.JSONB,
        defaultValue: [
          { level: 1, role: 'manager', scope: 'department' },
          { level: 2, role: 'admin', scope: 'org' },
        ],
      },
      auto_approve: { type: Sequelize.BOOLEAN, defaultValue: false },
      is_default: { type: Sequelize.BOOLEAN, defaultValue: true },
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('leave_types', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      code: { type: Sequelize.STRING, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      description: Sequelize.TEXT,
      is_paid: { type: Sequelize.BOOLEAN, defaultValue: true },
      half_day_allowed: { type: Sequelize.BOOLEAN, defaultValue: true },
      include_weekends: { type: Sequelize.BOOLEAN, defaultValue: false },
      include_holidays: { type: Sequelize.BOOLEAN, defaultValue: false },
      allow_negative_balance: { type: Sequelize.BOOLEAN, defaultValue: false },
      max_negative_balance: { type: Sequelize.DECIMAL(6, 1), defaultValue: 0 },
      notice_days: { type: Sequelize.INTEGER, defaultValue: 0 },
      max_consecutive_days: Sequelize.INTEGER,
      min_request_days: { type: Sequelize.DECIMAL(6, 1), defaultValue: 0.5 },
      max_request_days: Sequelize.DECIMAL(6, 1),
      requires_document_after_days: Sequelize.DECIMAL(6, 1),
      yearly_default_balance: { type: Sequelize.DECIMAL(6, 1), defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      sort_order: { type: Sequelize.INTEGER, defaultValue: 0 },
      settings: { type: Sequelize.JSONB, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('leave_policies', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      scope_type: { type: Sequelize.ENUM('org', 'branch', 'department', 'employee'), defaultValue: 'org' },
      scope_id: Sequelize.UUID,
      effective_from: { type: Sequelize.DATEONLY, allowNull: false },
      effective_to: Sequelize.DATEONLY,
      accrual_frequency: { type: Sequelize.ENUM('none', 'monthly', 'quarterly', 'yearly'), defaultValue: 'yearly' },
      entitlements: { type: Sequelize.JSONB, defaultValue: {} },
      carry_forward: { type: Sequelize.JSONB, defaultValue: {} },
      approval_workflow_id: { type: Sequelize.UUID, references: { model: 'leave_approval_workflows', key: 'id' } },
      is_default: { type: Sequelize.BOOLEAN, defaultValue: false },
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      settings: { type: Sequelize.JSONB, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('leave_balance_ledger', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      leave_type_id: { type: Sequelize.UUID, references: { model: 'leave_types', key: 'id' } },
      leave_type: { type: Sequelize.STRING, allowNull: false },
      transaction_type: {
        type: Sequelize.ENUM('opening', 'entitlement', 'accrual', 'debit', 'credit', 'adjustment', 'refund', 'expiry', 'encashment'),
        allowNull: false,
      },
      days: { type: Sequelize.DECIMAL(8, 2), allowNull: false },
      balance_after: { type: Sequelize.DECIMAL(8, 2), allowNull: false },
      request_id: { type: Sequelize.UUID, references: { model: 'leave_requests', key: 'id' } },
      actor_id: { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } },
      reason: Sequelize.TEXT,
      effective_date: { type: Sequelize.DATEONLY, allowNull: false },
      metadata: { type: Sequelize.JSONB, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('payroll_locks', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      period_start: { type: Sequelize.DATEONLY, allowNull: false },
      period_end: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('locked', 'unlocked'), defaultValue: 'locked' },
      locked_by: { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } },
      locked_at: Sequelize.DATE,
      notes: Sequelize.TEXT,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.addIndex('leave_types', ['org_id', 'code'], { unique: true });
    await queryInterface.addIndex('leave_policies', ['org_id', 'scope_type', 'scope_id']);
    await queryInterface.addIndex('leave_balance_ledger', ['org_id', 'emp_id', 'leave_type']);
    await queryInterface.addIndex('leave_balance_ledger', ['org_id', 'request_id']);
    await queryInterface.addIndex('payroll_locks', ['org_id', 'period_start', 'period_end'], { unique: true });

    const addColumn = async (name, definition) => {
      const table = await queryInterface.describeTable('leave_requests');
      if (!table[name]) {
        await queryInterface.addColumn('leave_requests', name, definition);
      }
    };

    await addColumn('leave_type_id', { type: Sequelize.UUID, references: { model: 'leave_types', key: 'id' } });
    await addColumn('approval_level', { type: Sequelize.INTEGER, defaultValue: 1 });
    await addColumn('manager_approved_by', { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } });
    await addColumn('manager_approved_at', { type: Sequelize.DATE });
    await addColumn('final_approved_by', { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } });
    await addColumn('final_approved_at', { type: Sequelize.DATE });
    await addColumn('approval_notes', { type: Sequelize.TEXT });
    await addColumn('document_url', { type: Sequelize.STRING });
    await addColumn('cancellation_reason', { type: Sequelize.TEXT });
    await addColumn('cancellation_requested_by', { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } });
    await addColumn('cancellation_requested_at', { type: Sequelize.DATE });
    await addColumn('cancellation_approved_by', { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } });
    await addColumn('cancellation_approved_at', { type: Sequelize.DATE });
    await addColumn('policy_snapshot', { type: Sequelize.JSONB, defaultValue: {} });
    await addColumn('validation_snapshot', { type: Sequelize.JSONB, defaultValue: {} });
    await addColumn('payroll_locked', { type: Sequelize.BOOLEAN, defaultValue: false });
    await addColumn('payroll_period', { type: Sequelize.STRING });

    await queryInterface.sequelize.query(`
      INSERT INTO leave_approval_workflows (id, org_id, name, levels, auto_approve, is_default, is_active, created_at, updated_at)
      SELECT gen_random_uuid(), id, 'Default Leave Approval',
        '[{"level":1,"role":"manager","scope":"department"},{"level":2,"role":"admin","scope":"org"}]'::jsonb,
        false, true, true, NOW(), NOW()
      FROM organisations
      ON CONFLICT DO NOTHING;
    `);

    for (const [code, name, balance, paid, halfDay, notice] of DEFAULT_LEAVE_TYPES) {
      await queryInterface.sequelize.query(
        `
          INSERT INTO leave_types (
            id, org_id, code, name, is_paid, half_day_allowed, yearly_default_balance,
            notice_days, is_active, sort_order, created_at, updated_at
          )
          SELECT gen_random_uuid(), id, :code, :name, :paid, :halfDay, :balance, :notice, true, 0, NOW(), NOW()
          FROM organisations
          ON CONFLICT (org_id, code) DO NOTHING;
        `,
        { replacements: { code, name, balance, paid, halfDay, notice } }
      );
    }

    await queryInterface.sequelize.query(`
      INSERT INTO leave_policies (
        id, org_id, name, scope_type, effective_from, accrual_frequency,
        entitlements, approval_workflow_id, is_default, is_active, created_at, updated_at
      )
      SELECT gen_random_uuid(), o.id, 'Default Leave Policy', 'org', DATE_TRUNC('year', NOW())::date, 'yearly',
        '{"annual":12,"sick":8,"casual":12,"earned":12,"optional":2,"unpaid":0,"comp_off":0}'::jsonb,
        w.id, true, true, NOW(), NOW()
      FROM organisations o
      LEFT JOIN leave_approval_workflows w ON w.org_id = o.id AND w.is_default = true
      ON CONFLICT DO NOTHING;
    `);

    await queryInterface.sequelize.query(`
      UPDATE leave_requests lr
      SET leave_type_id = lt.id
      FROM leave_types lt
      WHERE lt.org_id = lr.org_id
        AND lt.code = LOWER(lr.leave_type)
        AND lr.leave_type_id IS NULL;
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO leave_balance_ledger (
        id, org_id, emp_id, leave_type_id, leave_type, transaction_type, days,
        balance_after, actor_id, effective_date, reason, metadata, created_at, updated_at
      )
      SELECT gen_random_uuid(), e.org_id, e.id, lt.id, key, 'opening',
        COALESCE((value)::numeric, 0), COALESCE((value)::numeric, 0), NULL, CURRENT_DATE,
        'Migrated opening balance from employee.leave_balance',
        '{"source":"employee.leave_balance"}'::jsonb, NOW(), NOW()
      FROM employees e
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(e.leave_balance, '{}'::jsonb)) b(key, value)
      LEFT JOIN leave_types lt ON lt.org_id = e.org_id AND lt.code = key
      WHERE COALESCE((value)::numeric, 0) <> 0;
    `);
  },

  async down(queryInterface) {
    const columns = [
      'payroll_period',
      'payroll_locked',
      'validation_snapshot',
      'policy_snapshot',
      'cancellation_approved_at',
      'cancellation_approved_by',
      'cancellation_requested_at',
      'cancellation_requested_by',
      'cancellation_reason',
      'document_url',
      'approval_notes',
      'final_approved_at',
      'final_approved_by',
      'manager_approved_at',
      'manager_approved_by',
      'approval_level',
      'leave_type_id',
    ];

    const table = await queryInterface.describeTable('leave_requests');
    for (const column of columns) {
      if (table[column]) {
        await queryInterface.removeColumn('leave_requests', column);
      }
    }

    await queryInterface.dropTable('payroll_locks');
    await queryInterface.dropTable('leave_balance_ledger');
    await queryInterface.dropTable('leave_policies');
    await queryInterface.dropTable('leave_types');
    await queryInterface.dropTable('leave_approval_workflows');
  },
};
