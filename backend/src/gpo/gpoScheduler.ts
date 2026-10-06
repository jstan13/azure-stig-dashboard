/**
 * DISA GPO package discovery on the schedule configured in Settings.
 *
 * The policy lives in the database (manual vs scheduled, daily/weekly, time
 * zone), so administrators can switch modes without restarting the app. The
 * watcher ticks every minute; a Postgres advisory lock keeps multiple app
 * instances from checking DISA twice.
 */
import cron from 'node-cron';
import { DataSource } from 'typeorm';
import { logger } from '../utils/logger';
import { runDiscovery } from './gpoReleaseService';
import { getGpoSettings, isDiscoveryDue } from './gpoSettingsService';

const LOCK_ID = 739_842_331;
let running = false;

export async function runScheduledDiscoveryIfDue(ds: DataSource, now = new Date()): Promise<void> {
  if (running) return;
  const settings = await getGpoSettings();
  if (!isDiscoveryDue(settings, now)) return;

  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    const [{ acquired }] = await runner.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_ID]);
    if (!acquired) return;
    try {
      // Re-read under the lock: another instance may have just finished.
      if (!isDiscoveryDue(await getGpoSettings(), now)) return;
      running = true;
      const result = await runDiscovery(ds);
      logger.info(`[GPO] Scheduled DISA check finished: ${result.outcome}`);
    } finally {
      running = false;
      await runner.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    await runner.release();
  }
}

export function startGpoScheduler(ds: DataSource): void {
  logger.info('[GPO] Discovery watcher started; schedule is configured in Settings → GPO releases');
  cron.schedule('* * * * *', () => {
    runScheduledDiscoveryIfDue(ds).catch((err) => logger.error(`[GPO] Scheduled DISA check failed: ${err.message}`));
  });
}
