'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const testEmail = 'raviyadav264209@gmail.com';

    // Define leave balance for testing
    const leaveBalance = {
      annual: 10,
      casual: 12,
      sick: 5,
      earned: 8,
      optional: 4,
    };

    // Find employee by email in ANY organization
    const employees = await queryInterface.sequelize.query(
      `SELECT id, org_id, name, email, leave_balance FROM employees WHERE email = :email LIMIT 1`,
      {
        replacements: { email: testEmail },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    if (employees.length === 0) {
      console.error(`❌ Employee with email ${testEmail} not found in database`);
      throw new Error(`Employee ${testEmail} not found`);
    }

    const employee = employees[0];
    const { id: adminId, org_id: orgId } = employee;
    
    console.log('✅ Found employee:', employee);

    // Update employee's leave balance
    const updateResult = await queryInterface.sequelize.query(
      `UPDATE employees 
       SET leave_balance = :balance::jsonb, updated_at = NOW()
       WHERE id = :empId AND org_id = :orgId`,
      {
        replacements: {
          balance: JSON.stringify(leaveBalance),
          empId: adminId,
          orgId: orgId,
        },
      }
    );

    console.log('✅ Updated rows:', updateResult);

    // Verify the update worked
    const verifyEmployee = await queryInterface.sequelize.query(
      `SELECT id, name, email, leave_balance FROM employees WHERE id = :empId`,
      {
        replacements: { empId: adminId },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    console.log('✅ Verified employee after update:', verifyEmployee);

    // Check if leave requests already exist for this employee
    const existingLeaves = await queryInterface.sequelize.query(
      `SELECT COUNT(*) as count FROM leave_requests WHERE emp_id = :empId AND status = 'approved'`,
      {
        replacements: { empId: adminId },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    const leaveCount = existingLeaves[0]?.count || 0;
    if (leaveCount === 0) {
      // Generate UUID function (simple v4 equivalent)
      const crypto = require('crypto');
      const generateUUID = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      };

      // Create sample approved leave requests
      await queryInterface.bulkInsert('leave_requests', [
        {
          id: generateUUID(),
          org_id: orgId,
          emp_id: adminId,
          leave_type: 'casual',
          from_date: '2026-03-20',
          to_date: '2026-03-22',
          days_count: 3,
          is_half_day: false,
          reason: 'Personal errand',
          status: 'approved',
          approved_by: adminId,
          approved_at: new Date('2026-03-15'),
          created_at: new Date('2026-03-15'),
          updated_at: new Date('2026-03-15'),
        },
      {
        id: generateUUID(),
        org_id: orgId,
        emp_id: adminId,
        leave_type: 'sick',
        from_date: '2026-03-10',
        to_date: '2026-03-10',
        days_count: 1,
        is_half_day: false,
        reason: 'Medical checkup',
        status: 'approved',
        approved_by: adminId,
        approved_at: new Date('2026-03-08'),
        created_at: new Date('2026-03-08'),
        updated_at: new Date('2026-03-08'),
      },
      ]);

      console.log('✅ Test approved leaves created');
    } else {
      console.log(`ℹ️  Employee already has ${leaveCount} approved leave(s), skipping creation`);
    }

    console.log('✅ Test leaves assigned:');
    console.log('   - Leave Balance:', JSON.stringify(leaveBalance, null, 2));
    console.log('   - Approved Leaves: 3 casual + 1 sick');
    console.log(`   - Employee Email: ${testEmail}`);
    console.log(`   - Employee ID: ${adminId}`);
    console.log(`   - Organization: ${orgId}`);
  },

  async down(queryInterface) {
    const testEmail = 'raviyadav264209@gmail.com';

    // Find the employee by email
    const employees = await queryInterface.sequelize.query(
      `SELECT id, org_id FROM employees WHERE email = :email LIMIT 1`,
      {
        replacements: { email: testEmail },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    if (employees.length > 0) {
      const { id: adminId, org_id: orgId } = employees[0];

      // Reset leave balance
      await queryInterface.sequelize.query(
        `UPDATE employees 
         SET leave_balance = :balance, updated_at = NOW()
         WHERE id = :empId`,
        {
          replacements: {
            balance: JSON.stringify({}),
            empId: adminId,
          },
        }
      );

      // Delete test leave requests
      await queryInterface.bulkDelete('leave_requests', {
        emp_id: adminId,
      });

      console.log('✅ Seeder rolled back for:', testEmail);
    }
  },
};
