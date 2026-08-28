/**
 * Business hours — when this dashboard's own Azure resources are powered on.
 *
 * Outside the window the scheduler Function stops the web apps and the
 * PostgreSQL server, which is where almost all of the idle cost sits. The
 * "working late" button pushes tonight's shutdown back without touching the
 * recurring schedule, and expires on its own.
 *
 * Viewing is open to anyone who can see the dashboard; changing anything needs
 * `power:schedule`, and the server re-checks on every call.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Checkbox, DefaultButton, Dropdown, IDropdownOption, MessageBar, MessageBarType,
  PrimaryButton, Separator, Spinner, SpinnerSize, Stack, Text, Toggle,
} from '@fluentui/react';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';

interface PowerSchedule {
  enabled: boolean;
  autoShutdown: boolean;
  timeZone: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  days: number[];
  deferUntil: string | null;
  deferredBy: string | null;
  deferActive: boolean;
  maxDeferHours: number;
  withinHoursNow: boolean;
  desiredState: 'running' | 'stopped' | null;
  nextStartAt: string | null;
  nextStopAt: string | null;
  lastAction: 'started' | 'stopped' | null;
  lastActionAt: string | null;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const hourOptions: IDropdownOption[] = Array.from({ length: 24 }, (_, hour) => ({
  key: hour,
  text: `${String(hour).padStart(2, '0')}`,
}));

const minuteOptions: IDropdownOption[] = Array.from({ length: 12 }, (_, index) => ({
  key: index * 5,
  text: `${String(index * 5).padStart(2, '0')}`,
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

const extendOptions: IDropdownOption[] = [1, 2, 3, 4, 6, 8, 12].map((hours) => ({
  key: hours,
  text: hours === 1 ? '1 hour' : `${hours} hours`,
}));

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function PowerSchedulePage() {
  const api = useApi();
  const { has } = usePermissions();
  const canManage = has('power:schedule');

  const [saved, setSaved] = useState<PowerSchedule | null>(null);
  const [draft, setDraft] = useState<PowerSchedule | null>(null);
  const [extendHours, setExtendHours] = useState(2);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get<PowerSchedule>('/api/power-schedule');
      setSaved(response.data);
      setDraft(response.data);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not load the power schedule');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const patch = (values: Partial<PowerSchedule>) =>
    setDraft((current) => (current ? { ...current, ...values } : current));

  const toggleDay = (day: number, checked?: boolean) =>
    setDraft((current) => {
      if (!current) return current;
      const days = checked
        ? [...new Set([...current.days, day])].sort((a, b) => a - b)
        : current.days.filter((d) => d !== day);
      return { ...current, days };
    });

  const apply = (next: PowerSchedule, message: string) => {
    setSaved(next);
    setDraft(next);
    setNotice(message);
  };

  const fail = (err: any, fallback: string) =>
    setError(err?.response?.data?.error || err?.message || fallback);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.put<PowerSchedule>('/api/power-schedule', {
        enabled: draft.enabled,
        autoShutdown: draft.autoShutdown,
        timeZone: draft.timeZone,
        startHour: draft.startHour,
        startMinute: draft.startMinute,
        endHour: draft.endHour,
        endMinute: draft.endMinute,
        days: draft.days,
      });
      apply(
        response.data,
        response.data.enabled
          ? `Saved. Next shutdown: ${when(response.data.nextStopAt)}.`
          : 'Schedule saved and turned off — resources will be left alone.',
      );
    } catch (err: any) {
      fail(err, 'Could not save the power schedule');
    } finally {
      setBusy(false);
    }
  };

  const extend = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.post<PowerSchedule>('/api/power-schedule/extend', {
        hours: extendHours,
      });
      apply(response.data, `Shutdown delayed until ${when(response.data.deferUntil)}.`);
    } catch (err: any) {
      fail(err, 'Could not delay tonight\u2019s shutdown');
    } finally {
      setBusy(false);
    }
  };

  const cancelExtend = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.delete<PowerSchedule>('/api/power-schedule/extend');
      apply(response.data, `Delay cancelled. Next shutdown: ${when(response.data.nextStopAt)}.`);
    } catch (err: any) {
      fail(err, 'Could not cancel the delay');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading power schedule..." />;
  if (!draft || !saved) {
    return <MessageBar messageBarType={MessageBarType.error}>{error || 'No schedule available.'}</MessageBar>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <Stack tokens={{ childrenGap: 18 }} styles={{ root: { maxWidth: 820 } }}>
      <Stack tokens={{ childrenGap: 4 }}>
        <Text variant="xLarge" style={{ fontWeight: 700 }}>Business hours</Text>
        <Text style={{ color: '#605e5c' }}>
          Power the dashboard&apos;s web apps and database down outside working hours to cut idle
          cost. While they are stopped the site is unreachable until the next scheduled start.
        </Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {notice && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setNotice('')}>{notice}</MessageBar>}

      <MessageBar messageBarType={MessageBarType.info}>
        {saved.enabled
          ? `Currently ${saved.withinHoursNow ? 'inside' : 'outside'} working hours. `
            + `Next start ${when(saved.nextStartAt)} · next shutdown ${when(saved.nextStopAt)}.`
          : 'The schedule is off — resources stay on until you turn it on.'}
      </MessageBar>

      {saved.deferActive && (
        <MessageBar
          messageBarType={MessageBarType.warning}
          actions={canManage
            ? <DefaultButton text="Cancel delay" onClick={cancelExtend} disabled={busy} />
            : undefined}
        >
          Tonight&apos;s shutdown is delayed until {when(saved.deferUntil)}
          {saved.deferredBy ? ` by ${saved.deferredBy}` : ''}.
        </MessageBar>
      )}

      <Toggle
        label="Run on a schedule"
        checked={draft.enabled}
        onChange={(_e, checked) => patch({ enabled: !!checked })}
        onText="On"
        offText="Off"
        disabled={!canManage}
      />

      <Toggle
        label="Shut down outside working hours"
        checked={draft.autoShutdown}
        onChange={(_e, checked) => patch({ autoShutdown: !!checked })}
        onText="Shut down"
        offText="Leave running"
        disabled={!canManage || !draft.enabled}
      />

      <Stack tokens={{ childrenGap: 6 }}>
        <Text style={{ fontWeight: 600 }}>Days</Text>
        <Stack horizontal wrap tokens={{ childrenGap: 14 }}>
          {DAY_LABELS.map((label, day) => (
            <Checkbox
              key={label}
              label={label}
              checked={draft.days.includes(day)}
              onChange={(_e, checked) => toggleDay(day, checked)}
              disabled={!canManage || !draft.enabled}
            />
          ))}
        </Stack>
      </Stack>

      <Stack horizontal wrap tokens={{ childrenGap: 12 }} verticalAlign="end">
        <Dropdown
          label="Start at"
          selectedKey={draft.startHour}
          options={hourOptions}
          onChange={(_e, option) => patch({ startHour: Number(option!.key) })}
          disabled={!canManage || !draft.enabled}
          styles={{ root: { width: 90 } }}
        />
        <Dropdown
          ariaLabel="Start minute"
          selectedKey={draft.startMinute}
          options={minuteOptions}
          onChange={(_e, option) => patch({ startMinute: Number(option!.key) })}
          disabled={!canManage || !draft.enabled}
          styles={{ root: { width: 80 } }}
        />
        <Dropdown
          label="Stop at"
          selectedKey={draft.endHour}
          options={hourOptions}
          onChange={(_e, option) => patch({ endHour: Number(option!.key) })}
          disabled={!canManage || !draft.enabled}
          styles={{ root: { width: 90 } }}
        />
        <Dropdown
          ariaLabel="Stop minute"
          selectedKey={draft.endMinute}
          options={minuteOptions}
          onChange={(_e, option) => patch({ endMinute: Number(option!.key) })}
          disabled={!canManage || !draft.enabled}
          styles={{ root: { width: 80 } }}
        />
        <Dropdown
          label="Time zone"
          selectedKey={draft.timeZone}
          options={zoneOptions}
          onChange={(_e, option) => patch({ timeZone: String(option!.key) })}
          disabled={!canManage || !draft.enabled}
          styles={{ root: { width: 260 } }}
        />
      </Stack>

      <Stack horizontal tokens={{ childrenGap: 10 }}>
        <PrimaryButton text="Save schedule" onClick={save} disabled={!canManage || busy || !dirty} />
        <DefaultButton text="Reset" onClick={() => setDraft(saved)} disabled={busy || !dirty} />
      </Stack>

      <Separator />

      <Stack tokens={{ childrenGap: 8 }}>
        <Text variant="large" style={{ fontWeight: 600 }}>Working late tonight?</Text>
        <Text style={{ color: '#605e5c' }}>
          Delay just tonight&apos;s shutdown. The recurring schedule is untouched and the delay
          expires by itself, so nothing is left running by accident.
        </Text>
        <Stack horizontal wrap tokens={{ childrenGap: 10 }} verticalAlign="end">
          <Dropdown
            label="Delay by"
            selectedKey={extendHours}
            options={extendOptions.filter((o) => Number(o.key) <= saved.maxDeferHours)}
            onChange={(_e, option) => setExtendHours(Number(option!.key))}
            disabled={!canManage || busy}
            styles={{ root: { width: 160 } }}
          />
          <PrimaryButton
            text={saved.deferActive ? 'Delay further' : 'Delay shutdown'}
            iconProps={{ iconName: 'Clock' }}
            onClick={extend}
            disabled={!canManage || busy || !saved.enabled || !saved.autoShutdown}
          />
        </Stack>
        {saved.enabled && !saved.autoShutdown && (
          <Text style={{ color: '#605e5c' }}>
            Automatic shutdown is off, so there is nothing to delay.
          </Text>
        )}
      </Stack>

      {saved.lastActionAt && (
        <Text style={{ color: '#605e5c' }}>
          Last scheduler action: {saved.lastAction} at {when(saved.lastActionAt)}.
        </Text>
      )}

      {!canManage && (
        <MessageBar messageBarType={MessageBarType.info}>
          You can view the schedule but not change it. This needs the Administrator role.
        </MessageBar>
      )}
    </Stack>
  );
}
