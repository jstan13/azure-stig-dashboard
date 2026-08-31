import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Records when the scheduler Function last checked in, so the UI can warn that
 * the schedule may not be enforced instead of showing a confident "next
 * shutdown" that nothing is acting on.
 */
export class PowerScheduleHeartbeat1700000012000 implements MigrationInterface {
  name = 'PowerScheduleHeartbeat1700000012000';

  public async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('power_schedule');
    if (!table || table.findColumnByName('lastPolledAt')) return;
    await runner.addColumn(
      'power_schedule',
      new TableColumn({ name: 'lastPolledAt', type: 'timestamptz', isNullable: true }),
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('power_schedule');
    if (table?.findColumnByName('lastPolledAt')) {
      await runner.dropColumn('power_schedule', 'lastPolledAt');
    }
  }
}
