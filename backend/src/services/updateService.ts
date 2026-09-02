/**
 * Auto-update policy: persistence, scheduling window, and the decision the
 * scheduler acts on.
 *
 * The scheduler is deliberately dumb — it asks this service "may I install
 * version X right now?" and does what it is told. Keeping the rules here means
 * the UI, the API, and the Function App can never disagree about them.
 */

import { AppDataSource } from '../database/dataSource';
import {
  UpdatePolicyEntity, type UpdateMode, type UpdateHistoryEntry,
} from '../models/UpdatePolicy';

const isMock = () => process.env.MOCK_MODE === 'true';

const MAX_HISTORY = 20;

/** Demo mode has no database, so the policy lives for the life of the process. */
let mockPolicy: UpdatePolicyEntity | null = null;

function seedPolicy(): UpdatePolicyEntity {
  const p = new UpdatePolicyEntity();
  p.id = 'singleton';
  p.mode = (process.env.AUTO_UPDATE_MODE as UpdateMode) || 'notify';
  p.requireApproval = process.env.AUTO_UPDATE_REQUIRE_APPROVAL !== 'false';
  p.securityOnly = false;
  p.dayOfWeek = process.env.AUTO_UPDATE_DAY ? Number(process.env.AUTO_UPDATE_DAY) : null;
  p.hour = Number(process.env.AUTO_UPDATE_HOUR ?? 2);
  p.timeZone = process.env.AUTO_UPDATE_TIME_ZONE || 'UTC';
  p.currentVersion = process.env.RELEASE_TAG || null;
  p.availableVersion = null;
  p.availableNotes = null;
  p.approvedVersion = null;
  p.approvedBy = null;
  p.applyNowVersion = null;
  p.lastCheckedAt = null;
  p.history = [];
  return p;
}

export async function getPolicy(): Promise<UpdatePolicyEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    if (!mockPolicy) mockPolicy = seedPolicy();
    return mockPolicy;
  }
  const repo = AppDataSource.getRepository(UpdatePolicyEntity);
  let policy = await repo.findOne({ where: { id: 'singleton' } });
  if (!policy) {
    policy = await repo.save(seedPolicy());
  }
  // The running image is the source of truth for what is deployed; a manual
  // container swap outside the scheduler would otherwise go unnoticed.
  if (process.env.RELEASE_TAG && policy.currentVersion !== process.env.RELEASE_TAG) {
    policy.currentVersion = process.env.RELEASE_TAG;
    policy = await repo.save(policy);
  }
  return policy;
}

export async function savePolicy(policy: UpdatePolicyEntity): Promise<UpdatePolicyEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    mockPolicy = policy;
    return policy;
  }
  return AppDataSource.getRepository(UpdatePolicyEntity).save(policy);
}

export async function recordHistory(entry: UpdateHistoryEntry): Promise<void> {
  const policy = await getPolicy();
  policy.history = [entry, ...(policy.history ?? [])].slice(0, MAX_HISTORY);
  await savePolicy(policy);
}

/** Hour of day (0-23) and weekday (0=Sun) as observed in `timeZone`. */
export function localParts(timeZone: string, date = new Date()): { hour: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = Math.max(0, days.indexOf(weekdayName));
  return { hour, day };
}

/** True when `date` falls inside the policy's one-hour maintenance window. */
export function isWithinWindow(policy: UpdatePolicyEntity, date = new Date()): boolean {
  let parts: { hour: number; day: number };
  try {
    parts = localParts(policy.timeZone || 'UTC', date);
  } catch {
    // An unknown IANA zone must not wedge the scheduler permanently open.
    parts = localParts('UTC', date);
  }
  if (policy.dayOfWeek !== null && policy.dayOfWeek !== undefined
      && parts.day !== policy.dayOfWeek) {
    return false;
  }
  return parts.hour === policy.hour;
}

export type UpdateDecision =
  | { action: 'none'; reason: string }
  | { action: 'notify'; version: string; reason: string }
  | { action: 'install'; version: string; reason: string };

/**
 * What the scheduler should do right now. `force` bypasses the window and the
 * approval gate — it backs the admin's explicit "Update now" button, which is
 * itself permission-checked and audited.
 */
export function decide(
  policy: UpdatePolicyEntity,
  date = new Date(),
  force = false,
): UpdateDecision {
  const available = policy.availableVersion;
  if (!available) return { action: 'none', reason: 'no release information yet' };
  if (available === policy.currentVersion) {
    return { action: 'none', reason: 'already on the latest release' };
  }
  if (force) return { action: 'install', version: available, reason: 'requested by an administrator' };
  if (policy.applyNowVersion === available) {
    return { action: 'install', version: available, reason: 'queued for immediate installation' };
  }

  if (policy.mode === 'off') return { action: 'none', reason: 'auto-update is off' };
  if (policy.mode === 'notify') {
    return { action: 'notify', version: available, reason: 'notify-only mode' };
  }
  if (policy.requireApproval && policy.approvedVersion !== available) {
    return { action: 'notify', version: available, reason: 'waiting for administrator approval' };
  }
  if (!isWithinWindow(policy, date)) {
    return { action: 'notify', version: available, reason: 'outside the maintenance window' };
  }
  return { action: 'install', version: available, reason: 'inside the maintenance window' };
}
