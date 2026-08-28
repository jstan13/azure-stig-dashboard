import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class PowerSchedule1700000011000 implements MigrationInterface {
  name = 'PowerSchedule1700000011000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'power_schedule',
        columns: [
          { name: 'id', type: 'varchar', isPrimary: true, default: "'singleton'" },
          { name: 'enabled', type: 'boolean', default: false },
          { name: 'autoShutdown', type: 'boolean', default: false },
          { name: 'timeZone', type: 'varchar', default: "'UTC'" },
          { name: 'startHour', type: 'int', default: 8 },
          { name: 'startMinute', type: 'int', default: 0 },
          { name: 'endHour', type: 'int', default: 18 },
          { name: 'endMinute', type: 'int', default: 0 },
          { name: 'days', type: 'jsonb', default: "'[1,2,3,4,5]'" },
          { name: 'deferUntil', type: 'timestamptz', isNullable: true },
          { name: 'deferredBy', type: 'varchar', isNullable: true },
          { name: 'lastAction', type: 'varchar', isNullable: true },
          { name: 'lastActionAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );
    // The singleton row is intentionally not inserted here: the service seeds
    // it from the install-time BUSINESS_HOURS_* settings on first read, which
    // would otherwise be overwritten by these column defaults.
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('power_schedule', true);
  }
}
