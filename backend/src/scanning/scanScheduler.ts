/**
 * Automated Scan Scheduler
 *
 * Checks the database-backed scan policy once per minute. Administrators can
 * change the schedule from the UI without restarting the App Service.
 *
 * ── Resource overhead (know this before enabling) ──────────────────────────
 *   • Each run is a *batch pull* across Azure Resource Graph, Policy, Defender,
 *     ARM, and Guest Configuration. Cost scales with fleet size: roughly a few
 *     API calls per subscription + per VM. A few hundred VMs is minutes of
 *     wall-clock work and a brief CPU/network spike on the backend container.
 *   • Azure-side: read-only calls only, but they count against ARM/Resource
 *     Graph throttling limits. Very frequent schedules (e.g. every few minutes)
 *     on large fleets can hit 429s — prefer hourly or slower.
 *   • DB growth: every run writes a Scan row + a compliance-history snapshot and
 *     upserts findings. Storage grows slowly and linearly with run frequency.
 *   • Overlap is prevented: if a previous run is still going when the next tick
 *     fires, the new tick is skipped (logged) rather than stacking concurrent
 *     scans.
 *
 * ── First-run lag (set expectations) ───────────────────────────────────────
 *   The scheduler only pulls what Azure has already evaluated. On a brand-new
 *   deployment the dashboard fills in *gradually*:
 *     • Inventory (machines/OS/RGs) appears on the first run.
 *     • Azure Policy / Defender posture (~5-15% of a STIG) appears once Azure
 *       finishes evaluating assignments (~30 min, up to ~24 h).
 *     • The bulk of a STIG (~80-90%) comes from Guest Configuration, which must
 *       first be deployed to the VMs and report back — this can take hours to
 *       **days** to fully populate across a fleet. Running the scan more often
 *       does not speed up Azure's own evaluation; it just refreshes what's ready.
 *
 * Environment variables:
 *   SCAN_SCHEDULE_ENABLED   "true" to enable automated scans (default: false)
 *   SCAN_CRON_SCHEDULE      node-cron expression (default: "0 2 * * *" — 2AM daily)
 *   AZURE_SUBSCRIPTION_IDS  comma-separated subscription scope (default: all the
 *                           managed identity can read)
 */

import cron from 'node-cron';
import { ScanOrchestrator } from '../connectors/scanOrchestrator';
import { logger } from '../utils/logger';
import {
  getScanPolicy, isScanDue, saveScanPolicy,
} from '../services/scanPolicyService';
import { AppDataSource } from '../database/dataSource';

/** Module-level guard so a slow run never overlaps the next scheduled tick. */
let running = false;
const SCHEDULER_LOCK_ID = 739_842_117;

/**
 * Start the recurring policy check. The policy itself is disabled by default.
 */
export function startScanScheduler(orchestrator: ScanOrchestrator = new ScanOrchestrator()): void {
  const subscriptionIds = (process.env.AZURE_SUBSCRIPTION_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  logger.info(`[ScanScheduler] Policy watcher started. Scope: ${subscriptionIds.length ? subscriptionIds.join(', ') : 'all readable subscriptions'}.`);

  cron.schedule('* * * * *', () => {
    void runScheduledScanIfDue(orchestrator, subscriptionIds).catch((err) => {
      logger.error(`[ScanScheduler] Policy check failed: ${err?.stack ?? err}`);
    });
  });
}

export async function runScheduledScanIfDue(
  orchestrator: ScanOrchestrator,
  subscriptionIds: string[],
  now = new Date(),
): Promise<void> {
  if (running) {
    logger.warn('[ScanScheduler] Previous scan still running — skipping this tick.');
    return;
  }

  const lockRunner = AppDataSource.isInitialized ? AppDataSource.createQueryRunner() : null;
  if (lockRunner) {
    await lockRunner.connect();
    const rows = await lockRunner.query('SELECT pg_try_advisory_lock($1) AS acquired', [SCHEDULER_LOCK_ID]);
    if (!rows[0]?.acquired) {
      await lockRunner.release();
      logger.warn('[ScanScheduler] Another worker owns the scheduler lock — skipping this tick.');
      return;
    }
  }

  try {
    const policy = await getScanPolicy();
    if (!isScanDue(policy, now)) return;

    running = true;
    const start = Date.now();
    policy.lastScheduledRunAt = now;
    policy.lastStatus = 'running';
    policy.lastError = null;
    await saveScanPolicy(policy);
    try {
      logger.info('[ScanScheduler] Starting scheduled scan');
      const result = await orchestrator.runScan(
        subscriptionIds.length ? { subscriptionIds } : {},
      );
      policy.lastStatus = 'completed';
      logger.info(`[ScanScheduler] Scheduled scan complete: scanId=${result.scanId}, machines=${result.machineCount}, findings=${result.findingCount}, open=${result.openCount}, durationMs=${Date.now() - start}`);
    } catch (err: any) {
      policy.lastStatus = 'failed';
      policy.lastError = String(err?.message ?? err).slice(0, 2000);
      logger.error(`[ScanScheduler] Scheduled scan failed: ${err?.stack ?? err?.message ?? err}`);
    } finally {
      await saveScanPolicy(policy);
      running = false;
    }
  } finally {
    if (lockRunner) {
      try {
        await lockRunner.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_ID]);
      } finally {
        await lockRunner.release();
      }
    }
  }
}
