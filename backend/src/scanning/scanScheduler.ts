/**
 * Automated Scan Scheduler
 *
 * Runs a full compliance scan on a fixed cron schedule so an IT operator can
 * decide how often the dashboard is refreshed (hourly, nightly, weekly, …)
 * instead of clicking "Trigger Full Scan" by hand.
 *
 * Disabled by default — set SCAN_SCHEDULE_ENABLED=true to opt in. This keeps a
 * fresh deploy from generating Azure API load until the operator chooses a
 * cadence and confirms RBAC + Guest Configuration are in place.
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

const ENABLED = process.env.SCAN_SCHEDULE_ENABLED === 'true';
const CRON = process.env.SCAN_CRON_SCHEDULE || '0 2 * * *';

/** Module-level guard so a slow run never overlaps the next scheduled tick. */
let running = false;

/**
 * Start the recurring scan scheduler. No-op (with an explanatory log) when
 * SCAN_SCHEDULE_ENABLED is not "true" or the cron expression is invalid.
 */
export function startScanScheduler(orchestrator: ScanOrchestrator = new ScanOrchestrator()): void {
  if (!ENABLED) {
    logger.info('[ScanScheduler] Disabled (set SCAN_SCHEDULE_ENABLED=true to enable automated scans).');
    return;
  }

  if (!cron.validate(CRON)) {
    logger.error(`[ScanScheduler] Invalid SCAN_CRON_SCHEDULE "${CRON}" — scheduler NOT started.`);
    return;
  }

  const subscriptionIds = (process.env.AZURE_SUBSCRIPTION_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  logger.info(`[ScanScheduler] Enabled. Schedule: "${CRON}". Scope: ${subscriptionIds.length ? subscriptionIds.join(', ') : 'all readable subscriptions'}.`);
  logger.info('[ScanScheduler] Note: each run is a batch pull (cost scales with fleet size). First-time coverage can take hours to days to fully populate as Guest Configuration reports in.');

  cron.schedule(CRON, () => {
    void runScheduledScan(orchestrator, subscriptionIds);
  });
}

/** Execute one scheduled scan, skipping if a previous run is still in flight. */
async function runScheduledScan(orchestrator: ScanOrchestrator, subscriptionIds: string[]): Promise<void> {
  if (running) {
    logger.warn('[ScanScheduler] Previous scan still running — skipping this tick.');
    return;
  }
  running = true;
  const start = Date.now();
  try {
    logger.info('[ScanScheduler] Starting scheduled scan');
    const result = await orchestrator.runScan(
      subscriptionIds.length ? { subscriptionIds } : {},
    );
    logger.info(`[ScanScheduler] Scheduled scan complete: scanId=${result.scanId}, machines=${result.machineCount}, findings=${result.findingCount}, open=${result.openCount}, durationMs=${Date.now() - start}`);
  } catch (err: any) {
    logger.error(`[ScanScheduler] Scheduled scan failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}
