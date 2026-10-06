import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GPO lifecycle settings (manual vs scheduled discovery, carry-forward mode),
 * production survey results, and provenance for exceptions detected in
 * production GPOs.
 */
export class GpoSettingsAndSurvey1700000020000 implements MigrationInterface {
  name = 'GpoSettingsAndSurvey1700000020000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "gpo_settings" (
        "id" varchar NOT NULL DEFAULT 'singleton',
        "discoveryMode" varchar NOT NULL DEFAULT 'manual',
        "frequency" varchar NOT NULL DEFAULT 'weekly',
        "dayOfWeek" integer NOT NULL DEFAULT 1,
        "hour" integer NOT NULL DEFAULT 6,
        "minute" integer NOT NULL DEFAULT 30,
        "timeZone" varchar NOT NULL DEFAULT 'UTC',
        "carryForwardMode" varchar NOT NULL DEFAULT 'auto',
        "testSoakHours" integer NOT NULL DEFAULT 24,
        "requireDistinctApprovers" boolean NOT NULL DEFAULT false,
        "lastCheckedAt" timestamptz,
        "lastCheckOutcome" varchar,
        "lastCheckError" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gpo_settings" PRIMARY KEY ("id")
      )
    `);
    await runner.query(`ALTER TABLE "gpo_releases" ADD "productionSurvey" jsonb`);
    await runner.query(`ALTER TABLE "gpo_exceptions" ADD "source" varchar NOT NULL DEFAULT 'manual'`);
    await runner.query(`ALTER TABLE "gpo_exceptions" ADD "detectedFrom" varchar`);
    await runner.query(`ALTER TABLE "gpo_exceptions" ADD "baselineKnown" boolean NOT NULL DEFAULT true`);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "gpo_exceptions" DROP COLUMN "baselineKnown"`);
    await runner.query(`ALTER TABLE "gpo_exceptions" DROP COLUMN "detectedFrom"`);
    await runner.query(`ALTER TABLE "gpo_exceptions" DROP COLUMN "source"`);
    await runner.query(`ALTER TABLE "gpo_releases" DROP COLUMN "productionSurvey"`);
    await runner.query(`DROP TABLE "gpo_settings"`);
  }
}
