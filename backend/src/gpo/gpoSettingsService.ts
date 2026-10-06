import { AppDataSource } from '../database/dataSource';
import { GpoSettingsEntity } from '../models/GpoSettings';
import { localParts } from '../services/scanPolicyService';

const isMock = () => process.env.MOCK_MODE === 'true';
let mockSettings: GpoSettingsEntity | null = null;

/** First-run defaults come from the legacy environment variables. */
function seedSettings(): GpoSettingsEntity {
  const s = new GpoSettingsEntity();
  s.id = 'singleton';
  s.discoveryMode = process.env.GPO_LIFECYCLE_ENABLED === 'true' ? 'scheduled' : 'manual';
  s.frequency = 'weekly';
  s.dayOfWeek = 1;
  s.hour = 6;
  s.minute = 30;
  s.timeZone = 'UTC';
  const cron = process.env.GPO_CHECK_CRON?.trim().split(/\s+/);
  if (cron?.length === 5) {
    const [minute, hour, , , dayOfWeek] = cron;
    if (/^\d+$/.test(minute)) s.minute = Number(minute);
    if (/^\d+$/.test(hour)) s.hour = Number(hour);
    if (dayOfWeek === '*') s.frequency = 'daily';
    else if (/^\d$/.test(dayOfWeek)) s.dayOfWeek = Number(dayOfWeek);
  }
  s.carryForwardMode = 'auto';
  s.testSoakHours = Math.max(0, Number(process.env.GPO_TEST_SOAK_HOURS ?? 24));
  s.requireDistinctApprovers = process.env.GPO_REQUIRE_DISTINCT_APPROVERS === 'true';
  s.lastCheckedAt = null;
  s.lastCheckOutcome = null;
  s.lastCheckError = null;
  return s;
}

export async function getGpoSettings(): Promise<GpoSettingsEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    if (!mockSettings) mockSettings = seedSettings();
    return mockSettings;
  }
  const repo = AppDataSource.getRepository(GpoSettingsEntity);
  return (await repo.findOne({ where: { id: 'singleton' } })) ?? repo.save(seedSettings());
}

export async function saveGpoSettings(settings: GpoSettingsEntity): Promise<GpoSettingsEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    mockSettings = settings;
    return settings;
  }
  return AppDataSource.getRepository(GpoSettingsEntity).save(settings);
}

/** Test hook: forget the in-memory settings used without a database. */
export function resetMockGpoSettings(): void {
  mockSettings = null;
}

/**
 * Records the outcome of a DISA check without rewriting the other columns, so
 * a long discovery cannot revert settings an administrator saved meanwhile.
 */
export async function recordDiscoveryCheck(outcome: string, error: string | null): Promise<void> {
  const values = { lastCheckedAt: new Date(), lastCheckOutcome: outcome, lastCheckError: error };
  if (isMock() || !AppDataSource.isInitialized) {
    Object.assign(await getGpoSettings(), values);
    return;
  }
  await getGpoSettings();
  await AppDataSource.getRepository(GpoSettingsEntity).update({ id: 'singleton' }, values);
}

export function matchesDiscoverySchedule(s: GpoSettingsEntity, date = new Date()): boolean {
  if (s.discoveryMode !== 'scheduled') return false;
  const p = localParts(s.timeZone, date);
  if (p.minute !== s.minute || p.hour !== s.hour) return false;
  return s.frequency === 'daily' || p.dayOfWeek === s.dayOfWeek;
}

/** Due once per scheduled occurrence, even if several app instances tick. */
export function isDiscoveryDue(s: GpoSettingsEntity, date = new Date()): boolean {
  if (!matchesDiscoverySchedule(s, date)) return false;
  return !s.lastCheckedAt || date.getTime() - s.lastCheckedAt.getTime() > 60 * 60 * 1000;
}

export function nextDiscoveryAt(s: GpoSettingsEntity, from = new Date()): string | null {
  if (s.discoveryMode !== 'scheduled') return null;
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i += 1) {
    if (matchesDiscoverySchedule(s, candidate)) return candidate.toISOString();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

export function gpoSettingsResponse(s: GpoSettingsEntity) {
  return {
    discoveryMode: s.discoveryMode,
    frequency: s.frequency,
    dayOfWeek: s.dayOfWeek,
    hour: s.hour,
    minute: s.minute,
    timeZone: s.timeZone,
    carryForwardMode: s.carryForwardMode,
    testSoakHours: s.testSoakHours,
    requireDistinctApprovers: s.requireDistinctApprovers,
    lastCheckedAt: s.lastCheckedAt,
    lastCheckOutcome: s.lastCheckOutcome,
    lastCheckError: s.lastCheckError,
    nextCheckAt: nextDiscoveryAt(s),
  };
}
