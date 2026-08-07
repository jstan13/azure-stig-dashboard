import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds an immutable `createdByOid` column to the `poams` table so the
 * separation-of-duties check on risk-acceptance approval can rely on the
 * server-recorded creator identity instead of a client-supplied owner field.
 */
export class AddPoamCreatedBy1700000008000 implements MigrationInterface {
  name = 'AddPoamCreatedBy1700000008000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      'poams',
      new TableColumn({ name: 'createdByOid', type: 'varchar', isNullable: true }),
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropColumn('poams', 'createdByOid');
  }
}
