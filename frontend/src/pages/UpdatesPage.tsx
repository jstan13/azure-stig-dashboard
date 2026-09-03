/**
 * Updates Page — decide how new releases reach this deployment.
 *
 * Two knobs matter: whether updates install by themselves at all, and whether
 * each one needs a human to sign off first. "Set and forget" is mode=auto with
 * approval off; "approve each one" is mode=auto with approval on.
 *
 * Viewing is open to anyone who can see the dashboard; changing anything needs
 * `updates:manage`, and the server re-checks on every call.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Stack, Text, MessageBar, MessageBarType, Spinner, SpinnerSize,
  PrimaryButton, DefaultButton, Dropdown, IDropdownOption, Toggle,
  ChoiceGroup, IChoiceGroupOption, DetailsList, IColumn, SelectionMode, Separator,
} from '@fluentui/react';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';

type UpdateMode = 'off' | 'notify' | 'auto';

interface UpdatePolicy {
  mode: UpdateMode;
  requireApproval: boolean;
  securityOnly: boolean;
  dayOfWeek: number | null;
  hour: number;
  timeZone: string;
}

interface HistoryEntry {
  version: string;
  previousVersion: string | null;
  finishedAt: string;
  result: 'succeeded' | 'rolled_back' | 'failed';
  detail?: string;
  actor?: string;
}

interface UpdateStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  availableNotes: string | null;
  updateAvailable: boolean;
  approvedVersion: string | null;
  approvedBy: string | null;
  applyNowVersion: string | null;
  lastCheckedAt: string | null;
  inWindowNow: boolean;
  nextAction: { action: string; reason: string; version?: string };
  policy: UpdatePolicy;
  history: HistoryEntry[];
}

const modeOptions: IChoiceGroupOption[] = [
  { key: 'off', text: 'Off — never check, never install' },
  { key: 'notify', text: 'Notify me — tell me when a release is out, but do nothing' },
  { key: 'auto', text: 'Install automatically during the maintenance window' },
];

const dayOptions: IDropdownOption[] = [
  { key: 'any', text: 'Any day' },
  { key: '0', text: 'Sunday' },
  { key: '1', text: 'Monday' },
  { key: '2', text: 'Tuesday' },
  { key: '3', text: 'Wednesday' },
  { key: '4', text: 'Thursday' },
  { key: '5', text: 'Friday' },
  { key: '6', text: 'Saturday' },
];

const hourOptions: IDropdownOption[] = Array.from({ length: 24 }, (_, h) => ({
  key: String(h),
  text: `${String(h).padStart(2, '0')}:00 – ${String(h).padStart(2, '0')}:59`,
}));

/** Browsers ship the IANA database; the fallback covers the older ones. */
function timeZoneOptions(): IDropdownOption[] {
  const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const zones = anyIntl.supportedValuesOf
    ? anyIntl.supportedValuesOf('timeZone')
    : ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
       'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London'];
  const list = zones.includes('UTC') ? zones : ['UTC', ...zones];
  return list.map((z) => ({ key: z, text: z.replace(/_/g, ' ') }));
}

const tzOptions = timeZoneOptions();

const resultLabel: Record<HistoryEntry['result'], string> = {
  succeeded: 'Installed',
  rolled_back: 'Rolled back',
  failed: 'Failed',
};

export default function UpdatesPage() {
  const api = useApi();
  const { has } = usePermissions();
  const canManage = has('updates:manage');
  const queuedVersion = useRef<string | null>(null);

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [draft, setDraft] = useState<UpdatePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      const res = await api.get<UpdateStatus>('/api/updates');
      if (queuedVersion.current
        && res.data.currentVersion === queuedVersion.current
        && !res.data.applyNowVersion) {
        window.location.reload();
        return;
      }
      setStatus(res.data);
      setDraft(res.data.policy);
      queuedVersion.current = res.data.applyNowVersion;
    } catch (e: any) {
      if (!quiet) {
        setError(e?.response?.data?.error || e?.message || 'Could not load update settings');
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!status?.applyNowVersion) return undefined;
    const interval = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(interval);
  }, [load, status?.applyNowVersion]);

  const patchDraft = (patch: Partial<UpdatePolicy>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put('/api/updates/policy', draft);
      setNotice('Update settings saved.');
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save update settings');
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (!status?.availableVersion) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.post('/api/updates/approve', { version: status.availableVersion });
      setNotice(`Approved ${status.availableVersion}. It will install at the next maintenance window.`);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not approve this release');
    } finally {
      setSaving(false);
    }
  };

  const applyNow = async () => {
    const version = status?.availableVersion ?? null;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ message: string }>('/api/updates/apply', {});
      queuedVersion.current = version;
      setNotice(res.data.message);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not start the update');
    } finally {
      setSaving(false);
    }
  };

  const historyColumns: IColumn[] = [
    {
      key: 'when', name: 'When', fieldName: 'finishedAt', minWidth: 160, maxWidth: 200,
      onRender: (i: HistoryEntry) => <span>{new Date(i.finishedAt).toLocaleString()}</span>,
    },
    { key: 'version', name: 'Version', fieldName: 'version', minWidth: 90, maxWidth: 120 },
    {
      key: 'from', name: 'From', minWidth: 90, maxWidth: 120,
      onRender: (i: HistoryEntry) => <span>{i.previousVersion ?? '—'}</span>,
    },
    {
      key: 'result', name: 'Result', minWidth: 110, maxWidth: 130,
      onRender: (i: HistoryEntry) => <span>{resultLabel[i.result]}</span>,
    },
    {
      key: 'detail', name: 'Details', minWidth: 240, isMultiline: true,
      onRender: (i: HistoryEntry) => <span>{i.detail ?? ''}</span>,
    },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading update settings…" />;

  return (
    <Stack tokens={{ childrenGap: 16 }} styles={{ root: { padding: 24, maxWidth: 900 } }}>
      <Text variant="xLarge">Updates</Text>
      <Text variant="medium">
        New releases are published as container images. Installing one swaps the image and
        restarts the app — your data stays in the database and is not touched. If the new
        version fails its health check, the previous version is put back automatically.
      </Text>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {notice && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setNotice('')}>{notice}</MessageBar>}

      {status && (
        <Stack tokens={{ childrenGap: 8 }}>
          <Text variant="large">Status</Text>
          <Text>Running: <strong>{status.currentVersion ?? 'unknown'}</strong></Text>
          <Text>
            Latest available: <strong>{status.availableVersion ?? 'not checked yet'}</strong>
            {status.lastCheckedAt && ` (checked ${new Date(status.lastCheckedAt).toLocaleString()})`}
          </Text>
          <Text>Next step: {status.nextAction.reason}</Text>
          {status.applyNowVersion ? (
            <MessageBar messageBarType={MessageBarType.info}>
              {status.applyNowVersion} is queued for immediate installation. The scheduler checks
              every 20 minutes.
            </MessageBar>
          ) : status.approvedVersion ? (
            <MessageBar messageBarType={MessageBarType.info}>
              {status.approvedVersion} is approved{status.approvedBy ? ` by ${status.approvedBy}` : ''} and
              will install at the next maintenance window.
            </MessageBar>
          ) : null}
          {status.updateAvailable && status.availableNotes && (
            <Stack tokens={{ childrenGap: 4 }}>
              <Text variant="mediumPlus">Release notes</Text>
              <Text styles={{ root: { whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' } }}>
                {status.availableNotes}
              </Text>
            </Stack>
          )}
          {canManage && (
            <Stack horizontal tokens={{ childrenGap: 8 }}>
              <PrimaryButton
                text={`Approve ${status.availableVersion ?? ''}`.trim()}
                disabled={saving || !status.updateAvailable || status.approvedVersion === status.availableVersion}
                onClick={approve}
              />
              <DefaultButton
                text="Update now"
                disabled={saving || !status.updateAvailable
                  || status.applyNowVersion === status.availableVersion}
                onClick={applyNow}
              />
              <DefaultButton text="Refresh" disabled={saving} onClick={() => void load()} />
            </Stack>
          )}
        </Stack>
      )}

      <Separator />

      {draft && (
        <Stack tokens={{ childrenGap: 12 }}>
          <Text variant="large">Schedule</Text>

          <ChoiceGroup
            label="When a new release comes out"
            selectedKey={draft.mode}
            options={modeOptions}
            disabled={!canManage}
            onChange={(_e, o) => o && patchDraft({ mode: o.key as UpdateMode })}
          />

          <Toggle
            label="Require an administrator to approve each release"
            checked={draft.requireApproval}
            disabled={!canManage || draft.mode !== 'auto'}
            onText="Approve each one"
            offText="Set and forget"
            onChange={(_e, checked) => patchDraft({ requireApproval: !!checked })}
          />
          <Text variant="small">
            {draft.requireApproval
              ? 'Nothing installs until someone approves it here. Approved releases still wait for the maintenance window.'
              : 'Releases install on their own during the maintenance window, with no sign-off.'}
          </Text>

          <Toggle
            label="Security releases only"
            checked={draft.securityOnly}
            disabled={!canManage || draft.mode === 'off'}
            onText="Security only"
            offText="All releases"
            onChange={(_e, checked) => patchDraft({ securityOnly: !!checked })}
          />

          <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
            <Dropdown
              label="Maintenance day"
              selectedKey={draft.dayOfWeek === null ? 'any' : String(draft.dayOfWeek)}
              options={dayOptions}
              disabled={!canManage || draft.mode !== 'auto'}
              styles={{ root: { minWidth: 180 } }}
              onChange={(_e, o) => o && patchDraft({
                dayOfWeek: o.key === 'any' ? null : Number(o.key),
              })}
            />
            <Dropdown
              label="Maintenance hour"
              selectedKey={String(draft.hour)}
              options={hourOptions}
              disabled={!canManage || draft.mode !== 'auto'}
              styles={{ root: { minWidth: 200 } }}
              onChange={(_e, o) => o && patchDraft({ hour: Number(o.key) })}
            />
            <Dropdown
              label="Time zone"
              selectedKey={draft.timeZone}
              options={tzOptions}
              disabled={!canManage || draft.mode !== 'auto'}
              styles={{ root: { minWidth: 260 } }}
              onChange={(_e, o) => o && patchDraft({ timeZone: String(o.key) })}
            />
          </Stack>
          <Text variant="small">
            Updates start within about 20 minutes of the hour you pick and usually finish in a
            few minutes. Expect a short outage while the app restarts.
          </Text>

          {canManage && (
            <Stack horizontal tokens={{ childrenGap: 8 }}>
              <PrimaryButton text="Save settings" disabled={saving} onClick={save} />
              <DefaultButton text="Discard changes" disabled={saving} onClick={() => setDraft(status?.policy ?? draft)} />
            </Stack>
          )}
          {!canManage && (
            <MessageBar messageBarType={MessageBarType.info}>
              You can see these settings but only an administrator can change them.
            </MessageBar>
          )}
        </Stack>
      )}

      <Separator />

      <Stack tokens={{ childrenGap: 8 }}>
        <Text variant="large">Update history</Text>
        {status && status.history.length > 0 ? (
          <DetailsList
            items={status.history}
            columns={historyColumns}
            selectionMode={SelectionMode.none}
            compact
          />
        ) : (
          <Text>No updates have been installed yet.</Text>
        )}
      </Stack>
    </Stack>
  );
}
