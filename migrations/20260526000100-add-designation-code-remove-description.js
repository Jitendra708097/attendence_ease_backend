'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('designations', 'code', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      WITH numbered AS (
        SELECT
          id,
          UPPER(
            REGEXP_REPLACE(
              REGEXP_REPLACE(COALESCE(NULLIF(TRIM(name), ''), 'DESIGNATION'), '[^A-Za-z0-9]+', '-', 'g'),
              '(^-|-$)',
              '',
              'g'
            )
          ) AS base_code,
          ROW_NUMBER() OVER (
            PARTITION BY org_id, UPPER(
              REGEXP_REPLACE(
                REGEXP_REPLACE(COALESCE(NULLIF(TRIM(name), ''), 'DESIGNATION'), '[^A-Za-z0-9]+', '-', 'g'),
                '(^-|-$)',
                '',
                'g'
              )
            )
            ORDER BY created_at, id
          ) AS row_number
        FROM designations
      )
      UPDATE designations d
      SET code =
        CASE
          WHEN numbered.row_number = 1 THEN LEFT(COALESCE(NULLIF(numbered.base_code, ''), 'DESIGNATION'), 40)
          ELSE LEFT(
            COALESCE(NULLIF(numbered.base_code, ''), 'DESIGNATION'),
            GREATEST(1, 40 - LENGTH(numbered.row_number::text) - 1)
          ) || '-' || numbered.row_number
        END
      FROM numbered
      WHERE d.id = numbered.id;
    `);

    await queryInterface.changeColumn('designations', 'code', {
      type: Sequelize.STRING,
      allowNull: false,
    });

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX designations_org_lower_code_active
      ON designations (org_id, lower(code))
      WHERE deleted_at IS NULL;
    `);

    await queryInterface.removeColumn('designations', 'description');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('designations', 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS designations_org_lower_code_active;');
    await queryInterface.removeColumn('designations', 'code');
  },
};
