import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: StigBenchmarks + StigVersions + PowerStigResults + updated Controls
 *
 * Creates the three new tables required for the full STIG content pipeline:
 *   - stig_benchmarks   — top-level benchmark catalogue (title, category, versions)
 *   - stig_versions     — individual STIG releases (V2R8, V2R9, …) with parse status
 *   - powerstig_results — raw DSC audit results from PowerSTIG execution
 *
 * Also alters the controls table to add XCCDF-derived columns:
 *   vuln_id, rule_id, group_id, check_type, check_parameters (JSONB),
 *   ccis (JSONB), azure_policy_ids (JSONB), defender_rule_ids (JSONB),
 *   stig_version_id (FK → stig_versions.id)
 *
 * The controls table PK is changed from a simple 'id' to a compound string
 * "<benchmarkId>|<vulnId>" — existing rows keep their existing IDs that aren't
 * pipe-delimited (they will be manually re-keyed after import).
 */
export class StigContentTables1700000000000 implements MigrationInterface {
  name = 'StigContentTables1700000000000';

  public async up(runner: QueryRunner): Promise<void> {
    // ── stig_benchmarks ───────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE IF NOT EXISTS "stig_benchmarks" (
        "benchmark_id"              VARCHAR(255)  NOT NULL,
        "title"                     TEXT          NOT NULL,
        "category"                  VARCHAR(100)  NOT NULL DEFAULT '',
        "platform"                  VARCHAR(100)  NOT NULL DEFAULT '',
        "latest_installed_version"  VARCHAR(20),
        "latest_available_version"  VARCHAR(20),
        "source_url"                TEXT,
        "last_content_update"       TIMESTAMP,
        "active"                    BOOLEAN       NOT NULL DEFAULT true,
        "created_at"                TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"                TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stig_benchmarks" PRIMARY KEY ("benchmark_id")
      )
    `);

    // ── stig_versions ─────────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE IF NOT EXISTS "stig_versions" (
        "id"                VARCHAR(255)  NOT NULL,
        "benchmark_id"      VARCHAR(255)  NOT NULL,
        "version"           VARCHAR(20)   NOT NULL,
        "release_info"      TEXT,
        "benchmark_date"    TIMESTAMP,
        "source_filename"   VARCHAR(512),
        "source_hash"       VARCHAR(64),
        "rule_count"        INTEGER       NOT NULL DEFAULT 0,
        "cat_i_count"       INTEGER       NOT NULL DEFAULT 0,
        "cat_ii_count"      INTEGER       NOT NULL DEFAULT 0,
        "cat_iii_count"     INTEGER       NOT NULL DEFAULT 0,
        "status"            VARCHAR(20)   NOT NULL DEFAULT 'pending'
                              CHECK ("status" IN ('pending','downloading','parsing','active','superseded','error')),
        "error_message"     TEXT,
        "created_at"        TIMESTAMP     NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stig_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_stig_versions_benchmark"
          FOREIGN KEY ("benchmark_id") REFERENCES "stig_benchmarks"("benchmark_id") ON DELETE CASCADE,
        CONSTRAINT "UQ_stig_versions_benchmark_version"
          UNIQUE ("benchmark_id", "version")
      )
    `);

    await runner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stig_versions_benchmark_id"
        ON "stig_versions" ("benchmark_id")
    `);
    await runner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stig_versions_status"
        ON "stig_versions" ("status")
    `);

    // ── powerstig_results ─────────────────────────────────────────────────────
    await runner.query(`
      CREATE TABLE IF NOT EXISTS "powerstig_results" (
        "id"                UUID          NOT NULL DEFAULT gen_random_uuid(),
        "machine_id"        VARCHAR(255)  NOT NULL,
        "stig_version_id"   VARCHAR(255)  NOT NULL,
        "rule_id"           VARCHAR(100)  NOT NULL,
        "dsc_resource"      VARCHAR(255),
        "check_type"        VARCHAR(100),
        "result"            VARCHAR(20)   NOT NULL
                              CHECK ("result" IN ('Pass','Fail','Error','NotApplicable','Skipped')),
        "reason"            TEXT,
        "raw_properties"    JSONB         NOT NULL DEFAULT '{}',
        "run_command_job_id" VARCHAR(255),
        "checked_at"        TIMESTAMP     NOT NULL DEFAULT now(),
        "created_at"        TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_powerstig_results" PRIMARY KEY ("id")
      )
    `);

    await runner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_psr_machine_stig_rule"
        ON "powerstig_results" ("machine_id", "stig_version_id", "rule_id")
    `);
    await runner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_psr_machine_id"
        ON "powerstig_results" ("machine_id")
    `);
    await runner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_psr_checked_at"
        ON "powerstig_results" ("checked_at")
    `);

    // ── controls — add new XCCDF columns (ALTER TABLE, idempotent via IF NOT EXISTS) ──
    const alterCols: Array<[string, string]> = [
      ['vuln_id',           'VARCHAR(50)'],
      ['rule_id',           'VARCHAR(100)'],
      ['group_id',          'VARCHAR(100)'],
      ['check_type',        'VARCHAR(100)'],
      ['check_parameters',  'JSONB'],
      ['ccis',              'JSONB'],
      ['azure_policy_ids',  'JSONB'],
      ['defender_rule_ids', 'JSONB'],
      ['stig_version_id',   'VARCHAR(255)'],
    ];

    for (const [col, type] of alterCols) {
      await runner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'controls' AND column_name = '${col}'
          ) THEN
            ALTER TABLE "controls" ADD COLUMN "${col}" ${type};
          END IF;
        END $$;
      `);
    }

    await runner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_controls_stig_version_vuln"
        ON "controls" ("stig_version_id", "vuln_id")
    `);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS "IDX_controls_stig_version_vuln"`);
    await runner.query(`DROP TABLE IF EXISTS "powerstig_results"`);
    await runner.query(`DROP TABLE IF EXISTS "stig_versions"`);
    await runner.query(`DROP TABLE IF EXISTS "stig_benchmarks"`);

    const dropCols = [
      'vuln_id','rule_id','group_id','check_type',
      'check_parameters','ccis','azure_policy_ids','defender_rule_ids','stig_version_id',
    ];
    for (const col of dropCols) {
      await runner.query(`
        ALTER TABLE "controls" DROP COLUMN IF EXISTS "${col}"
      `);
    }
  }
}
