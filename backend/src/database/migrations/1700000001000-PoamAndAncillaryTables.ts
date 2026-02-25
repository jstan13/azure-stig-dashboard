import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

/**
 * Migration: POA&M, ComplianceHistory, NotificationConfig, RemediationJob tables
 */
export class PoamAndAncillaryTables1700000001000 implements MigrationInterface {
  name = 'PoamAndAncillaryTables1700000001000';

  public async up(runner: QueryRunner): Promise<void> {
    // ─── poams ───────────────────────────────────────────────────────────────
    await runner.createTable(new Table({
      name: 'poams',
      columns: [
        { name: 'id',                       type: 'uuid',      isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'poamId',                   type: 'varchar',   isUnique: true },
        { name: 'findingId',                type: 'uuid',      isNullable: true },
        { name: 'weakness',                 type: 'text' },
        { name: 'description',              type: 'text',      isNullable: true },
        { name: 'impact',                   type: 'text',      isNullable: true },
        { name: 'status',                   type: 'varchar',   default: "'open'" },
        { name: 'scheduledCompletion',      type: 'date',      isNullable: true },
        { name: 'actualCompletion',         type: 'date',      isNullable: true },
        { name: 'assignedToOid',            type: 'varchar',   isNullable: true },
        { name: 'assignedToName',           type: 'varchar',   isNullable: true },
        { name: 'issoOid',                  type: 'varchar',   isNullable: true },
        { name: 'delayReason',              type: 'text',      isNullable: true },
        { name: 'resourcesRequired',        type: 'text',      isNullable: true },
        { name: 'riskAcceptanceRationale',  type: 'text',      isNullable: true },
        { name: 'residualRisk',             type: 'varchar',   isNullable: true },
        { name: 'countermeasures',          type: 'text',      isNullable: true },
        { name: 'approvedByOid',            type: 'varchar',   isNullable: true },
        { name: 'approvedAt',               type: 'timestamptz', isNullable: true },
        { name: 'createdAt',                type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',                type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndex('poams', new TableIndex({ columnNames: ['status'] }));
    await runner.createIndex('poams', new TableIndex({ columnNames: ['scheduledCompletion'] }));

    // ─── poam_milestones ──────────────────────────────────────────────────────
    await runner.createTable(new Table({
      name: 'poam_milestones',
      columns: [
        { name: 'id',          type: 'uuid',     isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'poamId',      type: 'uuid' },
        { name: 'description', type: 'text' },
        { name: 'status',      type: 'varchar',  default: "'planned'" },
        { name: 'dueDate',     type: 'date',     isNullable: true },
        { name: 'completedAt', type: 'timestamptz', isNullable: true },
        { name: 'createdAt',   type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',   type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createForeignKey('poam_milestones', new TableForeignKey({
      columnNames:           ['poamId'],
      referencedTableName:   'poams',
      referencedColumnNames: ['id'],
      onDelete:              'CASCADE',
    }));

    // ─── compliance_history ────────────────────────────────────────────────────
    await runner.createTable(new Table({
      name: 'compliance_history',
      columns: [
        { name: 'id',            type: 'uuid',   isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'machineId',     type: 'varchar' },
        { name: 'snapshotDate',  type: 'date' },
        { name: 'score',         type: 'float',  default: 0 },
        { name: 'totalControls', type: 'int',    default: 0 },
        { name: 'openFindings',  type: 'int',    default: 0 },
        { name: 'catIOpen',      type: 'int',    default: 0 },
        { name: 'catIIOpen',     type: 'int',    default: 0 },
        { name: 'catIIIOpen',    type: 'int',    default: 0 },
        { name: 'resolved',      type: 'int',    default: 0 },
        { name: 'notApplicable', type: 'int',    default: 0 },
        { name: 'notReviewed',   type: 'int',    default: 0 },
        { name: 'scanId',        type: 'uuid',   isNullable: true },
        { name: 'createdAt',     type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndex('compliance_history', new TableIndex({
      name: 'IDX_compliance_history_machine_date',
      columnNames: ['machineId', 'snapshotDate'],
      isUnique: true,
    }));

    // ─── notification_configs ──────────────────────────────────────────────────
    await runner.createTable(new Table({
      name: 'notification_configs',
      columns: [
        { name: 'id',          type: 'uuid',      isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'ownerOid',    type: 'varchar',   isNullable: true },
        { name: 'trigger',     type: 'varchar' },
        { name: 'channel',     type: 'varchar' },
        { name: 'destination', type: 'varchar' },
        { name: 'filter',      type: 'jsonb',     isNullable: true },
        { name: 'enabled',     type: 'boolean',   default: true },
        { name: 'createdAt',   type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',   type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    // ─── remediation_jobs ──────────────────────────────────────────────────────
    await runner.createTable(new Table({
      name: 'remediation_jobs',
      columns: [
        { name: 'id',              type: 'uuid',     isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'name',            type: 'varchar' },
        { name: 'status',          type: 'varchar',  default: "'pending'" },
        { name: 'strategy',        type: 'varchar',  default: "'dsc_push'" },
        { name: 'machineIds',      type: 'jsonb',    default: "'[]'" },
        { name: 'findingIds',      type: 'jsonb',    default: "'[]'" },
        { name: 'benchmarkId',     type: 'varchar',  isNullable: true },
        { name: 'stigVersion',     type: 'varchar',  isNullable: true },
        { name: 'severity',        type: 'varchar',  isNullable: true },
        { name: 'triggeredByOid',  type: 'varchar',  isNullable: true },
        { name: 'triggeredByName', type: 'varchar',  isNullable: true },
        { name: 'totalItems',      type: 'int',      default: 0 },
        { name: 'succeeded',       type: 'int',      default: 0 },
        { name: 'failed',          type: 'int',      default: 0 },
        { name: 'skipped',         type: 'int',      default: 0 },
        { name: 'resultLog',       type: 'jsonb',    default: "'[]'" },
        { name: 'startedAt',       type: 'timestamptz', isNullable: true },
        { name: 'completedAt',     type: 'timestamptz', isNullable: true },
        { name: 'createdAt',       type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',       type: 'timestamptz', default: 'now()' },
      ],
    }), true);

    await runner.createIndex('remediation_jobs', new TableIndex({ columnNames: ['status'] }));
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('remediation_jobs',     true);
    await runner.dropTable('notification_configs', true);
    await runner.dropTable('compliance_history',   true);
    await runner.dropTable('poam_milestones',      true);
    await runner.dropTable('poams',                true);
  }
}
