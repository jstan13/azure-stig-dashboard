import { GpoSettingsEntity } from '../models/GpoSettings';
import { isDiscoveryDue, matchesDiscoverySchedule, nextDiscoveryAt } from '../gpo/gpoSettingsService';
import {
  evaluateDrift, exceptionIdentity, isEndedException, isLiveException, mergeLinks, sameEffect, uncoveredCustomizations,
} from '../gpo/gpoReleaseService';
import type { GpoCustomization, GpoExceptionSnapshot } from '../models/GpoRelease';

function settings(overrides: Partial<GpoSettingsEntity> = {}): GpoSettingsEntity {
  return Object.assign(new GpoSettingsEntity(), {
    id: 'singleton', discoveryMode: 'scheduled', frequency: 'weekly', dayOfWeek: 1, hour: 6, minute: 30,
    timeZone: 'America/Denver', carryForwardMode: 'auto', testSoakHours: 24, requireDistinctApprovers: false,
    lastCheckedAt: null, lastCheckOutcome: null, lastCheckError: null,
  }, overrides);
}

// 2026-10-05 is a Monday; 06:30 in Denver (MDT, UTC-6) is 12:30 UTC.
const mondayAt630Denver = new Date('2026-10-05T12:30:00Z');

describe('GPO discovery schedule', () => {
  it('never runs automatically in manual mode', () => {
    const s = settings({ discoveryMode: 'manual' });
    expect(matchesDiscoverySchedule(s, mondayAt630Denver)).toBe(false);
    expect(nextDiscoveryAt(s)).toBeNull();
  });

  it('runs weekly at the configured local time', () => {
    expect(isDiscoveryDue(settings(), mondayAt630Denver)).toBe(true);
    expect(isDiscoveryDue(settings(), new Date('2026-10-06T12:30:00Z'))).toBe(false);
    expect(isDiscoveryDue(settings({ frequency: 'daily' }), new Date('2026-10-06T12:30:00Z'))).toBe(true);
  });

  it('runs once per occurrence even if several instances tick', () => {
    const s = settings({ lastCheckedAt: new Date('2026-10-05T12:30:05Z') });
    expect(isDiscoveryDue(s, mondayAt630Denver)).toBe(false);
  });

  it('predicts the next scheduled check', () => {
    expect(nextDiscoveryAt(settings(), new Date('2026-10-05T13:00:00Z'))).toBe('2026-10-12T12:30:00.000Z');
  });
});

const found = (overrides: Partial<GpoCustomization> = {}): GpoCustomization => ({
  gpoFamily: 'DoD WinSvr 2022 MS STIG Comp', kind: 'securityTemplate', action: 'set',
  section: 'Privilege Rights', settingKey: 'SeDenyNetworkLogonRight', settingValue: '*S-1-5-114,*S-1-5-21-1-512',
  sourceGpoName: 'DoD WinSvr 2022 MS STIG Comp v2r8 [April 2026]', baselineKnown: true, ...overrides,
});

const frozen = (overrides: Partial<GpoExceptionSnapshot> = {}): GpoExceptionSnapshot => ({
  id: 'e1', gpoFamily: 'DoD WinSvr 2022 MS STIG Comp', kind: 'securityTemplate', action: 'set',
  hive: null, key: null, valueName: null, valueType: null, value: null,
  section: 'Privilege Rights', settingKey: 'sedenynetworklogonright', settingValue: '*S-1-5-114,*S-1-5-21-1-512 ',
  justification: 'x', approvedBy: 'system', ...overrides,
});

describe('production customization coverage', () => {
  it('identifies settings case-insensitively and compares values', () => {
    expect(exceptionIdentity(found())).toBe(exceptionIdentity(frozen()));
    expect(sameEffect(found(), frozen())).toBe(true);
    expect(sameEffect(found({ settingValue: '*S-1-5-114' }), frozen())).toBe(false);
  });

  it('flags production changes the release would not reproduce', () => {
    const registry = found({
      kind: 'registry', hive: 'HKLM', key: 'Software\\Policies\\Microsoft\\Edge', valueName: 'SmartScreenEnabled',
      valueType: 'DWord', value: '0', section: null, settingKey: null, settingValue: null,
    });
    expect(uncoveredCustomizations([found(), registry], [frozen()])).toEqual([registry]);
    expect(uncoveredCustomizations([registry], [{ ...frozen(), ...registry, id: 'e2', justification: 'x', approvedBy: null } as GpoExceptionSnapshot]))
      .toEqual([]);
  });

  it('lets the newest link state win when merging', () => {
    const staged = { target: 'OU=Servers,DC=c,DC=mil', gpoId: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}', gpoName: 'New', enabled: false };
    const live = { ...staged, gpoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', enabled: true };
    expect(mergeLinks([staged], [live])).toEqual([live]);
  });
});

describe('production drift', () => {
  const surveyed = new Set(['DoD WinSvr 2022 MS STIG Comp']);
  const registry = found({
    kind: 'registry', hive: 'HKLM', key: 'Software\\Policies\\X', valueName: 'Y', valueType: 'DWord', value: '0',
    section: null, settingKey: null, settingValue: null,
  });

  it('treats person-revoked and expired exceptions as deliberate drops', () => {
    const past = new Date('2020-01-01');
    expect(isEndedException({ ...frozen(), status: 'revoked', revokedBy: 'issm@contoso.mil' })).toBe(true);
    expect(isEndedException({ ...frozen(), status: 'revoked', revokedBy: 'system (production value changed)' })).toBe(false);
    expect(isEndedException({ ...frozen(), status: 'approved', expiresAt: past })).toBe(true);
    expect(isLiveException({ ...frozen(), status: 'approved', expiresAt: past })).toBe(false);
    expect(isLiveException({ ...frozen(), status: 'pending' })).toBe(true);
  });

  it('splits production findings into uncovered, dropped, and stale', () => {
    const detectedGone = frozen({ id: 'gone', source: 'detected', kind: 'registry', hive: 'HKLM', key: 'Software\\Old', valueName: 'Z',
      valueType: 'DWord', value: '1', section: null, settingKey: null, settingValue: null });
    const manual = frozen({ id: 'manual', source: 'manual', kind: 'registry', hive: 'HKLM', key: 'Software\\Manual', valueName: 'M',
      valueType: 'DWord', value: '1', section: null, settingKey: null, settingValue: null });
    const drift = evaluateDrift([found(), registry], [frozen({ source: 'detected' }), detectedGone, manual], [], surveyed);
    expect(drift.uncovered).toEqual([registry]);
    expect(drift.dropped).toEqual([]);
    expect(drift.stale.map((e) => e.id)).toEqual(['gone']);

    const deliberate = evaluateDrift([found(), registry], [frozen()], [registry], surveyed);
    expect(deliberate.uncovered).toEqual([]);
    expect(deliberate.dropped).toEqual([registry]);
  });

  it('only calls frozen customizations stale for families production was surveyed for', () => {
    const other = frozen({ id: 'other', source: 'detected', gpoFamily: 'DoD Windows 11 Computer STIG' });
    expect(evaluateDrift([], [other], [], surveyed).stale).toEqual([]);
  });
});
