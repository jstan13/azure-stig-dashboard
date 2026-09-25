import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supports POA&Ms entered by hand for weaknesses that no scan produced
 * (assessments, audits, penetration tests).
 *
 * - `findingId` becomes optional. The original migration already created it as
 *   nullable, but databases bootstrapped from entity metadata made it NOT NULL.
 * - `severity` is stored on the POA&M instead of being implied by the finding,
 *   and existing rows are backfilled from their finding.
 * - `controlAcronym` and `sourceIdentifyingControl` carry the eMASS fields a
 *   standalone POA&M cannot derive from a finding.
 */
export class ManualPoams1700000016000 implements MigrationInterface {
  name = 'ManualPoams1700000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "poams" ALTER COLUMN "findingId" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "poams" ADD COLUMN IF NOT EXISTS "severity" varchar');
    await queryRunner.query('ALTER TABLE "poams" ADD COLUMN IF NOT EXISTS "controlAcronym" varchar');
    await queryRunner.query('ALTER TABLE "poams" ADD COLUMN IF NOT EXISTS "sourceIdentifyingControl" text');
    await queryRunner.query(
      `UPDATE "poams" p SET "severity" = f."severity"
         FROM "findings" f
        WHERE p."findingId"::text = f."id"::text AND p."severity" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "poams" DROP COLUMN IF EXISTS "sourceIdentifyingControl"');
    await queryRunner.query('ALTER TABLE "poams" DROP COLUMN IF EXISTS "controlAcronym"');
    await queryRunner.query('ALTER TABLE "poams" DROP COLUMN IF EXISTS "severity"');
    // findingId is left nullable: standalone rows would violate NOT NULL.
  }
}
