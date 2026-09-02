import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class ApplyNowUpdate1700000014000 implements MigrationInterface {
  name = 'ApplyNowUpdate1700000014000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      'update_policy',
      new TableColumn({ name: 'applyNowVersion', type: 'varchar', isNullable: true }),
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropColumn('update_policy', 'applyNowVersion');
  }
}