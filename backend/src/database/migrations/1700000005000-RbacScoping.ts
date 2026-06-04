import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * RBAC scoping tables — Collections (authorization boundaries / ATOs) and the
 * role/group grants scoped to them.
 *
 * Roles enum mirrors auth/permissions.ts ROLES: auditor < operator < isso <
 * issm < admin.
 */
export class RbacScoping1700000005000 implements MigrationInterface {
  name = 'RbacScoping1700000005000';

  public async up(runner: QueryRunner): Promise<void> {
    const roleEnumValues = ['auditor', 'operator', 'isso', 'issm', 'admin'];

    await runner.createTable(new Table({
      name: 'collections',
      columns: [
        { name: 'id',            type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'name',          type: 'varchar' },
        { name: 'description',   type: 'text',        isNullable: true },
        { name: 'tenantId',      type: 'varchar',     isNullable: true },
        { name: 'selectionMode', type: 'varchar',     default: "'explicit'" },
        { name: 'tagRule',       type: 'jsonb',       isNullable: true },
        { name: 'status',        type: 'varchar',     default: "'active'" },
        { name: 'createdBy',     type: 'varchar',     isNullable: true },
        { name: 'createdAt',     type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt',     type: 'timestamptz', default: 'now()' },
      ],
    }), true);
    await runner.createIndices('collections', [
      new TableIndex({ name: 'idx_collection_tenant', columnNames: ['tenantId'] }),
    ]);

    await runner.createTable(new Table({
      name: 'collection_assets',
      columns: [
        { name: 'id',           type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'collectionId', type: 'uuid' },
        { name: 'machineId',    type: 'varchar' },
        { name: 'addedBy',      type: 'varchar',     isNullable: true },
        { name: 'addedAt',      type: 'timestamptz', default: 'now()' },
      ],
    }), true);
    await runner.createIndices('collection_assets', [
      new TableIndex({ name: 'uq_collection_asset', columnNames: ['collectionId', 'machineId'], isUnique: true }),
      new TableIndex({ name: 'idx_collection_asset_machine', columnNames: ['machineId'] }),
    ]);

    await runner.createTable(new Table({
      name: 'role_bindings',
      columns: [
        { name: 'id',           type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'subjectOid',   type: 'varchar' },
        { name: 'collectionId', type: 'uuid',        isNullable: true },
        { name: 'role',         type: 'enum',        enum: roleEnumValues, enumName: 'role_bindings_role_enum' },
        { name: 'grantedBy',    type: 'varchar',     isNullable: true },
        { name: 'grantedAt',    type: 'timestamptz', default: 'now()' },
        { name: 'revokedAt',    type: 'timestamptz', isNullable: true },
      ],
    }), true);
    await runner.createIndices('role_bindings', [
      new TableIndex({ name: 'idx_role_binding_subject', columnNames: ['subjectOid'] }),
      new TableIndex({ name: 'idx_role_binding_collection', columnNames: ['collectionId'] }),
    ]);

    await runner.createTable(new Table({
      name: 'group_role_mappings',
      columns: [
        { name: 'id',               type: 'uuid',        isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'groupObjectId',    type: 'varchar' },
        { name: 'groupDisplayName', type: 'varchar',     isNullable: true },
        { name: 'role',             type: 'enum',        enum: roleEnumValues, enumName: 'group_role_mappings_role_enum' },
        { name: 'collectionId',     type: 'uuid',        isNullable: true },
        { name: 'createdBy',        type: 'varchar',     isNullable: true },
        { name: 'createdAt',        type: 'timestamptz', default: 'now()' },
      ],
    }), true);
    await runner.createIndices('group_role_mappings', [
      new TableIndex({ name: 'uq_group_role_mapping', columnNames: ['groupObjectId', 'collectionId', 'role'], isUnique: true }),
      new TableIndex({ name: 'idx_group_role_mapping_group', columnNames: ['groupObjectId'] }),
    ]);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropTable('group_role_mappings');
    await runner.dropTable('role_bindings');
    await runner.dropTable('collection_assets');
    await runner.dropTable('collections');
    // Drop the pg enum types created for the enum columns.
    await runner.query('DROP TYPE IF EXISTS "group_role_mappings_role_enum"');
    await runner.query('DROP TYPE IF EXISTS "role_bindings_role_enum"');
  }
}
