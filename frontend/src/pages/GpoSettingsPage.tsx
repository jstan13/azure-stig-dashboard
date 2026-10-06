/**
 * Settings → GPO releases: how new DISA GPO packages are found and what the
 * pipeline does with customizations found in today's production GPOs.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ChoiceGroup, DefaultButton, Dropdown, IDropdownOption, MessageBar, MessageBarType,
  PrimaryButton, SpinButton, Spinner, SpinnerSize, Stack, Text, Toggle,
} from '@fluentui/react';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';

interface GpoSettings {
  discoveryMode: 'manual' | 'scheduled';
  frequency: 'daily' | 'weekly';
  dayOfWeek: number;
  hour: number;
  minute: number;
  timeZone: string;
  carryForwardMode: 'auto' | 'review';
  testSoakHours: number;
  requireDistinctApprovers: boolean;
  lastCheckedAt: string | null;
  lastCheckOutcome: string | null;
  lastCheckError: string | null;
  nextCheckAt: string | null;
}

const dayOptions: IDropdownOption[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .map((text, key) => ({ key, text }));
const hourOptions: IDropdownOption[] = Array.from({ length: 24 }, (_, h) => ({ key: h, text: `${String(h).padStart(2, '0')}:00` }));
const minuteOptions: IDropdownOption[] = Array.from({ length: 12 }, (_, i) => ({ key: i * 5, text: `:${String(i * 5).padStart(2, '0')}` }));

const zoneOptions: IDropdownOption[] = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  return (zones.includes('UTC') ? zones : ['UTC', ...zones]).map((z) => ({ key: z, text: z.replace(/_/g, ' ') }));
})();

const outcomeText: Record<string, string> = {
  new: 'new package found and staged for review',
  unchanged: 'no new package',
  none: 'DISA lists no GPO package',
  failed: 'failed',
};

export default function GpoSettingsPage() {
  const api = useApi();
  const { has } = usePermissions();
  const canManage = has('gpo:configure');
  const [saved, setSaved] = useState<GpoSettings | null>(null);
  const [draft, setDraft] = useState<GpoSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<GpoSettings>('/api/gpo/settings');
      setSaved(res.data);
      setDraft(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not load GPO settings');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const patch = (values: Partial<GpoSettings>) => setDraft((d) => (d ? { ...d, ...values } : d));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.put<GpoSettings>('/api/gpo/settings', {
        discoveryMode: draft.discoveryMode,
        frequency: draft.frequency,
        dayOfWeek: draft.dayOfWeek,
        hour: draft.hour,
        minute: draft.minute,
        timeZone: draft.timeZone,
        carryForwardMode: draft.carryForwardMode,
        testSoakHours: draft.testSoakHours,
        requireDistinctApprovers: draft.requireDistinctApprovers,
      });
      setSaved(res.data);
      setDraft(res.data);
      setNotice(res.data.discoveryMode === 'scheduled' && res.data.nextCheckAt
        ? `Saved. Next DISA check: ${new Date(res.data.nextCheckAt).toLocaleString()}.`
        : 'Saved. DISA is checked only when someone clicks "Check DISA now".');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save GPO settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading GPO settings..." />;

  const disabled = !canManage || saving;
  const scheduled = draft?.discoveryMode === 'scheduled';
  const card = { root: { background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 } };

  return (
    <Stack tokens={{ childrenGap: 18 }} styles={{ root: { maxWidth: 860 } }}>
      <Stack tokens={{ childrenGap: 4 }}>
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>GPO releases</Text>
        <Text style={{ color: '#605e5c' }}>
          How the tracker finds new DISA GPO packages and prepares them for review, testing, and production.
        </Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {notice && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setNotice('')}>{notice}</MessageBar>}

      {draft && (
        <>
          <Stack tokens={{ childrenGap: 14 }} styles={card}>
            <Text variant="large" style={{ fontWeight: 600 }}>Checking DISA for new packages</Text>
            <ChoiceGroup
              selectedKey={draft.discoveryMode}
              disabled={disabled}
              onChange={(_, o) => o && patch({ discoveryMode: o.key as GpoSettings['discoveryMode'] })}
              options={[
                { key: 'manual', text: 'Manually — only when someone clicks "Check DISA now" on the GPO Releases page' },
                { key: 'scheduled', text: 'Automatically on a schedule (you can still check manually any time)' },
              ]}
            />
            <Stack horizontal wrap tokens={{ childrenGap: 12 }}>
              <Dropdown label="Frequency" selectedKey={draft.frequency} disabled={disabled || !scheduled}
                options={[{ key: 'daily', text: 'Daily' }, { key: 'weekly', text: 'Weekly' }]} styles={{ root: { width: 150 } }}
                onChange={(_, o) => o && patch({ frequency: o.key as GpoSettings['frequency'] })} />
              {draft.frequency === 'weekly' && (
                <Dropdown label="Day" selectedKey={draft.dayOfWeek} options={dayOptions} disabled={disabled || !scheduled}
                  styles={{ root: { width: 160 } }} onChange={(_, o) => o && patch({ dayOfWeek: Number(o.key) })} />
              )}
              <Dropdown label="Hour" selectedKey={draft.hour} options={hourOptions} disabled={disabled || !scheduled}
                styles={{ root: { width: 120 } }} onChange={(_, o) => o && patch({ hour: Number(o.key) })} />
              <Dropdown label="Minute" selectedKey={draft.minute} options={minuteOptions} disabled={disabled || !scheduled}
                styles={{ root: { width: 110 } }} onChange={(_, o) => o && patch({ minute: Number(o.key) })} />
              <Dropdown label="Time zone" selectedKey={draft.timeZone} options={zoneOptions} disabled={disabled || !scheduled}
                styles={{ root: { minWidth: 240 } }} onChange={(_, o) => o && patch({ timeZone: String(o.key) })} />
            </Stack>
            <Text style={{ color: '#605e5c' }}>
              DISA publishes STIG and GPO packages on separate dates, so a weekly check catches a late package without waiting for the next quarter.
            </Text>
            <Stack tokens={{ childrenGap: 4 }}>
              <Text>Next automatic check: <strong>{saved?.nextCheckAt ? new Date(saved.nextCheckAt).toLocaleString() : 'None (manual)'}</strong></Text>
              <Text>
                Last check: <strong>{saved?.lastCheckedAt ? new Date(saved.lastCheckedAt).toLocaleString() : 'Never'}</strong>
                {saved?.lastCheckOutcome ? ` — ${outcomeText[saved.lastCheckOutcome] ?? saved.lastCheckOutcome}` : ''}
              </Text>
              {saved?.lastCheckError && <Text style={{ color: '#a4262c' }}>{saved.lastCheckError}</Text>}
            </Stack>
          </Stack>

          <Stack tokens={{ childrenGap: 14 }} styles={card}>
            <Text variant="large" style={{ fontWeight: 600 }}>Customizations already in production</Text>
            <Text style={{ color: '#605e5c' }}>
              When a package is found, the production agent compares each live production GPO with the DISA release it came from.
              Settings your team changed become exceptions, so test and production get the same customizations in the new GPOs.
            </Text>
            <ChoiceGroup
              selectedKey={draft.carryForwardMode}
              disabled={disabled}
              onChange={(_, o) => o && patch({ carryForwardMode: o.key as GpoSettings['carryForwardMode'] })}
              options={[
                { key: 'auto', text: 'Carry them forward automatically (recorded as approved exceptions)' },
                { key: 'review', text: 'Hold them as pending exceptions until someone approves each one' },
              ]}
            />
            <Text style={{ color: '#605e5c' }}>
              Customizations on a production GPO whose original DISA release is unknown always wait for approval.
            </Text>
          </Stack>

          <Stack tokens={{ childrenGap: 14 }} styles={card}>
            <Text variant="large" style={{ fontWeight: 600 }}>Testing and approvals</Text>
            <SpinButton
              label="Hours to wait after deploying to test before validating"
              min={0} max={720} step={1}
              value={String(draft.testSoakHours)}
              disabled={disabled}
              styles={{ root: { width: 380 } }}
              onChange={(_, v) => v !== undefined && patch({ testSoakHours: Math.max(0, Math.min(720, Number(v) || 0)) })}
            />
            <Toggle
              label="Require a different person to approve production than approved the test deployment"
              checked={draft.requireDistinctApprovers}
              disabled={disabled}
              onText="Required" offText="Not required"
              onChange={(_, c) => patch({ requireDistinctApprovers: !!c })}
            />
          </Stack>

          {canManage ? (
            <Stack horizontal tokens={{ childrenGap: 8 }}>
              <PrimaryButton text="Save settings" disabled={saving} onClick={() => void save()} />
              <DefaultButton text="Discard changes" disabled={saving} onClick={() => setDraft(saved)} />
            </Stack>
          ) : (
            <MessageBar messageBarType={MessageBarType.info}>Only an administrator can change these settings.</MessageBar>
          )}
        </>
      )}
    </Stack>
  );
}
