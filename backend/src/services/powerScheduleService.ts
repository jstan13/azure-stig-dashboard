/**
 * Business-hours power schedule: persistence and the "should this be running
 * right now?" decision.
 *
 * The scheduler Function is deliberately dumb — it asks this service what the
 * desired state is and reconciles Azure to match. Keeping the rules here means
 * the UI, the API and the Function can never disagree.
 *
 * All time maths goes through `Intl.DateTimeFormat` with a real IANA zone, so
 * daylight saving transitions are handled for free. (Encoding the window as a
 * UTC cron expression, which is what the Function used to do, silently drifts
 * by an hour twice a year.)
 */

import { AppDataSource } from '../database/dataSource';
import { PowerScheduleEntity } from '../models/PowerSchedule';

const isMock = () => process.env.MOCK_MODE === 'true';

/** Upper bound on a single "working late" deferral. */
export const MAX_DEFER_HOURS = 12;

/** How far ahead the next-transition search will look. */
const SEARCH_MINUTES = 8 * 24 * 60;

let mockPolicy: PowerScheduleEntity | null = null;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : fallback;
}

function seedPolicy(): PowerScheduleEntity {
  const policy = new PowerScheduleEntity();
  policy.id = 'singleton';
  policy.enabled = process.env.BUSINESS_HOURS_MODE === 'true';
  policy.autoShutdown = process.env.BUSINESS_HOURS_AUTO_SHUTDOWN === 'true';
  policy.timeZone = process.env.BUSINESS_HOURS_TIME_ZONE || 'UTC';
  policy.startHour = envInt('BUSINESS_HOURS_START_HOUR', 8);
  policy.startMinute = 0;
  policy.endHour = envInt('BUSINESS_HOURS_END_HOUR', 18);
  policy.endMinute = 0;
  policy.days = [1, 2, 3, 4, 5];
  policy.deferUntil = null;
  policy.deferredBy = null;
  policy.lastAction = null;
  policy.lastActionAt = null;
  return policy;
}

export async function getPowerSchedule(): Promise<PowerScheduleEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    if (!mockPolicy) mockPolicy = seedPolicy();
    return mockPolicy;
  }
  const repo = AppDataSource.getRepository(PowerScheduleEntity);
  let policy = await repo.findOne({ where: { id: 'singleton' } });
  if (!policy) policy = await repo.save(seedPolicy());
  return policy;
}

export async function savePowerSchedule(
  policy: PowerScheduleEntity,
): Promise<PowerScheduleEntity> {
  if (isMock() || !AppDataSource.isInitialized) {
    mockPolicy = policy;
    return policy;
  }
  return AppDataSource.getRepository(PowerScheduleEntity).save(policy);
}

// ── Time helpers ─────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

/** True when `timeZone` is a zone this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localParts(timeZone: string, date: Date): { dayOfWeek: number; minutes: number } {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch {
      // An unknown zone must not wedge the schedule; fall back to UTC.
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    }
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  return {
    dayOfWeek: Math.max(0, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)),
    minutes: value('hour') * 60 + value('minute'),
  };
}

/** Sorted, de-duplicated weekday list. Empty input means "no days selected". */
export function normalizeDays(days: unknown): number[] {
  if (!Array.isArray(days)) return [];
  const set = new Set<number>();
  for (const day of days) {
    const n = Number(day);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

// ── Decision ─────────────────────────────────────────────────────────────────

export type DesiredState = 'running' | 'stopped';

/** True when `date` falls inside the configured working window. */
export function isWithinBusinessHours(
  policy: PowerScheduleEntity,
  date = new Date(),
): boolean {
  const days = normalizeDays(policy.days);
  if (days.length === 0) return false;

  const start = policy.startHour * 60 + policy.startMinute;
  const end = policy.endHour * 60 + policy.endMinute;
  if (start === end) return false;

  const { dayOfWeek, minutes } = localParts(policy.timeZone || 'UTC', date);

  if (start < end) return days.includes(dayOfWeek) && minutes >= start && minutes < end;

  // Overnight window (e.g. 20:00 → 04:00). The day list names the day the
  // window *opens*, so the small hours belong to the previous day's entry.
  if (minutes >= start) return days.includes(dayOfWeek);
  if (minutes < end) return days.includes((dayOfWeek + 6) % 7);
  return false;
}

/** True when a "working late" deferral is currently holding the system up. */
export function isDeferralActive(
  policy: PowerScheduleEntity,
  now = new Date(),
): boolean {
  return Boolean(policy.deferUntil && new Date(policy.deferUntil).getTime() > now.getTime());
}

/**
 * What the resources should be doing right now, or `null` when the schedule
 * has no opinion and whatever an operator did manually must be left alone.
 */
export function desiredState(
  policy: PowerScheduleEntity,
  date = new Date(),
): DesiredState | null {
  if (!policy.enabled) return null;
  if (isDeferralActive(policy, date)) return 'running';
  if (isWithinBusinessHours(policy, date)) return 'running';
  return policy.autoShutdown ? 'stopped' : null;
}

function nextTransitionTo(
  policy: PowerScheduleEntity,
  target: DesiredState,
  from: Date,
): Date | null {
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let i = 0; i < SEARCH_MINUTES; i += 1) {
    if (desiredState(policy, candidate) === target) return new Date(candidate);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

/** When the schedule will next want everything stopped. */
export function nextStopAt(policy: PowerScheduleEntity, from = new Date()): Date | null {
  if (!policy.enabled || !policy.autoShutdown) return null;
  return nextTransitionTo(policy, 'stopped', from);
}

/** When the schedule will next want everything running. */
export function nextStartAt(policy: PowerScheduleEntity, from = new Date()): Date | null {
  if (!policy.enabled) return null;
  return nextTransitionTo(policy, 'running', from);
}

/**
 * Where a deferral of `hours` should land.
 *
 * The anchor is the shutdown the deferral is pushing back — including one
 * already pushed back by an earlier press, so the button stacks predictably
 * instead of resetting. If shutdown has already passed (someone started the
 * system manually) we extend from now instead.
 */
export function computeDeferUntil(
  policy: PowerScheduleEntity,
  hours: number,
  now = new Date(),
): Date {
  // If shutdown has already passed, the next one is a whole day away and is
  // not what the operator means; extend from now instead.
  if (desiredState(policy, now) === 'stopped') {
    return new Date(now.getTime() + hours * 3_600_000);
  }
  const stop = nextStopAt(policy, now);
  const anchor = stop && stop.getTime() > now.getTime() ? stop : now;
  return new Date(anchor.getTime() + hours * 3_600_000);
}

// ── API shape ────────────────────────────────────────────────────────────────

export function powerScheduleResponse(policy: PowerScheduleEntity, now = new Date()) {
  const deferActive = isDeferralActive(policy, now);
  return {
    enabled: policy.enabled,
    autoShutdown: policy.autoShutdown,
    timeZone: policy.timeZone,
    startHour: policy.startHour,
    startMinute: policy.startMinute,
    endHour: policy.endHour,
    endMinute: policy.endMinute,
    days: normalizeDays(policy.days),
    deferUntil: deferActive ? new Date(policy.deferUntil as Date).toISOString() : null,
    deferredBy: deferActive ? policy.deferredBy : null,
    deferActive,
    maxDeferHours: MAX_DEFER_HOURS,
    withinHoursNow: isWithinBusinessHours(policy, now),
    desiredState: desiredState(policy, now),
    nextStartAt: nextStartAt(policy, now)?.toISOString() ?? null,
    nextStopAt: nextStopAt(policy, now)?.toISOString() ?? null,
    lastAction: policy.lastAction,
    lastActionAt: policy.lastActionAt,
  };
}

export type PowerScheduleResponse = ReturnType<typeof powerScheduleResponse>;
