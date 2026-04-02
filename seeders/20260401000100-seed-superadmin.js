'use strict';

const bcrypt = require('bcryptjs');

module.exports = {
  async up(queryInterface) {
    const superAdminId = '66666666-6666-6666-6666-666666666666';
    const passwordHash = await bcrypt.hash('SuperAdmin@12345', 10);

    await queryInterface.bulkInsert('employees', [
      {
        id: superAdminId,
        org_id: '11111111-1111-1111-1111-111111111111',
        branch_id: '22222222-2222-2222-2222-222222222222',
        department_id: '44444444-4444-4444-4444-444444444444',
        shift_id: '33333333-3333-3333-3333-333333333333',
        emp_code: 'SUPERADMIN-0001',
        name: 'Platform Superadmin',
        email: 'superadmin@attendease.local',
        phone: '8888888888',
        role: 'superadmin',
        password_hash: passwordHash,
        trust_score: 'trusted',
        checkin_count: 0,
        leave_balance: JSON.stringify({}),
        is_active: true,
        temp_password: 'SuperAdmin@12345',
        password_changed: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('employees', {
      id: '66666666-6666-6666-6666-666666666666',
    });
  },
};
