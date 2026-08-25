import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Creates the singleton `update_policy` table backing the auto-update
 * scheduler. The seed row is inserted here so the API never has to cope with
 * a missing policy.
 */
export class UpdatePolicy1700000009000 implements MigrationInterface {
  name = 'UpdatePolicy1700000009000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'update_policy',
        columns: [
          { name: 'id', type: 'varchar', isPrimary: true, default: "'singleton'" },
          { name: 'mode', type: 'varchar', default: "'notify'" },
          { name: 'requireApproval', type: 'boolean', default: true },
          { name: 'securityOnly', type: 'boolean', default: false },
          { name: 'dayOfWeek', type: 'int', isNullable: true },
          { name: 'hour', type: 'int', default: 2 },
          { name: 'timeZone', type: 'varchar', default: "'UTC'" },
          { name: 'currentVersion', type: 'varchar', isNullable: true },
          { name: 'availableVersion', type: 'varchar', isNullable: true },
          { name: 'availableNotes', type: 'text', isNullable: true },
          { name: 'approvedVersion', type: 'varchar', isNullable: true },
          { name: 'approvedBy', type: 'varchar', isNullable: true },
          { name: 'lastCheckedAt', type: 'timestamptz', isNullable: true },
          { name: 'history', type: 'jsonb', default: "'[]'::jsonb" },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await runner.query(
      `INSERT INTO update_policy (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`,
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('update_policy', true);
  }
}
