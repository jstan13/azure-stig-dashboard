/**
 * STIG Update Scheduler
 *
 * Runs on two schedules:
 *   1. Weekly catalog check  — queries DISA to detect new benchmark versions.
 *      Stores the "latestAvailableVersion" on StigBenchmarkEntity so the UI
 *      can show "Update available: V2R9" without any user action.
 *
 *   2. Quarterly import job  — downloads and imports new versions when found.
 *      Runs on the first Monday of each quarter (Jan/Apr/Jul/Oct) by default,
 *      matching DISA's typical quarterly release cycle.  Can also be triggered
 *      via POST /api/stigs/update.
 *
 * Environment variables:
 *   STIG_CHECK_CRON      Weekly check schedule  (default: "0 6 * * 1" — 6AM Mon)
 *   STIG_IMPORT_CRON     Quarterly import        (default: "0 3 1 1,4,7,10 *")
 *   STIG_AUTO_IMPORT     Set "true" to auto-import; default "false" (check only)
 */

import cron from 'node-cron';
import { DataSource } from 'typeorm';
import { logger } from '../utils/logger';
import {
  applyReadyReleases, stageAvailableReleases, StagedReleaseResult,
} from './stigReleaseService';

const CHECK_CRON = process.env.STIG_CHECK_CRON || '0 6 * * 1';
const IMPORT_CRON = process.env.STIG_IMPORT_CRON || '0 3 1 1,4,7,10 *';
const AUTO_IMPORT = process.env.STIG_AUTO_IMPORT === 'true';

export function startStigUpdateScheduler(dataSource: DataSource): void {
  logger.info('[STIGScheduler] Starting STIG update scheduler');
  logger.info(`[STIGScheduler] Catalog check: ${CHECK_CRON}, Auto-import: ${AUTO_IMPORT}`);

  // Weekly catalog version check
  cron.schedule(CHECK_CRON, () => {
    checkForUpdates(dataSource).catch((err) =>
      logger.error('[STIGScheduler] Catalog check failed:', err.message),
    );
  });

  // Quarterly import
  if (AUTO_IMPORT) {
    cron.schedule(IMPORT_CRON, () => {
      runQuarterlyImport(dataSource).catch((err) =>
        logger.error('[STIGScheduler] Quarterly import failed:', err.message),
      );
    });
  }
}

/**
 * Check the DISA catalog and mark benchmarks where a newer version is available.
 * Does NOT download or import — just updates latestAvailableVersion.
 */
export async function checkForUpdates(dataSource: DataSource): Promise<UpdateCheckResult[]> {
  logger.info('[STIGScheduler] Checking DISA catalog for STIG updates');
  const results: StagedReleaseResult[] = await stageAvailableReleases(dataSource);

  logger.info(`[STIGScheduler] Update check complete. ${results.filter((r) => r.updateAvailable).length} update(s) available.`);
  return results;
}

/**
 * Download and import all benchmarks that have newer versions available.
 */
export async function runQuarterlyImport(dataSource: DataSource): Promise<void> {
  logger.info('[STIGScheduler] Running quarterly STIG import');
  await stageAvailableReleases(dataSource);
  const results = await applyReadyReleases(dataSource);
  logger.info(`[STIGScheduler] Quarterly import complete. ${results.length} benchmark(s) updated.`);
}

export interface UpdateCheckResult {
  benchmarkId: string;
  title: string;
  installedVersion: string;
  availableVersion: string;
  updateAvailable: boolean;
}
