'use strict';

const bcrypt = require('bcryptjs');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const branchId = '22222222-2222-2222-2222-222222222222';
    const shiftId = '33333333-3333-3333-3333-333333333333';
    const departmentId = '44444444-4444-4444-4444-444444444444';
    const adminId = '55555555-5555-5555-5555-555555555555';
    const passwordHash = await bcrypt.hash('Admin@12345', 10);

    await queryInterface.bulkInsert('organisations', [
      {
        id: orgId,
        name: 'AttendEase Demo Org',
        slug: 'attendease',
        plan: 'trial',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        is_active: true,
        timezone: 'Asia/Kolkata',
        settings: JSON.stringify({}),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    await queryInterface.bulkInsert('branches', [
      {
        id: branchId,
        org_id: orgId,
        name: 'Main Branch',
        address: 'Demo Branch Address',
        geo_fence_polygons: JSON.stringify([]),
        is_remote: false,
        wifi_verification_enabled: false,
        allowed_bssids: JSON.stringify([]),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    await queryInterface.bulkInsert('departments', [
      {
        id: departmentId,
        org_id: orgId,
        name: 'Administration',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    await queryInterface.bulkInsert('shifts', [
      {
        id: shiftId,
        org_id: orgId,
        name: 'General Shift',
        start_time: '09:00:00',
        end_time: '18:00:00',
        crosses_midnight: false,
        work_days: [1, 2, 3, 4, 5],
        grace_minutes_checkin: 15,
        grace_minutes_checkout: 60,
        half_day_after_minutes: 240,
        absent_after_minutes: 120,
        overtime_after_minutes: 480,
        min_overtime_minutes: 30,
        break_minutes: 60,
        min_session_minutes: 30,
        session_cooldown_minutes: 15,
        max_sessions_per_day: 3,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    await queryInterface.bulkInsert('employees', [
      {
        id: adminId,
        org_id: orgId,
        branch_id: branchId,
        department_id: departmentId,
        shift_id: shiftId,
        emp_code: 'ATTENDEASE-0001',
        name: 'Demo Admin',
        email: 'admin@attendease.local',
        phone: '9999999999',
        role: 'admin',
        password_hash: passwordHash,
        trust_score: 'default',
        checkin_count: 0,
        leave_balance: JSON.stringify({ annual: 12, sick: 6 }),
        is_active: true,
        temp_password: 'Admin@12345',
        password_changed: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('employees', { id: '55555555-5555-5555-5555-555555555555' });
    await queryInterface.bulkDelete('shifts', { id: '33333333-3333-3333-3333-333333333333' });
    await queryInterface.bulkDelete('departments', { id: '44444444-4444-4444-4444-444444444444' });
    await queryInterface.bulkDelete('branches', { id: '22222222-2222-2222-2222-222222222222' });
    await queryInterface.bulkDelete('organisations', { id: '11111111-1111-1111-1111-111111111111' });
  },
};
