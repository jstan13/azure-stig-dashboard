import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class ScanPolicy1700000010000 implements MigrationInterface {
  name = 'ScanPolicy1700000010000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'scan_policy',
        columns: [
          { name: 'id', type: 'varchar', isPrimary: true, default: "'singleton'" },
          { name: 'enabled', type: 'boolean', default: false },
          { name: 'frequency', type: 'varchar', default: "'daily'" },
          { name: 'minute', type: 'int', default: 0 },
          { name: 'hour', type: 'int', default: 2 },
          { name: 'dayOfWeek', type: 'int', default: 0 },
          { name: 'timeZone', type: 'varchar', default: "'UTC'" },
          { name: 'lastScheduledRunAt', type: 'timestamptz', isNullable: true },
          { name: 'lastStatus', type: 'varchar', isNullable: true },
          { name: 'lastError', type: 'text', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );

    await runner.query(
      `INSERT INTO scan_policy (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`,
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('scan_policy', true);
  }
}