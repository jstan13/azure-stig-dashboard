/**
 * The update scheduler acts on whatever `decide()` returns, so these cases are
 * the actual guardrails: no unapproved install, nothing outside the window, and
 * "set and forget" genuinely means unattended.
 */
import { UpdatePolicyEntity } from '../models/UpdatePolicy';
import { decide, isWithinWindow, localParts } from '../services/updateService';

function policy(overrides: Partial<UpdatePolicyEntity> = {}): UpdatePolicyEntity {
  const p = new UpdatePolicyEntity();
  p.id = 'singleton';
  p.mode = 'auto';
  p.requireApproval = true;
  p.securityOnly = false;
  p.dayOfWeek = null;
  p.hour = 2;
  p.timeZone = 'UTC';
  p.currentVersion = 'v1.0.0';
  p.availableVersion = 'v1.1.0';
  p.availableNotes = null;
  p.approvedVersion = null;
  p.approvedBy = null;
  p.lastCheckedAt = null;
  p.history = [];
  return Object.assign(p, overrides);
}

// 2025-01-01T02:30:00Z is a Wednesday (day 3).
const inWindow = new Date('2025-01-01T02:30:00Z');
const outOfWindow = new Date('2025-01-01T09:30:00Z');

describe('localParts', () => {
  it('reads the hour and weekday in the requested zone', () => {
    expect(localParts('UTC', inWindow)).toEqual({ hour: 2, day: 3 });
  });

  it('shifts with the zone', () => {
    // 02:30 UTC is 21:30 the previous day (Tuesday) in New York.
    expect(localParts('America/New_York', inWindow)).toEqual({ hour: 21, day: 2 });
  });
});

describe('isWithinWindow', () => {
  it('matches on the hour when any day is allowed', () => {
    expect(isWithinWindow(policy(), inWindow)).toBe(true);
    expect(isWithinWindow(policy(), outOfWindow)).toBe(false);
  });

  it('honours a specific day', () => {
    expect(isWithinWindow(policy({ dayOfWeek: 3 }), inWindow)).toBe(true);
    expect(isWithinWindow(policy({ dayOfWeek: 4 }), inWindow)).toBe(false);
  });

  it('falls back to UTC rather than staying open on a bad zone', () => {
    expect(isWithinWindow(policy({ timeZone: 'Not/AZone' }), inWindow)).toBe(true);
    expect(isWithinWindow(policy({ timeZone: 'Not/AZone' }), outOfWindow)).toBe(false);
  });
});

describe('decide', () => {
  it('does nothing without release information', () => {
    expect(decide(policy({ availableVersion: null }), inWindow).action).toBe('none');
  });

  it('does nothing when already current', () => {
    expect(decide(policy({ availableVersion: 'v1.0.0' }), inWindow).action).toBe('none');
  });

  it('does nothing when auto-update is off, even in the window', () => {
    expect(decide(policy({ mode: 'off' }), inWindow).action).toBe('none');
  });

  it('only notifies in notify mode', () => {
    expect(decide(policy({ mode: 'notify' }), inWindow).action).toBe('notify');
  });

  it('will not install an unapproved release', () => {
    const d = decide(policy({ requireApproval: true, approvedVersion: null }), inWindow);
    expect(d.action).toBe('notify');
    expect(d.reason).toMatch(/approval/);
  });

  it('will not install approval granted for a different version', () => {
    expect(decide(policy({ approvedVersion: 'v1.0.5' }), inWindow).action).toBe('notify');
  });

  it('installs an approved release inside the window', () => {
    const d = decide(policy({ approvedVersion: 'v1.1.0' }), inWindow);
    expect(d).toMatchObject({ action: 'install', version: 'v1.1.0' });
  });

  it('holds an approved release outside the window', () => {
    const d = decide(policy({ approvedVersion: 'v1.1.0' }), outOfWindow);
    expect(d.action).toBe('notify');
    expect(d.reason).toMatch(/window/);
  });

  it('set-and-forget installs without approval, but still only in the window', () => {
    expect(decide(policy({ requireApproval: false }), inWindow).action).toBe('install');
    expect(decide(policy({ requireApproval: false }), outOfWindow).action).toBe('notify');
  });

  it('force ignores the window and the approval gate', () => {
    const d = decide(policy({ requireApproval: true }), outOfWindow, true);
    expect(d).toMatchObject({ action: 'install', version: 'v1.1.0' });
  });

  it('force still will not reinstall the current version', () => {
    expect(decide(policy({ availableVersion: 'v1.0.0' }), outOfWindow, true).action).toBe('none');
  });
});
