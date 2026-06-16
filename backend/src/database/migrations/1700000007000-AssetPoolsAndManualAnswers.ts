import {
  MigrationInterface, QueryRunner, Table, TableIndex, TableColumn,
} from 'typeorm';

/**
 * Asset pools + shared manual answers.
 *
 *   asset_pools          — named role groups (Domain Controllers, Web Servers…)
 *   asset_pool_members   — explicit machine membership
 *   manual_answers       — pool/platform-scoped manual STIG answers (answer once)
 *   findings.manualAnswerScope / manualAnswerScopeId — provenance of a manual
 *     answer on a finding (machine | pool | platform).
 */
export class AssetPoolsAndManualAnswers1700000007000 implements MigrationInterface {
  name = 'AssetPoolsAndManualAnswers1700000007000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(new Table({
      name: 'asset_pools',
      columns: [
        { name: 'id',            type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'name',          type: 'varchar' },
        { name: 'description',   type: 'text',        isNullable: true },
        { name: 'role',          type: 'varchar',     isNullable: true },
        { name: 'tenantId',      type: 'varchar',     isNullable: true },
        { name: 'selectionMode', type: 'varchar',     default: "'explicit'" },
        { name: 'tagRule',       type: 'jsonb',       isNullable: true },
        { name: 'status',        type: 'varchar',     default: "'active'" },
        { name: 'createdBy',     type: 'varchar',     isNullable: true },
        { name: 'createdAt',     type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',     type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndices('asset_pools', [
      new TableIndex({ name: 'idx_asset_pool_tenant', columnNames: ['tenantId'] }),
    ]);

    await runner.createTable(new Table({
      name: 'asset_pool_members',
      columns: [
        { name: 'id',        type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'poolId',    type: 'uuid' },
        { name: 'machineId', type: 'varchar' },
        { name: 'addedBy',   type: 'varchar',     isNullable: true },
        { name: 'addedAt',   type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndices('asset_pool_members', [
      new TableIndex({ name: 'uq_asset_pool_member',          columnNames: ['poolId', 'machineId'], isUnique: true }),
      new TableIndex({ name: 'idx_asset_pool_member_machine', columnNames: ['machineId'] }),
    ]);

    await runner.createTable(new Table({
      name: 'manual_answers',
      columns: [
        { name: 'id',             type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'scopeType',      type: 'varchar' },
        { name: 'scopeId',        type: 'varchar' },
        { name: 'controlId',      type: 'varchar' },
        { name: 'vulnId',         type: 'varchar',     isNullable: true },
        { name: 'status',         type: 'varchar',     default: "'not_reviewed'" },
        { name: 'comments',       type: 'text',        isNullable: true },
        { name: 'findingDetails', type: 'text',        isNullable: true },
        { name: 'answeredBy',     type: 'varchar',     isNullable: true },
        { name: 'createdAt',      type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',      type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndices('manual_answers', [
      new TableIndex({ name: 'uq_manual_answer_scope_control', columnNames: ['scopeType', 'scopeId', 'controlId'], isUnique: true }),
      new TableIndex({ name: 'idx_manual_answer_control',      columnNames: ['controlId'] }),
      new TableIndex({ name: 'idx_manual_answer_scope',        columnNames: ['scopeType', 'scopeId'] }),
    ]);

    await runner.addColumns('findings', [
      new TableColumn({ name: 'manualAnswerScope',   type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'manualAnswerScopeId', type: 'varchar', isNullable: true }),
    ]);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropColumn('findings', 'manualAnswerScopeId');
    await runner.dropColumn('findings', 'manualAnswerScope');
    await runner.dropTable('manual_answers');
    await runner.dropTable('asset_pool_members');
    await runner.dropTable('asset_pools');
  }
}
