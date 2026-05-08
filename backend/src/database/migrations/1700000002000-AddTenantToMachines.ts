import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Migration: add tenant identification columns to the `machines` table so the
 * Cloud Explorer hierarchy and tenant rollups can group resources by Microsoft
 * Entra tenant.
 *
 * Both columns are nullable on purpose — existing rows from earlier deployments
 * will be backfilled by the next ARM/ARG sync (or remain null until then).
 */
export class AddTenantToMachines1700000002000 implements MigrationInterface {
  name = 'AddTenantToMachines1700000002000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.addColumns('machines', [
      new TableColumn({ name: 'tenantId',   type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'tenantName', type: 'varchar', isNullable: true }),
    ]);
    await runner.createIndex('machines', new TableIndex({
      name: 'IDX_machines_tenantId',
      columnNames: ['tenantId'],
    }));
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropIndex('machines', 'IDX_machines_tenantId');
    await runner.dropColumns('machines', ['tenantId', 'tenantName']);
  }
}
