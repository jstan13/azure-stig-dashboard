import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateVulnerabilities1700000003000 implements MigrationInterface {
  name = 'CreateVulnerabilities1700000003000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(new Table({
      name: 'vulnerabilities',
      columns: [
        { name: 'id',                type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'machineId',         type: 'varchar' },
        { name: 'cve',               type: 'varchar',     isNullable: true },
        { name: 'sourceId',          type: 'varchar',     isNullable: true },
        { name: 'productName',       type: 'varchar',     isNullable: true },
        { name: 'productVendor',     type: 'varchar',     isNullable: true },
        { name: 'productVersion',    type: 'varchar',     isNullable: true },
        { name: 'title',             type: 'varchar' },
        { name: 'description',       type: 'text',        isNullable: true },
        { name: 'severity',          type: 'varchar',     default: "'medium'" },
        { name: 'cvssScore',         type: 'float8',      isNullable: true },
        { name: 'status',            type: 'varchar',     default: "'open'" },
        { name: 'exploitAvailable',  type: 'boolean',     default: false },
        { name: 'remediation',       type: 'text',        isNullable: true },
        { name: 'firstDetectedAt',   type: 'timestamptz', isNullable: true },
        { name: 'lastDetectedAt',    type: 'timestamptz', isNullable: true },
        { name: 'raw',               type: 'jsonb',       isNullable: true },
        { name: 'createdAt',         type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',         type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndices('vulnerabilities', [
      new TableIndex({ name: 'IDX_vuln_machineId', columnNames: ['machineId'] }),
      new TableIndex({ name: 'IDX_vuln_severity',  columnNames: ['severity']  }),
      new TableIndex({ name: 'IDX_vuln_cve',       columnNames: ['cve']       }),
      new TableIndex({ name: 'IDX_vuln_status',    columnNames: ['status']    }),
    ]);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('vulnerabilities');
  }
}
