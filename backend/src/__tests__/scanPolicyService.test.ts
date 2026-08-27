import { ScanPolicyEntity } from '../models/ScanPolicy';
import {
  isScanDue, matchesScanSchedule, nextScanRunAt,
} from '../services/scanPolicyService';

function policy(overrides: Partial<ScanPolicyEntity> = {}): ScanPolicyEntity {
  return Object.assign(new ScanPolicyEntity(), {
    id: 'singleton',
    enabled: true,
    frequency: 'daily',
    minute: 15,
    hour: 14,
    dayOfWeek: 3,
    timeZone: 'UTC',
    lastScheduledRunAt: null,
    lastStatus: null,
    lastError: null,
  }, overrides);
}

describe('scan schedule matching', () => {
  const wednesday = new Date('2026-08-26T14:15:00Z');

  it('does not run while disabled', () => {
    expect(matchesScanSchedule(policy({ enabled: false }), wednesday)).toBe(false);
    expect(nextScanRunAt(policy({ enabled: false }), wednesday)).toBeNull();
  });

  it('matches hourly schedules at the selected minute', () => {
    const hourly = policy({ frequency: 'hourly' });
    expect(matchesScanSchedule(hourly, wednesday)).toBe(true);
    expect(matchesScanSchedule(hourly, new Date('2026-08-26T14:16:00Z'))).toBe(false);
  });

  it('matches daily schedules at the selected local time', () => {
    expect(matchesScanSchedule(policy(), wednesday)).toBe(true);
    expect(matchesScanSchedule(policy(), new Date('2026-08-26T13:15:00Z'))).toBe(false);
  });

  it('matches weekly schedules on the selected weekday', () => {
    const weekly = policy({ frequency: 'weekly' });
    expect(matchesScanSchedule(weekly, wednesday)).toBe(true);
    expect(matchesScanSchedule(weekly, new Date('2026-08-27T14:15:00Z'))).toBe(false);
  });

  it('uses the configured time zone', () => {
    const central = policy({ timeZone: 'America/Chicago', hour: 9 });
    expect(matchesScanSchedule(central, wednesday)).toBe(true);
  });

  it('does not repeat the same scheduled occurrence', () => {
    expect(isScanDue(policy({ lastScheduledRunAt: wednesday }), wednesday)).toBe(false);
    expect(isScanDue(policy({ lastScheduledRunAt: new Date('2026-08-25T14:15:00Z') }), wednesday)).toBe(true);
  });
});

describe('nextScanRunAt', () => {
  it('finds the next hourly run', () => {
    expect(nextScanRunAt(
      policy({ frequency: 'hourly', minute: 15 }),
      new Date('2026-08-26T14:20:00Z'),
    )).toBe('2026-08-26T15:15:00.000Z');
  });

  it('finds the next weekly run', () => {
    expect(nextScanRunAt(
      policy({ frequency: 'weekly', dayOfWeek: 3 }),
      new Date('2026-08-26T14:16:00Z'),
    )).toBe('2026-09-02T14:15:00.000Z');
  });
});