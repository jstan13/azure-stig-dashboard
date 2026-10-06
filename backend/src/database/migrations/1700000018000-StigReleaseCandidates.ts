import { MigrationInterface, QueryRunner } from 'typeorm';

export class StigReleaseCandidates1700000018000 implements MigrationInterface {
  name = 'StigReleaseCandidates1700000018000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "stig_release_candidates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "benchmarkId" uuid NOT NULL,
        "title" varchar NOT NULL,
        "version" varchar NOT NULL,
        "releaseDate" timestamptz,
        "downloadUrl" text NOT NULL,
        "filename" varchar NOT NULL,
        "sourceHash" varchar(64) NOT NULL,
        "status" varchar NOT NULL DEFAULT 'ready',
        "addedRules" integer NOT NULL DEFAULT 0,
        "removedRules" integer NOT NULL DEFAULT 0,
        "changedRules" integer NOT NULL DEFAULT 0,
        "severityChanges" integer NOT NULL DEFAULT 0,
        "diff" jsonb NOT NULL DEFAULT '{"added":[],"removed":[],"changed":[],"severityChanged":[]}'::jsonb,
        "approvedBy" varchar,
        "approvedAt" timestamptz,
        "appliedAt" timestamptz,
        "errorMessage" text,
        "discoveredAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stig_release_candidates" PRIMARY KEY ("id"),
        CONSTRAINT "uq_stig_release_benchmark_version" UNIQUE ("benchmarkId", "version"),
        CONSTRAINT "FK_stig_release_benchmark"
          FOREIGN KEY ("benchmarkId") REFERENCES "stig_benchmarks"("id") ON DELETE CASCADE
      )
    `);
    await runner.query(
      `CREATE INDEX "idx_stig_release_status" ON "stig_release_candidates" ("status")`,
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "stig_release_candidates"`);
  }
}
