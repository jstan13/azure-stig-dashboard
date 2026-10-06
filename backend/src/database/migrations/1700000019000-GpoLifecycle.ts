import { MigrationInterface, QueryRunner } from 'typeorm';

export class GpoLifecycle1700000019000 implements MigrationInterface {
  name = 'GpoLifecycle1700000019000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "gpo_releases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "packageName" varchar NOT NULL,
        "label" varchar NOT NULL,
        "releaseDate" timestamptz,
        "downloadUrl" text NOT NULL,
        "filename" varchar NOT NULL,
        "sourceHash" varchar(64) NOT NULL,
        "sizeBytes" integer NOT NULL DEFAULT 0,
        "status" varchar NOT NULL DEFAULT 'awaiting_test_approval',
        "failedStage" varchar,
        "gpos" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "settingsSnapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "diff" jsonb,
        "exceptionsSnapshot" jsonb,
        "environments" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "decisions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "releasedAt" timestamptz,
        "lastError" text,
        "discoveredAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gpo_releases" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_gpo_releases_sourceHash" UNIQUE ("sourceHash")
      )
    `);
    await runner.query(`CREATE INDEX "idx_gpo_release_status" ON "gpo_releases" ("status")`);

    await runner.query(`
      CREATE TABLE "gpo_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "releaseId" uuid NOT NULL,
        "environment" varchar NOT NULL,
        "type" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT 'queued',
        "notBefore" timestamptz NOT NULL DEFAULT now(),
        "attempts" integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 3,
        "claimedByOid" varchar,
        "claimedBy" varchar,
        "claimedAt" timestamptz,
        "leaseExpiresAt" timestamptz,
        "completedAt" timestamptz,
        "deviations" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "result" jsonb,
        "error" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gpo_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_gpo_jobs_release"
          FOREIGN KEY ("releaseId") REFERENCES "gpo_releases"("id") ON DELETE CASCADE
      )
    `);
    await runner.query(
      `CREATE INDEX "idx_gpo_job_queue" ON "gpo_jobs" ("environment", "status", "notBefore")`,
    );

    await runner.query(`
      CREATE TABLE "gpo_agents" (
        "environment" varchar NOT NULL,
        "agentOid" varchar NOT NULL,
        "hostname" varchar,
        "version" varchar,
        "lastSeenAt" timestamptz NOT NULL,
        CONSTRAINT "PK_gpo_agents" PRIMARY KEY ("environment")
      )
    `);

    await runner.query(`
      CREATE TABLE "gpo_exceptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "gpoFamily" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "action" varchar NOT NULL DEFAULT 'set',
        "hive" varchar,
        "key" text,
        "valueName" text,
        "valueType" varchar,
        "value" text,
        "section" varchar,
        "settingKey" varchar,
        "settingValue" text,
        "justification" text NOT NULL,
        "reference" varchar,
        "status" varchar NOT NULL DEFAULT 'pending',
        "requestedByOid" varchar NOT NULL,
        "requestedBy" varchar NOT NULL,
        "approvedByOid" varchar,
        "approvedBy" varchar,
        "approvedAt" timestamptz,
        "revokedBy" varchar,
        "revokedAt" timestamptz,
        "expiresAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gpo_exceptions" PRIMARY KEY ("id")
      )
    `);
    await runner.query(`CREATE INDEX "idx_gpo_exception_family" ON "gpo_exceptions" ("gpoFamily")`);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "gpo_exceptions"`);
    await runner.query(`DROP TABLE "gpo_agents"`);
    await runner.query(`DROP TABLE "gpo_jobs"`);
    await runner.query(`DROP TABLE "gpo_releases"`);
  }
}
