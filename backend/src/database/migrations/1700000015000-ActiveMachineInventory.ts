import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActiveMachineInventory1700000015000 implements MigrationInterface {
  name = 'ActiveMachineInventory1700000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "machines" DROP COLUMN IF EXISTS "isActive"');
  }
}