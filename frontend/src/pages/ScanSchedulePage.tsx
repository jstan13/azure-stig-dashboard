import { useCallback, useEffect, useState } from 'react';
import {
  DefaultButton, Dropdown, IDropdownOption, MessageBar, MessageBarType,
  PrimaryButton, Spinner, SpinnerSize, Stack, Text, Toggle,
} from '@fluentui/react';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';

type ScanFrequency = 'hourly' | 'daily' | 'weekly';

interface ScanPolicy {
  enabled: boolean;
  frequency: ScanFrequency;
  minute: number;
  hour: number;
  dayOfWeek: number;
  timeZone: string;
  nextRunAt: string | null;
  lastScheduledRunAt: string | null;
  lastStatus: 'running' | 'completed' | 'failed' | null;
  lastError: string | null;
}

const frequencyOptions: IDropdownOption[] = [
  { key: 'hourly', text: 'Hourly' },
  { key: 'daily', text: 'Daily' },
  { key: 'weekly', text: 'Weekly' },
];

const dayOptions: IDropdownOption[] = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
].map((text, key) => ({ key, text }));

const hourOptions: IDropdownOption[] = Array.from({ length: 24 }, (_, hour) => ({
  key: hour,
  text: `${String(hour).padStart(2, '0')}:00`,
}));

const minuteOptions: IDropdownOption[] = Array.from({ length: 12 }, (_, index) => ({
  key: index * 5,
  text: `:${String(index * 5).padStart(2, '0')}`,
}));

function timeZoneOptions(): IDropdownOption[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf
    ? intl.supportedValuesOf('timeZone')
    : ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
       'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
  const values = zones.includes('UTC') ? zones : ['UTC', ...zones];
  return values.map((zone) => ({ key: zone, text: zone.replace(/_/g, ' ') }));
}

const zoneOptions = timeZoneOptions();

export default function ScanSchedulePage() {
  const api = useApi();
  const { has } = usePermissions();
  const canManage = has('scan:schedule');
  const [saved, setSaved] = useState<ScanPolicy | null>(null);
  const [draft, setDraft] = useState<ScanPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get<ScanPolicy>('/api/scan/schedule');
      setSaved(response.data);
      setDraft(response.data);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not load the scan schedule');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const patch = (values: Partial<ScanPolicy>) =>
    setDraft((current) => current ? { ...current, ...values } : current);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await api.put<ScanPolicy>('/api/scan/schedule', {
        enabled: draft.enabled,
        frequency: draft.frequency,
        minute: draft.minute,
        hour: draft.hour,
        dayOfWeek: draft.dayOfWeek,
        timeZone: draft.timeZone,
      });
      setSaved(response.data);
      setDraft(response.data);
      setNotice(response.data.enabled
        ? `Schedule saved. Next scan: ${new Date(response.data.nextRunAt!).toLocaleString()}.`
        : 'Automatic scans are disabled.');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save the scan schedule');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading scan schedule..." />;

  return (
    <Stack tokens={{ childrenGap: 18 }} styles={{ root: { maxWidth: 820 } }}>
      <Stack tokens={{ childrenGap: 4 }}>
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>Scan schedule</Text>
        <Text style={{ color: '#605e5c' }}>
          Refresh inventory and compliance data automatically. Manual scans remain available on the Overview page.
        </Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {notice && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setNotice('')}>{notice}</MessageBar>}

      {draft && (
        <Stack tokens={{ childrenGap: 16 }} styles={{ root: { background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 } }}>
          <Toggle
            label="Automatic scans"
            checked={draft.enabled}
            disabled={!canManage || saving}
            onText="Enabled"
            offText="Disabled"
            onChange={(_event, checked) => patch({ enabled: !!checked })}
          />

          <Stack horizontal wrap tokens={{ childrenGap: 12 }}>
            <Dropdown
              label="Frequency"
              selectedKey={draft.frequency}
              options={frequencyOptions}
              disabled={!canManage || saving || !draft.enabled}
              styles={{ root: { width: 180 } }}
              onChange={(_event, option) => option && patch({ frequency: option.key as ScanFrequency })}
            />
            {draft.frequency === 'weekly' && (
              <Dropdown
                label="Day"
                selectedKey={draft.dayOfWeek}
                options={dayOptions}
                disabled={!canManage || saving || !draft.enabled}
                styles={{ root: { width: 180 } }}
                onChange={(_event, option) => option && patch({ dayOfWeek: Number(option.key) })}
              />
            )}
            {draft.frequency !== 'hourly' && (
              <Dropdown
                label="Hour"
                selectedKey={draft.hour}
                options={hourOptions}
                disabled={!canManage || saving || !draft.enabled}
                styles={{ root: { width: 140 } }}
                onChange={(_event, option) => option && patch({ hour: Number(option.key) })}
              />
            )}
            <Dropdown
              label="Minute"
              selectedKey={draft.minute}
              options={minuteOptions}
              disabled={!canManage || saving || !draft.enabled}
              styles={{ root: { width: 120 } }}
              onChange={(_event, option) => option && patch({ minute: Number(option.key) })}
            />
            <Dropdown
              label="Time zone"
              selectedKey={draft.timeZone}
              options={zoneOptions}
              disabled={!canManage || saving || !draft.enabled}
              styles={{ root: { minWidth: 260 } }}
              onChange={(_event, option) => option && patch({ timeZone: String(option.key) })}
            />
          </Stack>

          <Stack tokens={{ childrenGap: 4 }}>
            <Text>Next scheduled scan: <strong>{draft.nextRunAt ? new Date(draft.nextRunAt).toLocaleString() : 'Not scheduled'}</strong></Text>
            <Text>
              Last scheduled attempt: <strong>{draft.lastScheduledRunAt ? new Date(draft.lastScheduledRunAt).toLocaleString() : 'Never'}</strong>
              {draft.lastStatus ? ` (${draft.lastStatus})` : ''}
            </Text>
            {draft.lastError && <Text style={{ color: '#a4262c' }}>{draft.lastError}</Text>}
          </Stack>

          {canManage ? (
            <Stack horizontal tokens={{ childrenGap: 8 }}>
              <PrimaryButton text="Save schedule" disabled={saving} onClick={save} />
              <DefaultButton text="Discard changes" disabled={saving} onClick={() => setDraft(saved)} />
              <DefaultButton text="Refresh status" disabled={saving} onClick={() => void load()} />
            </Stack>
          ) : (
            <MessageBar messageBarType={MessageBarType.info}>Only an administrator can change this schedule.</MessageBar>
          )}
        </Stack>
      )}
    </Stack>
  );
}