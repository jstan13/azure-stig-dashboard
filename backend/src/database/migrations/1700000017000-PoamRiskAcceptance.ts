import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the display name of the person who accepted a POA&M's risk, so the
 * CSV, CKL/CKLB comments and eMASS push can name the approver without a
 * directory lookup. `approvedByOid` remains the authoritative identity.
 */
export class PoamRiskAcceptance1700000017000 implements MigrationInterface {
  name = 'PoamRiskAcceptance1700000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "poams" ADD COLUMN IF NOT EXISTS "approvedByName" varchar');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "poams" DROP COLUMN IF EXISTS "approvedByName"');
  }
}
