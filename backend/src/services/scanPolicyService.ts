import { AppDataSource } from '../database/dataSource';
import { ScanPolicyEntity } from '../models/ScanPolicy';

const isMock = () => process.env.MOCK_MODE === 'true';

let mockPolicy: ScanPolicyEntity | null = null;

function seedPolicy(): ScanPolicyEntity {
  const policy = new ScanPolicyEntity();
  policy.id = 'singleton';
  policy.enabled = process.env.SCAN_SCHEDULE_ENABLED === 'true';
  policy.frequency = 'daily';
  policy.minute = 0;
  policy.hour = 2;
  policy.dayOfWeek = 0;
  policy.timeZone = 'UTC';
  policy.lastScheduledRunAt = null;
  policy.lastStatus = null;
  policy.lastError = null;

  const cron = process.env.SCAN_CRON_SCHEDULE?.trim().split(/\s+/);
  if (cron?.length === 5) {
    const [minute, hour, dayOfMonth, , dayOfWeek] = cron;
    if (/^\d+$/.test(minute)) policy.minute = Number(minute);
    if (hour === '*') policy.frequency = 'hourly';
    else if (/^\d+$/.test(hour)) policy.hour = Number(hour);
    if (dayOfMonth === '*' && /^\d$/.test(dayOfWeek)) {
      policy.frequency = 'weekly';
      policy.dayOfWeek = Number(dayOfWeek);
    }
  }
  return policy;
}

export async function getScanPolicy(): Promise<ScanPolicyEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    if (!mockPolicy) mockPolicy = seedPolicy();
    return mockPolicy;
  }
  const repo = AppDataSource.getRepository(ScanPolicyEntity);
  let policy = await repo.findOne({ where: { id: 'singleton' } });
  if (!policy) policy = await repo.save(seedPolicy());
  return policy;
}

export async function saveScanPolicy(policy: ScanPolicyEntity): Promise<ScanPolicyEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    mockPolicy = policy;
    return policy;
  }
  return AppDataSource.getRepository(ScanPolicyEntity).save(policy);
}

interface LocalParts {
  year: number;
  month: number;
  dayOfMonth: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(timeZone: string, date: Date): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  return {
    year: value('year'),
    month: value('month'),
    dayOfMonth: value('day'),
    dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday),
    hour: value('hour'),
    minute: value('minute'),
  };
}

export function matchesScanSchedule(policy: ScanPolicyEntity, date = new Date()): boolean {
  if (!policy.enabled) return false;
  const parts = localParts(policy.timeZone, date);
  if (parts.minute !== policy.minute) return false;
  if (policy.frequency === 'hourly') return true;
  if (parts.hour !== policy.hour) return false;
  return policy.frequency === 'daily' || parts.dayOfWeek === policy.dayOfWeek;
}

function occurrenceKey(policy: ScanPolicyEntity, date: Date): string {
  const parts = localParts(policy.timeZone, date);
  const dateKey = `${parts.year}-${parts.month}-${parts.dayOfMonth}`;
  if (policy.frequency === 'hourly') return `${dateKey}-${parts.hour}`;
  if (policy.frequency === 'daily') return dateKey;
  return `${dateKey}-${parts.dayOfWeek}`;
}

export function isScanDue(policy: ScanPolicyEntity, date = new Date()): boolean {
  if (!matchesScanSchedule(policy, date)) return false;
  return !policy.lastScheduledRunAt
    || occurrenceKey(policy, policy.lastScheduledRunAt) !== occurrenceKey(policy, date);
}

export function nextScanRunAt(policy: ScanPolicyEntity, from = new Date()): string | null {
  if (!policy.enabled) return null;
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const maxMinutes = 8 * 24 * 60;
  for (let offset = 0; offset < maxMinutes; offset += 1) {
    if (matchesScanSchedule(policy, candidate)) return candidate.toISOString();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

export function scanPolicyResponse(policy: ScanPolicyEntity) {
  return {
    enabled: policy.enabled,
    frequency: policy.frequency,
    minute: policy.minute,
    hour: policy.hour,
    dayOfWeek: policy.dayOfWeek,
    timeZone: policy.timeZone,
    lastScheduledRunAt: policy.lastScheduledRunAt,
    lastStatus: policy.lastStatus,
    lastError: policy.lastError,
    nextRunAt: nextScanRunAt(policy),
  };
}
