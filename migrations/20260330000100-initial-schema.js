'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('organisations', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      slug: { type: Sequelize.STRING, allowNull: false, unique: true },
      plan: { type: Sequelize.ENUM('trial', 'starter', 'growth', 'enterprise'), defaultValue: 'trial' },
      trial_ends_at: Sequelize.DATE,
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      timezone: { type: Sequelize.STRING, defaultValue: 'Asia/Kolkata' },
      settings: { type: Sequelize.JSONB, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('branches', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      address: Sequelize.TEXT,
      geo_fence_polygons: Sequelize.JSONB,
      is_remote: { type: Sequelize.BOOLEAN, defaultValue: false },
      wifi_verification_enabled: { type: Sequelize.BOOLEAN, defaultValue: false },
      allowed_bssids: { type: Sequelize.JSONB, defaultValue: [] },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('departments', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      parent_id: { type: Sequelize.UUID, references: { model: 'departments', key: 'id' } },
      head_emp_id: Sequelize.UUID,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('shifts', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      start_time: { type: Sequelize.TIME, allowNull: false },
      end_time: { type: Sequelize.TIME, allowNull: false },
      crosses_midnight: { type: Sequelize.BOOLEAN, defaultValue: false },
      work_days: { type: Sequelize.ARRAY(Sequelize.INTEGER), defaultValue: [1, 2, 3, 4, 5] },
      grace_minutes_checkin: { type: Sequelize.INTEGER, defaultValue: 15 },
      grace_minutes_checkout: { type: Sequelize.INTEGER, defaultValue: 60 },
      half_day_after_minutes: { type: Sequelize.INTEGER, defaultValue: 240 },
      absent_after_minutes: { type: Sequelize.INTEGER, defaultValue: 120 },
      overtime_after_minutes: { type: Sequelize.INTEGER, defaultValue: 480 },
      min_overtime_minutes: { type: Sequelize.INTEGER, defaultValue: 30 },
      break_minutes: { type: Sequelize.INTEGER, defaultValue: 60 },
      min_session_minutes: { type: Sequelize.INTEGER, defaultValue: 30 },
      session_cooldown_minutes: { type: Sequelize.INTEGER, defaultValue: 15 },
      max_sessions_per_day: { type: Sequelize.INTEGER, defaultValue: 3 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('employees', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      branch_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'branches', key: 'id' } },
      department_id: { type: Sequelize.UUID, references: { model: 'departments', key: 'id' } },
      shift_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'shifts', key: 'id' } },
      emp_code: Sequelize.STRING,
      name: { type: Sequelize.STRING, allowNull: false },
      email: Sequelize.STRING,
      phone: Sequelize.STRING,
      role: { type: Sequelize.ENUM('admin', 'manager', 'employee', 'superadmin'), defaultValue: 'employee' },
      password_hash: Sequelize.STRING,
      face_embedding_local: Sequelize.JSONB,
      face_embedding_id: Sequelize.STRING,
      face_enrolled_at: Sequelize.DATE,
      registered_device_id: Sequelize.STRING,
      trust_score: { type: Sequelize.ENUM('probationary', 'default', 'trusted', 'flagged'), defaultValue: 'probationary' },
      checkin_count: { type: Sequelize.INTEGER, defaultValue: 0 },
      leave_balance: { type: Sequelize.JSONB, defaultValue: {} },
      is_active: { type: Sequelize.BOOLEAN, defaultValue: true },
      temp_password: Sequelize.STRING,
      password_changed: { type: Sequelize.BOOLEAN, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('attendance', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      branch_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'branches', key: 'id' } },
      shift_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'shifts', key: 'id' } },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('present', 'absent', 'half_day', 'half_day_early', 'on_leave', 'holiday', 'weekend', 'not_marked'), defaultValue: 'not_marked' },
      first_check_in: Sequelize.DATE,
      last_check_out: Sequelize.DATE,
      total_worked_minutes: { type: Sequelize.INTEGER, defaultValue: 0 },
      session_count: { type: Sequelize.INTEGER, defaultValue: 0 },
      is_late: { type: Sequelize.BOOLEAN, defaultValue: false },
      is_overtime: { type: Sequelize.BOOLEAN, defaultValue: false },
      overtime_minutes: { type: Sequelize.INTEGER, defaultValue: 0 },
      is_finalised: { type: Sequelize.BOOLEAN, defaultValue: false },
      is_anomaly: { type: Sequelize.BOOLEAN, defaultValue: false },
      is_manual: { type: Sequelize.BOOLEAN, defaultValue: false },
      marked_by: Sequelize.UUID,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('attendance_sessions', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      attendance_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'attendance', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      session_number: { type: Sequelize.INTEGER, allowNull: false },
      check_in_time: { type: Sequelize.DATE, allowNull: false },
      check_out_time: Sequelize.DATE,
      check_in_lat: Sequelize.DECIMAL(10, 8),
      check_in_lng: Sequelize.DECIMAL(11, 8),
      check_out_lat: Sequelize.DECIMAL(10, 8),
      check_out_lng: Sequelize.DECIMAL(11, 8),
      selfie_url: Sequelize.STRING,
      worked_minutes: { type: Sequelize.INTEGER, defaultValue: 0 },
      status: { type: Sequelize.ENUM('open', 'completed', 'auto_closed'), defaultValue: 'open' },
      is_undo_eligible: { type: Sequelize.BOOLEAN, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('leave_requests', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      leave_type: { type: Sequelize.STRING, allowNull: false },
      from_date: { type: Sequelize.DATEONLY, allowNull: false },
      to_date: { type: Sequelize.DATEONLY, allowNull: false },
      days_count: Sequelize.DECIMAL(4, 1),
      is_half_day: { type: Sequelize.BOOLEAN, defaultValue: false },
      half_day_period: Sequelize.ENUM('morning', 'afternoon'),
      reason: Sequelize.TEXT,
      status: { type: Sequelize.ENUM('pending', 'approved', 'rejected', 'cancelled'), defaultValue: 'pending' },
      approved_by: Sequelize.UUID,
      approved_at: Sequelize.DATE,
      rejection_reason: Sequelize.TEXT,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('regularisations', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      attendance_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'attendance', key: 'id' } },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      requested_check_in: Sequelize.DATE,
      requested_check_out: Sequelize.DATE,
      reason: { type: Sequelize.TEXT, allowNull: false },
      evidence_type: { type: Sequelize.ENUM('email', 'photo', 'document', 'other'), allowNull: false },
      evidence_url: Sequelize.STRING,
      status: { type: Sequelize.ENUM('pending', 'manager_approved', 'approved', 'rejected'), defaultValue: 'pending' },
      manager_approved_by: Sequelize.UUID,
      manager_approved_at: Sequelize.DATE,
      final_approved_by: Sequelize.UUID,
      final_approved_at: Sequelize.DATE,
      rejection_reason: Sequelize.TEXT,
      is_manual: { type: Sequelize.BOOLEAN, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('holidays', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      branch_id: { type: Sequelize.UUID, references: { model: 'branches', key: 'id' } },
      name: { type: Sequelize.STRING, allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      is_recurring: { type: Sequelize.BOOLEAN, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('notifications', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      type: { type: Sequelize.STRING, allowNull: false },
      title: { type: Sequelize.STRING, allowNull: false },
      body: { type: Sequelize.TEXT, allowNull: false },
      action_url: Sequelize.STRING,
      is_read: { type: Sequelize.BOOLEAN, defaultValue: false },
      read_at: Sequelize.DATE,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('device_tokens', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      fcm_token: { type: Sequelize.STRING, allowNull: false },
      device_id: Sequelize.STRING,
      is_primary: { type: Sequelize.BOOLEAN, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('audit_logs', {
      id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true, allowNull: false },
      org_id: Sequelize.UUID,
      actor_id: Sequelize.UUID,
      actor_role: Sequelize.STRING,
      action: { type: Sequelize.STRING, allowNull: false },
      entity_type: Sequelize.STRING,
      entity_id: Sequelize.STRING,
      old_value: Sequelize.JSONB,
      new_value: Sequelize.JSONB,
      ip_address: Sequelize.STRING,
      user_agent: Sequelize.STRING,
      impersonated_by: Sequelize.UUID,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('refresh_tokens', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      token_hash: { type: Sequelize.STRING, allowNull: false },
      device_id: Sequelize.STRING,
      status: { type: Sequelize.ENUM('active', 'used', 'revoked'), defaultValue: 'active' },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('impersonation_sessions', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      super_admin_id: { type: Sequelize.UUID, allowNull: false },
      target_org_id: { type: Sequelize.UUID, references: { model: 'organisations', key: 'id' } },
      target_emp_id: { type: Sequelize.UUID, references: { model: 'employees', key: 'id' } },
      reason: { type: Sequelize.TEXT, allowNull: false },
      started_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      ended_at: Sequelize.DATE,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.createTable('device_exceptions', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      org_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'organisations', key: 'id' } },
      emp_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' } },
      temp_device_id: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.ENUM('pending', 'approved', 'used', 'expired'), defaultValue: 'pending' },
      expires_at: Sequelize.DATE,
      approved_by: Sequelize.UUID,
      approved_at: Sequelize.DATE,
      reason: Sequelize.TEXT,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: Sequelize.DATE,
    });

    await queryInterface.addIndex('employees', ['org_id', 'emp_code'], { unique: true });
    await queryInterface.addIndex('attendance', ['org_id', 'emp_id', 'date'], { unique: true });
    await queryInterface.addIndex('device_tokens', ['emp_id', 'fcm_token'], { unique: true });
    await queryInterface.addIndex('notifications', ['is_read'], { where: { is_read: false } });
  },

  async down(queryInterface) {
    const dropTables = [
      'device_exceptions',
      'impersonation_sessions',
      'refresh_tokens',
      'audit_logs',
      'device_tokens',
      'notifications',
      'holidays',
      'regularisations',
      'leave_requests',
      'attendance_sessions',
      'attendance',
      'employees',
      'shifts',
      'departments',
      'branches',
      'organisations',
    ];

    for (const table of dropTables) {
      await queryInterface.dropTable(table);
    }
  },
};
