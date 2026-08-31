import { PowerScheduleEntity } from '../models/PowerSchedule';
import {
  desiredState, isWithinBusinessHours, nextStopAt, nextStartAt,
  computeDeferUntil, normalizeDays, powerScheduleResponse, isValidTimeZone,
} from '../services/powerScheduleService';

function policy(overrides: Partial<PowerScheduleEntity> = {}): PowerScheduleEntity {
  return Object.assign(new PowerScheduleEntity(), {
    id: 'singleton',
    enabled: true,
    autoShutdown: true,
    timeZone: 'America/Denver',
    startHour: 8,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    days: [1, 2, 3, 4, 5],
    deferUntil: null,
    deferredBy: null,
    lastAction: null,
    lastActionAt: null,
  }, overrides) as PowerScheduleEntity;
}

// 2026-07-15 and 2026-01-14 are both Wednesdays; 2026-07-18 is a Saturday.
const summerNine = new Date('2026-07-15T15:00:00Z'); // 09:00 MDT
const winterEight = new Date('2026-01-14T15:00:00Z'); // 08:00 MST

describe('powerScheduleService', () => {
  it('keeps resources up inside the window and stops them outside', () => {
    expect(desiredState(policy(), summerNine)).toBe('running');
    // 23:00 MDT, well outside 08:00-18:00.
    expect(desiredState(policy(), new Date('2026-07-16T05:00:00Z'))).toBe('stopped');
  });

  it('follows daylight saving instead of drifting like a fixed UTC cron', () => {
    // 14:00Z is 08:00 in Mountain Daylight Time but only 07:00 in standard
    // time. A UTC cron would get exactly one of these wrong.
    expect(isWithinBusinessHours(policy(), new Date('2026-07-15T14:00:00Z'))).toBe(true);
    expect(isWithinBusinessHours(policy(), new Date('2026-01-14T14:00:00Z'))).toBe(false);
    expect(isWithinBusinessHours(policy(), winterEight)).toBe(true);
  });

  it('treats unselected days as outside hours', () => {
    // Saturday 09:00 MDT.
    expect(desiredState(policy(), new Date('2026-07-18T15:00:00Z'))).toBe('stopped');
  });

  it('never volunteers an opinion when disabled', () => {
    expect(desiredState(policy({ enabled: false }), summerNine)).toBeNull();
  });

  it('starts but does not stop when auto shutdown is off', () => {
    const p = policy({ autoShutdown: false });
    expect(desiredState(p, summerNine)).toBe('running');
    expect(desiredState(p, new Date('2026-07-16T05:00:00Z'))).toBeNull();
    expect(nextStopAt(p, summerNine)).toBeNull();
  });

  it('supports a window that runs past midnight', () => {
    const p = policy({ startHour: 20, endHour: 4, days: [5] });
    expect(isWithinBusinessHours(p, new Date('2026-07-18T03:00:00Z'))).toBe(true); // Fri 21:00
    expect(isWithinBusinessHours(p, new Date('2026-07-18T08:00:00Z'))).toBe(true); // Sat 02:00
    expect(isWithinBusinessHours(p, new Date('2026-07-19T03:00:00Z'))).toBe(false); // Sat 21:00
  });

  it('holds the system up while a deferral is active, then lets go', () => {
    const late = new Date('2026-07-16T05:00:00Z'); // 23:00 MDT, normally stopped
    const p = policy({ deferUntil: new Date('2026-07-16T06:00:00Z') });
    expect(desiredState(p, late)).toBe('running');
    expect(desiredState(p, new Date('2026-07-16T06:00:01Z'))).toBe('stopped');
  });

  it('anchors a deferral on the shutdown it is pushing back', () => {
    const p = policy();
    // 18:00 MDT on 2026-07-15 is 2026-07-16T00:00:00Z.
    const deferred = computeDeferUntil(p, 3, summerNine);
    expect(deferred.toISOString()).toBe('2026-07-16T03:00:00.000Z');
  });

  it('stacks repeated deferrals instead of resetting them', () => {
    const p = policy({ deferUntil: new Date('2026-07-16T03:00:00Z') });
    const deferred = computeDeferUntil(p, 2, summerNine);
    expect(deferred.toISOString()).toBe('2026-07-16T05:00:00.000Z');
  });

  it('extends from now when shutdown has already passed', () => {
    const late = new Date('2026-07-16T05:00:00Z');
    const deferred = computeDeferUntil(policy(), 2, late);
    expect(deferred.toISOString()).toBe('2026-07-16T07:00:00.000Z');
  });

  it('reports the next start across a weekend', () => {
    // Saturday 09:00 MDT -> next start is Monday 08:00 MDT (14:00Z).
    const next = nextStartAt(policy(), new Date('2026-07-18T15:00:00Z'));
    expect(next?.toISOString()).toBe('2026-07-20T14:00:00.000Z');
  });

  it('looks past the current window instead of answering "in a minute"', () => {
    // Wednesday 09:00 MDT: already running, so the next *start* is Thursday
    // 08:00 MDT (14:00Z) - not one minute from now.
    const next = nextStartAt(policy(), summerNine);
    expect(next?.toISOString()).toBe('2026-07-16T14:00:00.000Z');
  });

  it('looks past the current downtime for the next stop', () => {
    // Wednesday 23:00 MDT: already stopped, so the next *stop* is Thursday
    // 18:00 MDT (2026-07-17T00:00Z).
    const next = nextStopAt(policy(), new Date('2026-07-16T05:00:00Z'));
    expect(next?.toISOString()).toBe('2026-07-17T00:00:00.000Z');
  });

  it('hides an expired deferral from the API response', () => {
    const p = policy({ deferUntil: new Date('2026-07-15T10:00:00Z'), deferredBy: 'a@b.com' });
    const body = powerScheduleResponse(p, summerNine);
    expect(body.deferActive).toBe(false);
    expect(body.deferUntil).toBeNull();
    expect(body.deferredBy).toBeNull();
  });

  it('normalizes day lists and rejects unknown zones', () => {
    expect(normalizeDays([3, 1, 1, 9, -2, 'x'])).toEqual([1, 3]);
    expect(normalizeDays('nope')).toEqual([]);
    expect(isValidTimeZone('America/Denver')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
