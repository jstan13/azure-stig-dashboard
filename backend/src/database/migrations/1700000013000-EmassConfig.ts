import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class EmassConfig1700000013000 implements MigrationInterface {
  name = 'EmassConfig1700000013000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: 'emass_config',
        columns: [
          { name: 'id', type: 'varchar', isPrimary: true, default: "'singleton'" },
          { name: 'baseUrl', type: 'text', isNullable: true },
          { name: 'userUid', type: 'text', isNullable: true },
          { name: 'apiKeyEncrypted', type: 'text', isNullable: true },
          { name: 'certPemEncrypted', type: 'text', isNullable: true },
          { name: 'keyPemEncrypted', type: 'text', isNullable: true },
          { name: 'caPemEncrypted', type: 'text', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
      true,
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('emass_config', true);
  }
}