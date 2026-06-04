import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seed global RoleBindings from the legacy `users.roles` column.
 *
 * Before scoped RBAC, a user's roles lived only in `users.roles` (a
 * comma-separated simple-array) and were enforced as flat/global. This migration
 * preserves existing access by creating an equivalent GLOBAL RoleBinding
 * (collectionId = NULL) for every recognised role each user holds.
 *
 * Unknown/legacy role strings are ignored. Idempotent: it skips users that
 * already have an active global binding for the role.
 */
export class SeedRoleBindings1700000006000 implements MigrationInterface {
  name = 'SeedRoleBindings1700000006000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      INSERT INTO role_bindings ("subjectOid", "collectionId", "role", "grantedBy")
      SELECT u."oid", NULL, r.role::role_bindings_role_enum, 'system:migration'
      FROM users u
      CROSS JOIN LATERAL unnest(string_to_array(u."roles", ',')) AS r(role)
      WHERE r.role IN ('auditor', 'operator', 'isso', 'issm', 'admin')
        AND NOT EXISTS (
          SELECT 1 FROM role_bindings rb
          WHERE rb."subjectOid" = u."oid"
            AND rb."collectionId" IS NULL
            AND rb."role" = r.role::role_bindings_role_enum
            AND rb."revokedAt" IS NULL
        );
    `);
  }

  public async down(runner: QueryRunner): Promise<void> {
    // Only remove bindings created by this migration.
    await runner.query(`DELETE FROM role_bindings WHERE "grantedBy" = 'system:migration'`);
  }
}
