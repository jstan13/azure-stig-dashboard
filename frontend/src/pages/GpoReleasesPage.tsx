/**
 * GPO Releases — the human side of the DISA GPO lifecycle.
 *
 *   1. Review     a new DISA package (setting-level diff vs. what is live)
 *   2. Test       agent imports + links in the test domain, then validates
 *   3. Staged     test passed; GPOs imported (unlinked) in production
 *   4. Approve    second review of production deviations and test evidence
 *   5. Released   agent links GPOs in production; rollback stays available
 *
 * The UI only gates buttons; the API re-checks every permission.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stack, Text, MessageBar, MessageBarType, Spinner, SpinnerSize, PrimaryButton, DefaultButton,
  DetailsList, IColumn, SelectionMode, Pivot, PivotItem, Dialog, DialogType, DialogFooter, TextField,
  Panel, PanelType, Dropdown, IDropdownOption, ChoiceGroup, Icon, Separator, Link, TooltipHost, Checkbox,
} from '@fluentui/react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';

type ReleaseStatus =
  | 'awaiting_test_approval' | 'test_deploying' | 'test_validating' | 'staging_production'
  | 'awaiting_production_approval' | 'releasing' | 'released' | 'rolling_back' | 'rolled_back'
  | 'failed' | 'rejected' | 'superseded';

interface PackageGpo { backupId: string; displayName: string; family: string; settingCount: number }
interface FamilyChange { family: string; fromName: string; toName: string; added: string[]; removed: string[]; changed: string[] }
interface PackageDiff {
  previousLabel: string | null; addedGpos: string[]; removedGpos: string[];
  changedGpos: FamilyChange[]; unchangedGpos: string[];
}
interface DeployedGpo { id: string; name: string; family: string }
interface LinkRecord { target: string; gpoId: string; gpoName: string; order?: number | null; enabled?: boolean }
interface Deviation { gpoId: string; gpoName: string; added: string[]; removed: string[]; changed: string[] }
interface ValidationComputer {
  name: string; reachable: boolean; error?: string | null; appliedGpoIds: string[]; expectedGpoIds: string[];
  filteredGpoIds: string[]; extensionErrors: Array<{ name: string; code: string }>;
  script?: { passed: boolean; summary?: string | null } | null;
}
interface Customization {
  gpoFamily: string; kind: 'registry' | 'securityTemplate'; action: 'set' | 'delete';
  hive?: string | null; key?: string | null; valueName?: string | null; valueType?: string | null; value?: string | null;
  section?: string | null; settingKey?: string | null; settingValue?: string | null; sourceGpoName: string; baselineKnown: boolean;
}
interface UnsupportedChange { gpoFamily: string; gpoName: string; detail: string }
interface ProductionSurvey {
  surveyedAt: string; agent?: string;
  gpos: Array<{ gpoFamily: string; gpoId: string; gpoName: string; baseline: 'release' | 'package' | 'unknown'; baselineLabel?: string | null }>;
  customizations: Customization[]; unsupported: UnsupportedChange[];
}
interface EnvironmentState {
  agent?: string; gpos: DeployedGpo[]; links: LinkRecord[]; previousLinks: LinkRecord[];
  deviations: Deviation[]; validation?: { computers: ValidationComputer[]; collectedAt: string } | null;
  outcome?: { passed: boolean; reasons: string[]; evaluatedAt: string } | null;
  uncovered?: Customization[]; stale?: ExceptionSnapshot[]; dropped?: Customization[];
  unsupported?: UnsupportedChange[]; updatedAt: string;
}
interface ExceptionSnapshot {
  id: string; gpoFamily: string; kind: 'registry' | 'securityTemplate'; action: 'set' | 'delete';
  hive: string | null; key: string | null; valueName: string | null; valueType: string | null; value: string | null;
  section: string | null; settingKey: string | null; settingValue: string | null; justification: string; approvedBy: string | null;
  source?: 'manual' | 'detected';
}
interface Decision { action: string; actor: string; at: string; comment?: string | null }
interface Release {
  id: string; packageName: string; label: string; releaseDate: string | null; sourceHash: string; sizeBytes: number;
  status: ReleaseStatus; failedStage: string | null; gpos: PackageGpo[]; diff: PackageDiff | null;
  exceptionsSnapshot: ExceptionSnapshot[] | null; environments: { test?: EnvironmentState; production?: EnvironmentState };
  productionSurvey: ProductionSurvey | null;
  decisions: Decision[]; releasedAt: string | null; lastError: string | null; discoveredAt: string;
}
interface Job {
  id: string; environment: string; type: string; status: string; attempts: number; claimedBy: string | null;
  notBefore: string; completedAt: string | null; error: string | null;
}
interface GpoException extends ExceptionSnapshot {
  status: 'pending' | 'approved' | 'revoked'; reference: string | null; requestedBy: string;
  expiresAt: string | null; createdAt: string; detectedFrom: string | null; baselineKnown: boolean;
}
interface LifecycleStatus {
  enabled: boolean; discoveryMode: 'manual' | 'scheduled'; nextCheckAt: string | null; soakHours: number;
  distinctApprovers: boolean; carryForwardMode: 'auto' | 'review';
  agents: Array<{ environment: string; hostname: string | null; version: string | null; lastSeenAt: string }>;
}

const STATUS_TEXT: Record<ReleaseStatus, string> = {
  awaiting_test_approval: 'Awaiting review for test',
  test_deploying: 'Deploying to test',
  test_validating: 'Validating in test',
  staging_production: 'Staging in production',
  awaiting_production_approval: 'Awaiting production approval',
  releasing: 'Releasing to production',
  released: 'Live in production',
  rolling_back: 'Rolling back',
  rolled_back: 'Rolled back',
  failed: 'Failed',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

const STATUS_COLOR: Partial<Record<ReleaseStatus, string>> = {
  awaiting_test_approval: '#8a6d00', awaiting_production_approval: '#8a6d00',
  released: '#107c10', failed: '#a4262c', rolled_back: '#a4262c', rejected: '#605e5c', superseded: '#605e5c',
};

const STEPS: Array<{ label: string; statuses: ReleaseStatus[]; failedStages: string[] }> = [
  { label: 'Review', statuses: ['awaiting_test_approval'], failedStages: [] },
  { label: 'Test deploy', statuses: ['test_deploying'], failedStages: ['test_deploy'] },
  { label: 'Test validation', statuses: ['test_validating'], failedStages: ['test_validation'] },
  { label: 'Production staging', statuses: ['staging_production'], failedStages: ['production_stage'] },
  { label: 'Production approval', statuses: ['awaiting_production_approval'], failedStages: [] },
  { label: 'Release', statuses: ['releasing', 'released', 'rolling_back', 'rolled_back'], failedStages: ['production_release', 'rollback'] },
];

const LIST_STYLE = { margin: 0, paddingLeft: 20 };

const ACTIVE: ReleaseStatus[] = ['test_deploying', 'test_validating', 'staging_production', 'releasing', 'rolling_back'];

const errorText = (e: any, fallback: string) => e?.response?.data?.error || e?.message || fallback;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

function StatusBadge({ status }: { status: ReleaseStatus }) {
  return (
    <span style={{
      background: STATUS_COLOR[status] ?? '#0078d4', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 12,
    }}>
      {STATUS_TEXT[status]}
    </span>
  );
}

function Stepper({ release }: { release: Release }) {
  const current = STEPS.findIndex((s) => s.statuses.includes(release.status)
    || (release.status === 'failed' && s.failedStages.includes(release.failedStage ?? '')));
  return (
    <Stack horizontal wrap tokens={{ childrenGap: 8 }} verticalAlign="center">
      {STEPS.map((step, i) => {
        const failed = release.status === 'failed' && i === current;
        const done = release.status === 'released' ? true : current > i;
        const active = i === current && !failed && release.status !== 'released';
        const color = failed ? '#a4262c' : done ? '#107c10' : active ? '#0078d4' : '#a19f9d';
        const icon = failed ? 'StatusErrorFull' : done ? 'CompletedSolid' : active ? 'CircleShapeSolid' : 'CircleRing';
        return (
          <Stack key={step.label} horizontal verticalAlign="center" tokens={{ childrenGap: 6 }}>
            <Icon iconName={icon} style={{ color }} />
            <Text style={{ color, fontWeight: active || failed ? 600 : 400 }}>{step.label}</Text>
            {i < STEPS.length - 1 && <Icon iconName="ChevronRight" style={{ color: '#a19f9d', fontSize: 10 }} />}
          </Stack>
        );
      })}
    </Stack>
  );
}

function KeyList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <details>
      <summary>{title} ({items.length})</summary>
      <ul style={{ margin: '4px 0', fontFamily: 'Consolas, monospace', fontSize: 12 }}>
        {items.map((k) => <li key={k}>{k}</li>)}
      </ul>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack tokens={{ childrenGap: 8 }} style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 4, padding: 16 }}>
      <Text variant="large" style={{ fontWeight: 600 }}>{title}</Text>
      {children}
    </Stack>
  );
}

function describeException(e: ExceptionSnapshot): string {
  if (e.kind === 'registry') {
    const target = `${e.hive}\\${e.key}\\${e.valueName}`;
    return e.action === 'delete' ? `Remove ${target}` : `${target} = ${e.value} (${e.valueType})`;
  }
  return e.action === 'delete'
    ? `Remove [${e.section}] ${e.settingKey}`
    : `[${e.section}] ${e.settingKey} = ${e.settingValue}`;
}

function DeviationList({ deviations }: { deviations: Deviation[] }) {
  if (!deviations.length) return <Text>No settings reports uploaded.</Text>;
  return (
    <Stack tokens={{ childrenGap: 6 }}>
      {deviations.map((d) => {
        const total = d.added.length + d.removed.length + d.changed.length;
        return (
          <Stack key={d.gpoId} tokens={{ childrenGap: 2 }}>
            <Text>
              <Icon iconName={total ? 'Warning' : 'CheckMark'} style={{ color: total ? '#8a6d00' : '#107c10', marginRight: 6 }} />
              <strong>{d.gpoName}</strong>: {total ? `${total} difference(s) from the DISA baseline` : 'identical to the DISA baseline'}
            </Text>
            <KeyList title="Added" items={d.added} />
            <KeyList title="Removed" items={d.removed} />
            <KeyList title="Changed" items={d.changed} />
          </Stack>
        );
      })}
    </Stack>
  );
}

function describeCustomization(c: Customization): string {
  return describeException({
    id: '', gpoFamily: c.gpoFamily, kind: c.kind, action: c.action, hive: c.hive ?? null, key: c.key ?? null,
    valueName: c.valueName ?? null, valueType: c.valueType ?? null, value: c.value ?? null, section: c.section ?? null,
    settingKey: c.settingKey ?? null, settingValue: c.settingValue ?? null, justification: '', approvedBy: null,
  });
}

function SurveySection({ release, jobs, canApprove, busy, onResurvey }: {
  release: Release; jobs: Job[]; canApprove: boolean; busy: boolean; onResurvey: () => void;
}) {
  const survey = release.productionSurvey;
  const pending = jobs.filter((j) => j.type === 'survey' && (j.status === 'queued' || j.status === 'claimed'));
  const failed = [...jobs].reverse().find((j) => j.type === 'survey');
  const canResurvey = canApprove && !pending.length
    && ['awaiting_test_approval', 'test_deploying', 'test_validating', 'staging_production', 'awaiting_production_approval', 'failed'].includes(release.status);
  return (
    <Section title="Customizations in today's production GPOs">
      <Text style={{ color: '#605e5c' }}>
        The production agent compares each live production GPO with the DISA release it came from. What your team changed is
        carried into this release as exceptions, so test and production get the same settings.
      </Text>
      {pending.length > 0 && <MessageBar>Survey {pending[0].status === 'claimed' ? 'running' : 'waiting for the production agent'}…</MessageBar>}
      {!survey && !pending.length && failed?.status === 'failed' && (
        <MessageBar messageBarType={MessageBarType.error}>The last survey failed: {failed.error}</MessageBar>
      )}
      {survey && (
        <>
          <Text>Surveyed {when(survey.surveyedAt)}{survey.agent ? ` by ${survey.agent}` : ''}</Text>
          {survey.gpos.length === 0
            ? <Text>No live production GPOs were found for the families this agent manages; nothing to carry forward.</Text>
            : (
              <ul style={LIST_STYLE}>
                {survey.gpos.map((g) => (
                  <li key={g.gpoId}>
                    <strong>{g.gpoName}</strong> — compared with {g.baseline === 'unknown'
                      ? <span style={{ color: '#8a6d00' }}>the new DISA GPO (original DISA release unknown; differences need review)</span>
                      : `DISA ${g.baselineLabel}`}
                  </li>
                ))}
              </ul>
            )}
          {survey.customizations.length > 0 && (
            <details open={survey.customizations.length <= 10}>
              <summary>{survey.customizations.length} customization(s) carried forward</summary>
              <ul style={{ ...LIST_STYLE, fontFamily: 'Consolas, monospace', fontSize: 12 }}>
                {survey.customizations.map((c, i) => (
                  <li key={i}>{c.gpoFamily}: {describeCustomization(c)}{c.baselineKnown ? '' : ' (needs review)'}</li>
                ))}
              </ul>
            </details>
          )}
          {survey.unsupported.length > 0 && (
            <MessageBar messageBarType={MessageBarType.warning}>
              {survey.unsupported.length} difference(s) cannot be carried forward automatically and must be re-applied by hand after release:
              <ul style={LIST_STYLE}>{survey.unsupported.map((u, i) => <li key={i}>{u.gpoName}: {u.detail}</li>)}</ul>
            </MessageBar>
          )}
        </>
      )}
      {canResurvey && (
        <DefaultButton text="Survey production again" iconProps={{ iconName: 'Refresh' }} disabled={busy} onClick={onResurvey}
          styles={{ root: { alignSelf: 'flex-start' } }} />
      )}
    </Section>
  );
}

function EnvironmentSection({ title, env, release }: { title: string; env?: EnvironmentState; release: Release }) {
  if (!env) return null;
  const staged = env.links.length > 0 && env.links.every((l) => l.enabled === false);
  const nameOf = (id: string) => env.gpos.find((g) => g.id.replace(/[{}]/g, '').toLowerCase() === id.replace(/[{}]/g, '').toLowerCase())?.name ?? id;
  const computerColumns: IColumn[] = [
    { key: 'name', name: 'Computer', fieldName: 'name', minWidth: 110, maxWidth: 160 },
    {
      key: 'result', name: 'Result', minWidth: 300, isMultiline: true,
      onRender: (c: ValidationComputer) => {
        if (!c.reachable) return <Text style={{ color: '#a4262c' }}>Unreachable: {c.error}</Text>;
        const applied = new Set(c.appliedGpoIds.map((id) => id.replace(/[{}]/g, '').toLowerCase()));
        const missing = c.expectedGpoIds.filter((id) => !applied.has(id.replace(/[{}]/g, '').toLowerCase())
          && !c.filteredGpoIds.some((f) => f.replace(/[{}]/g, '').toLowerCase() === id.replace(/[{}]/g, '').toLowerCase()));
        return (
          <Stack>
            <Text>{c.expectedGpoIds.length - missing.length}/{c.expectedGpoIds.length} linked GPOs applied</Text>
            {missing.length > 0 && <Text style={{ color: '#a4262c' }}>Missing: {missing.map(nameOf).join(', ')}</Text>}
            {c.extensionErrors.length > 0 && (
              <Text style={{ color: '#a4262c' }}>Extension errors: {c.extensionErrors.map((e) => `${e.name} (${e.code})`).join(', ')}</Text>
            )}
            {c.script && <Text style={{ color: c.script.passed ? '#107c10' : '#a4262c' }}>Scan: {c.script.passed ? 'passed' : 'failed'}{c.script.summary ? ` — ${c.script.summary}` : ''}</Text>}
          </Stack>
        );
      },
    },
  ];
  return (
    <Section title={title}>
      <Text>Agent: {env.agent ?? 'unknown'} · updated {when(env.updatedAt)}</Text>
      <Text style={{ fontWeight: 600 }}>GPOs ({env.gpos.length})</Text>
      <ul style={LIST_STYLE}>{env.gpos.map((g) => <li key={g.id}>{g.name}</li>)}</ul>
      {env.links.length > 0 && (
        <>
          <Text style={{ fontWeight: 600 }}>{staged ? 'Links (disabled — staged next to the live GPOs for comparison in GPMC)' : 'Links'}</Text>
          <ul style={LIST_STYLE}>
            {env.links.map((l) => (
              <li key={`${l.target}${l.gpoId}`}>
                {l.gpoName} → {l.target}{l.enabled === false && !staged ? ' (disabled)' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {(env.uncovered?.length ?? 0) > 0 && (
        <MessageBar messageBarType={MessageBarType.severeWarning}>
          Production changed after this release was reviewed. These customizations are not in the staged GPOs and would be lost.
          Approve or revoke their exceptions, then restart the release so it is tested as production will receive it:
          <ul style={LIST_STYLE}>{env.uncovered!.map((c, i) => <li key={i}>{c.sourceGpoName}: {describeCustomization(c)}</li>)}</ul>
        </MessageBar>
      )}
      {(env.stale?.length ?? 0) > 0 && (
        <MessageBar messageBarType={MessageBarType.severeWarning}>
          These customizations were carried into this release from production, but production no longer has them, so releasing would
          re-apply them. Restart the release to drop them:
          <ul style={LIST_STYLE}>{env.stale!.map((e) => <li key={e.id}>{e.gpoFamily}: {describeException(e)}</li>)}</ul>
        </MessageBar>
      )}
      {(env.dropped?.length ?? 0) > 0 && (
        <MessageBar messageBarType={MessageBarType.info}>
          These production customizations are intentionally not carried forward because their exception was revoked or expired:
          <ul style={LIST_STYLE}>{env.dropped!.map((c, i) => <li key={i}>{c.sourceGpoName}: {describeCustomization(c)}</li>)}</ul>
        </MessageBar>
      )}
      {(env.unsupported?.length ?? 0) > 0 && (
        <MessageBar messageBarType={MessageBarType.warning}>
          {env.unsupported!.length} production difference(s) cannot be carried forward automatically:
          <ul style={LIST_STYLE}>{env.unsupported!.map((u, i) => <li key={i}>{u.gpoName}: {u.detail}</li>)}</ul>
        </MessageBar>
      )}
      {env.previousLinks.length > 0 && (
        <>
          <Text style={{ fontWeight: 600 }}>Replaced links (restored on rollback)</Text>
          <ul style={LIST_STYLE}>{env.previousLinks.map((l) => <li key={`${l.target}${l.gpoId}`}>{l.gpoName} on {l.target}</li>)}</ul>
        </>
      )}
      <Text style={{ fontWeight: 600 }}>As deployed vs. DISA baseline</Text>
      <DeviationList deviations={env.deviations} />
      {(release.exceptionsSnapshot?.length ?? 0) > 0 && env.deviations.some((d) => d.added.length + d.removed.length + d.changed.length) && (
        <Text style={{ color: '#605e5c' }}>
          Differences should correspond to the frozen exceptions above. Settings shown as differences can also come
          from ADMX templates missing on the agent host.
        </Text>
      )}
      {env.outcome && (
        <MessageBar messageBarType={env.outcome.passed ? MessageBarType.success : MessageBarType.error}>
          {env.outcome.passed ? `Validation passed (${when(env.outcome.evaluatedAt)})` : `Validation failed: ${env.outcome.reasons.join('; ')}`}
        </MessageBar>
      )}
      {env.validation && (
        <DetailsList items={env.validation.computers} columns={computerColumns} selectionMode={SelectionMode.none} compact />
      )}
    </Section>
  );
}

export default function GpoReleasesPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { has } = usePermissions();
  const canApprove = has('gpo:approve');
  const canWriteException = has('exception:write');
  const canApproveException = has('exception:approve');

  const [status, setStatus] = useState<LifecycleStatus | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ release: Release; jobs: Job[] } | null>(null);
  const [exceptions, setExceptions] = useState<GpoException[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [comment, setComment] = useState('');
  const [reasonAction, setReasonAction] = useState<'reject' | 'rollback' | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reason, setReason] = useState('');
  const [exceptionPanel, setExceptionPanel] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [s, r, e] = await Promise.all([
        api.get<LifecycleStatus>('/api/gpo/status'),
        api.get<{ data: Release[] }>('/api/gpo/releases'),
        api.get<{ data: GpoException[] }>('/api/gpo/exceptions'),
      ]);
      setStatus(s.data);
      setReleases(r.data.data);
      setExceptions(e.data.data);
      setSelectedId((current) => current ?? r.data.data.find((x) => !['superseded', 'rejected'].includes(x.status))?.id ?? r.data.data[0]?.id ?? null);
      if (!quiet) setError('');
    } catch (e) {
      if (!quiet) setError(errorText(e, 'Could not load GPO releases'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await api.get<{ release: Release; jobs: Job[] }>(`/api/gpo/releases/${id}`);
      setDetail(res.data);
    } catch (e) {
      setError(errorText(e, 'Could not load release detail'));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setAcknowledge(false); }, [selectedId]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const inFlight = releases.some((r) => ACTIVE.includes(r.status)
    || (r.status === 'awaiting_test_approval' && !r.productionSurvey));
  useEffect(() => {
    if (!inFlight) return undefined;
    const t = window.setInterval(() => {
      void load(true);
      if (selectedId) void loadDetail(selectedId);
    }, 30_000);
    return () => window.clearInterval(t);
  }, [inFlight, load, loadDetail, selectedId]);

  const act = async (path: string, body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post(path, body);
      setNotice(success);
      setComment('');
      await load(true);
      if (selectedId) await loadDetail(selectedId);
    } catch (e) {
      setError(errorText(e, 'The action failed'));
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ outcome: string; release: { id: string; label: string } | null }>('/api/gpo/check', {});
      setNotice(res.data.outcome === 'new'
        ? `DISA package ${res.data.release?.label} downloaded and staged for review.`
        : res.data.outcome === 'unchanged' ? 'No new DISA GPO package since the last check.' : 'DISA lists no GPO package.');
      if (res.data.release) setSelectedId(res.data.release.id);
      await load(true);
    } catch (e) {
      setError(errorText(e, 'Could not check DISA'));
    } finally {
      setBusy(false);
    }
  };

  const release = detail?.release.id === selectedId ? detail.release : null;
  const jobs = detail?.release.id === selectedId ? detail.jobs : [];

  const releaseColumns: IColumn[] = [
    {
      key: 'label', name: 'Package', minWidth: 160, maxWidth: 220,
      onRender: (r: Release) => <Link onClick={() => setSelectedId(r.id)} style={{ fontWeight: r.id === selectedId ? 700 : 400 }}>{r.label}</Link>,
    },
    { key: 'status', name: 'Stage', minWidth: 190, onRender: (r: Release) => <StatusBadge status={r.status} /> },
    {
      key: 'changes', name: 'Changes', minWidth: 220,
      onRender: (r: Release) => r.diff
        ? <Text>{r.diff.changedGpos.length} changed · {r.diff.addedGpos.length} new · {r.diff.removedGpos.length} removed</Text>
        : <Text>—</Text>,
    },
    { key: 'gpos', name: 'GPOs', minWidth: 50, maxWidth: 60, onRender: (r: Release) => <Text>{r.gpos.length}</Text> },
    { key: 'found', name: 'Discovered', minWidth: 150, onRender: (r: Release) => <Text>{when(r.discoveredAt)}</Text> },
  ];

  const jobColumns: IColumn[] = [
    { key: 'type', name: 'Job', minWidth: 120, onRender: (j: Job) => <Text>{j.environment} · {j.type}</Text> },
    { key: 'status', name: 'Status', fieldName: 'status', minWidth: 80 },
    { key: 'attempts', name: 'Attempts', fieldName: 'attempts', minWidth: 60, maxWidth: 70 },
    { key: 'agent', name: 'Agent', minWidth: 140, onRender: (j: Job) => <Text>{j.claimedBy ?? '—'}</Text> },
    { key: 'after', name: 'Not before', minWidth: 140, onRender: (j: Job) => <Text>{when(j.notBefore)}</Text> },
    { key: 'done', name: 'Completed', minWidth: 140, onRender: (j: Job) => <Text>{when(j.completedAt)}</Text> },
    { key: 'error', name: 'Error', minWidth: 200, isMultiline: true, onRender: (j: Job) => <Text style={{ color: '#a4262c' }}>{j.error ?? ''}</Text> },
  ];

  const exceptionColumns: IColumn[] = [
    { key: 'family', name: 'GPO', fieldName: 'gpoFamily', minWidth: 200, isMultiline: true },
    {
      key: 'source', name: 'Source', minWidth: 150, isMultiline: true,
      onRender: (e: GpoException) => e.source === 'detected'
        ? (
          <Stack>
            <Text>Found in production</Text>
            <Text style={{ color: e.baselineKnown ? '#605e5c' : '#8a6d00', fontSize: 12 }}>
              {e.detectedFrom}{e.baselineKnown ? '' : ' — original DISA release unknown'}
            </Text>
          </Stack>
        )
        : <Text>Requested</Text>,
    },
    { key: 'what', name: 'Override', minWidth: 260, isMultiline: true, onRender: (e: GpoException) => <Text style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{describeException(e)}</Text> },
    { key: 'why', name: 'Justification', fieldName: 'justification', minWidth: 200, isMultiline: true },
    {
      key: 'status', name: 'Status', minWidth: 160,
      onRender: (e: GpoException) => (
        <Stack>
          <Text>{e.status}{e.expiresAt ? ` · expires ${new Date(e.expiresAt).toLocaleDateString()}` : ''}</Text>
          <Text style={{ color: '#605e5c', fontSize: 12 }}>by {e.requestedBy}{e.approvedBy ? `, approved by ${e.approvedBy}` : ''}</Text>
        </Stack>
      ),
    },
    {
      key: 'actions', name: '', minWidth: 160,
      onRender: (e: GpoException) => canApproveException && e.status !== 'revoked' ? (
        <Stack horizontal tokens={{ childrenGap: 6 }}>
          {e.status === 'pending' && (
            <DefaultButton text="Approve" disabled={busy} onClick={() => void act(`/api/gpo/exceptions/${e.id}/approve`, {}, 'Exception approved. It applies to the next release approved for test.')} />
          )}
          <DefaultButton text="Revoke" disabled={busy} onClick={() => void act(`/api/gpo/exceptions/${e.id}/revoke`, {}, 'Exception revoked.')} />
        </Stack>
      ) : null,
    },
  ];

  const families = useMemo(() => {
    const latest = releases[0];
    return latest ? [...new Set(latest.gpos.map((g) => g.family))].sort() : [];
  }, [releases]);

  const agentLine = (env: string) => {
    const a = status?.agents.find((x) => x.environment === env);
    if (!a) return 'never connected';
    const minutes = Math.round((Date.now() - new Date(a.lastSeenAt).getTime()) / 60_000);
    return `${a.hostname ?? 'unknown host'} · v${a.version ?? '?'} · seen ${minutes < 1 ? 'just now' : `${minutes} min ago`}`;
  };

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading GPO releases…" />;

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap>
        <Stack>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>GPO Releases</Text>
          <Text style={{ color: '#605e5c' }}>
            DISA GPO packages move through review → test → production staging → approval → release. Agents in each domain do the work;
            nothing reaches production without passing test and a second approval.
          </Text>
        </Stack>
        {canApprove && <PrimaryButton text="Check DISA now" iconProps={{ iconName: 'Refresh' }} disabled={busy} onClick={() => void checkNow()} />}
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {notice && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setNotice('')}>{notice}</MessageBar>}
      {status && (
        <MessageBar messageBarType={MessageBarType.info}>
          {status.discoveryMode === 'scheduled'
            ? <>DISA is checked automatically{status.nextCheckAt ? `; next check ${when(status.nextCheckAt)}` : ''}. </>
            : <>DISA is checked only when you click <strong>Check DISA now</strong>. </>}
          <Link onClick={() => navigate('/settings/gpo')}>Change in Settings</Link>
        </MessageBar>
      )}

      <Stack horizontal wrap tokens={{ childrenGap: 24 }}>
        <Text><strong>Test agent:</strong> {agentLine('test')}</Text>
        <Text><strong>Production agent:</strong> {agentLine('production')}</Text>
        <Text><strong>Test soak:</strong> {status?.soakHours ?? 24} h</Text>
        <Text><strong>Production customizations:</strong> {status?.carryForwardMode === 'review' ? 'held for approval' : 'carried forward automatically'}</Text>
      </Stack>

      <Pivot>
        <PivotItem headerText="Releases">
          <Stack tokens={{ childrenGap: 16 }} style={{ paddingTop: 12 }}>
            {releases.length === 0
              ? <MessageBar>No DISA GPO packages have been discovered yet.</MessageBar>
              : <DetailsList items={releases} columns={releaseColumns} selectionMode={SelectionMode.none} compact />}

            {release && (
              <Stack tokens={{ childrenGap: 16 }}>
                <Separator />
                <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap>
                  <Text variant="xLarge" style={{ fontWeight: 600 }}>{release.packageName}</Text>
                  <StatusBadge status={release.status} />
                </Stack>
                <Stepper release={release} />
                {release.lastError && (
                  <MessageBar messageBarType={MessageBarType.error}>{release.lastError}</MessageBar>
                )}

                {canApprove && ['awaiting_test_approval', 'awaiting_production_approval', 'failed', 'released'].includes(release.status) && (() => {
                  const prod = release.environments.production;
                  const partial = release.status === 'failed' && release.failedStage === 'production_release'
                    && (!!prod?.links.some((l) => l.enabled !== false) || (prod?.previousLinks.length ?? 0) > 0);
                  const uncovered = (prod?.uncovered?.length ?? 0) + (prod?.stale?.length ?? 0);
                  const unsupported = prod?.unsupported?.length ?? 0;
                  const surveyPending = jobs.some((j) => j.type === 'survey' && (j.status === 'queued' || j.status === 'claimed'));
                  const pendingDetected = exceptions.filter((e) => e.status === 'pending' && e.source === 'detected'
                    && release.gpos.some((g) => g.family === e.gpoFamily)).length;
                  const canRestart = (release.status === 'awaiting_production_approval' || release.status === 'failed') && !partial;
                  return (
                  <Section title="Decision">
                    {release.status === 'awaiting_test_approval' && (
                      <>
                        <Text>Approving deploys these GPOs to the test environment with every approved exception frozen in, including customizations carried forward from production.</Text>
                        {surveyPending && (
                          <MessageBar messageBarType={MessageBarType.warning}>
                            The production survey has not finished. If you approve now, customizations it finds later will block the production approval and require a restart.
                          </MessageBar>
                        )}
                        {pendingDetected > 0 && (
                          <MessageBar messageBarType={MessageBarType.warning}>
                            {pendingDetected} customization(s) found in production are waiting for approval on the Exceptions tab. Unapproved ones are not included in this release.
                          </MessageBar>
                        )}
                      </>
                    )}
                    {release.status === 'awaiting_production_approval' && (
                      <Text>
                        Testing passed. The GPOs are imported in production and linked with the links <strong>disabled</strong>, directly above the live GPOs they replace,
                        so you can compare them in GPMC. Approving enables the new links and removes the old ones.
                      </Text>
                    )}
                    {release.status === 'released' && (
                      <Text>Rolling back unlinks this release and restores the links it replaced.</Text>
                    )}
                    {partial && (
                      <MessageBar messageBarType={MessageBarType.severeWarning}>
                        The production release failed after changing some links that the agent could not revert. Retry it, or roll back to restore the previous links.
                      </MessageBar>
                    )}
                    {release.status === 'awaiting_production_approval' && unsupported > 0 && (
                      <Checkbox
                        label={`I understand ${unsupported} production difference(s) listed below will not be in the new GPOs and must be re-applied by hand`}
                        checked={acknowledge}
                        onChange={(_, c) => setAcknowledge(!!c)}
                      />
                    )}
                    {release.status !== 'released' && (
                      <TextField label="Comment (recorded in the audit log)" value={comment} onChange={(_, v) => setComment(v ?? '')} multiline rows={2} />
                    )}
                    <Stack horizontal wrap tokens={{ childrenGap: 8 }}>
                      {release.status === 'awaiting_test_approval' && (
                        <PrimaryButton text="Approve for test" disabled={busy}
                          onClick={() => void act(`/api/gpo/releases/${release.id}/approve-test`, { comment: comment || undefined }, 'Approved. The test agent will deploy it on its next poll.')} />
                      )}
                      {release.status === 'awaiting_production_approval' && (
                        <PrimaryButton text="Approve production release" disabled={busy || uncovered > 0 || (unsupported > 0 && !acknowledge)}
                          onClick={() => void act(`/api/gpo/releases/${release.id}/approve-production`,
                            { comment: comment || undefined, acknowledgeUnsupported: acknowledge },
                            'Approved. The production agent will enable the new links on its next poll.')} />
                      )}
                      {release.status === 'failed' && (
                        <PrimaryButton text={`Retry ${release.failedStage?.replace(/_/g, ' ') ?? ''}`} disabled={busy}
                          onClick={() => void act(`/api/gpo/releases/${release.id}/retry`, { comment: comment || undefined }, 'Retry queued.')} />
                      )}
                      {canRestart && (
                        <DefaultButton text="Restart from review" iconProps={{ iconName: 'Rerun' }} disabled={busy}
                          onClick={() => void act(`/api/gpo/releases/${release.id}/restart`, { comment: comment || undefined },
                            'Release sent back to review. Production is being surveyed again; approve it for test when ready.')} />
                      )}
                      {(release.status === 'released' || partial) && (
                        <DefaultButton text="Roll back" iconProps={{ iconName: 'Undo' }} disabled={busy} onClick={() => { setReason(''); setReasonAction('rollback'); }} />
                      )}
                      {release.status !== 'released' && !partial && (
                        <DefaultButton text="Reject" disabled={busy} onClick={() => { setReason(''); setReasonAction('reject'); }} />
                      )}
                    </Stack>
                  </Section>
                  );
                })()}

                <Section title="Package">
                  <Text>Published by DISA {release.releaseDate ? new Date(release.releaseDate).toLocaleDateString() : '—'} · {(release.sizeBytes / 1024 / 1024).toFixed(1)} MB · {release.gpos.length} GPOs</Text>
                  <TooltipHost content="Every environment deploys only an archive with exactly this hash">
                    <Text style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>SHA-256 {release.sourceHash}</Text>
                  </TooltipHost>
                </Section>

                {release.diff && (
                  <Section title={release.diff.previousLabel ? `Changes since ${release.diff.previousLabel}` : 'Contents (no released baseline to compare)'}>
                    {release.diff.changedGpos.map((c) => (
                      <Stack key={c.family} tokens={{ childrenGap: 2 }}>
                        <Text><strong>{c.toName}</strong> (was {c.fromName}): {c.added.length} added, {c.removed.length} removed, {c.changed.length} changed settings</Text>
                        <KeyList title="Added settings" items={c.added} />
                        <KeyList title="Removed settings" items={c.removed} />
                        <KeyList title="Changed settings" items={c.changed} />
                      </Stack>
                    ))}
                    <KeyList title="New GPOs" items={release.diff.addedGpos} />
                    <KeyList title="Removed GPOs" items={release.diff.removedGpos} />
                    <KeyList title="Unchanged GPOs" items={release.diff.unchangedGpos} />
                  </Section>
                )}

                {release.exceptionsSnapshot && (
                  <Section title={`Exceptions frozen into this release (${release.exceptionsSnapshot.length})`}>
                    {release.exceptionsSnapshot.length === 0
                      ? <Text>None — GPOs are deployed exactly as DISA published them.</Text>
                      : (
                        <ul style={LIST_STYLE}>
                          {release.exceptionsSnapshot.map((e) => (
                            <li key={e.id}><strong>{e.gpoFamily}</strong>: <code>{describeException(e)}</code> — {e.justification}</li>
                          ))}
                        </ul>
                      )}
                  </Section>
                )}

                <SurveySection release={release} jobs={jobs} canApprove={canApprove} busy={busy}
                  onResurvey={() => void act(`/api/gpo/releases/${release.id}/survey`, {}, 'Production survey queued for the production agent.')} />
                <EnvironmentSection title="Test environment" env={release.environments.test} release={release} />
                <EnvironmentSection title="Production environment" env={release.environments.production} release={release} />

                <Section title="History">
                  <ul style={LIST_STYLE}>
                    {release.decisions.map((d, i) => (
                      <li key={i}>{when(d.at)} — <strong>{d.action.replace(/[_:]/g, ' ')}</strong> by {d.actor}{d.comment ? `: ${d.comment}` : ''}</li>
                    ))}
                  </ul>
                  {jobs.length > 0 && <DetailsList items={jobs} columns={jobColumns} selectionMode={SelectionMode.none} compact />}
                </Section>
              </Stack>
            )}
          </Stack>
        </PivotItem>

        <PivotItem headerText={`Exceptions (${exceptions.filter((e) => e.status !== 'revoked').length})`}>
          <Stack tokens={{ childrenGap: 12 }} style={{ paddingTop: 12 }}>
            <Text style={{ color: '#605e5c' }}>
              Exceptions override a DISA setting in every future release of the same GPO. DISA ships "ADD YOUR …" placeholders in
              Windows user-rights settings; agents refuse to import those GPOs until a security template exception supplies your accounts.
              Approved exceptions are frozen into a release when it is approved for test.
            </Text>
            {canWriteException && (
              <PrimaryButton text="New exception" iconProps={{ iconName: 'Add' }} style={{ alignSelf: 'flex-start' }} onClick={() => setExceptionPanel(true)} />
            )}
            <DetailsList items={exceptions} columns={exceptionColumns} selectionMode={SelectionMode.none} />
          </Stack>
        </PivotItem>
      </Pivot>

      <Dialog
        hidden={!reasonAction}
        onDismiss={() => setReasonAction(null)}
        dialogContentProps={{
          type: DialogType.normal,
          title: reasonAction === 'rollback' ? 'Roll back production' : 'Reject release',
          subText: reasonAction === 'rollback'
            ? 'The production agent will unlink this release and restore the GPO links it replaced.'
            : 'The release stops here. GPOs already imported stay in the domain, unlinked in production.',
        }}
      >
        <TextField label="Reason" required multiline rows={3} value={reason} onChange={(_, v) => setReason(v ?? '')} />
        <DialogFooter>
          <PrimaryButton
            text={reasonAction === 'rollback' ? 'Roll back' : 'Reject'}
            disabled={busy || reason.trim().length < 5 || !release}
            onClick={() => {
              const action = reasonAction;
              setReasonAction(null);
              if (release && action) {
                void act(`/api/gpo/releases/${release.id}/${action}`, { reason }, action === 'rollback' ? 'Rollback queued.' : 'Release rejected.');
              }
            }}
          />
          <DefaultButton text="Cancel" onClick={() => setReasonAction(null)} />
        </DialogFooter>
      </Dialog>

      <ExceptionPanel
        open={exceptionPanel}
        families={families}
        onDismiss={() => setExceptionPanel(false)}
        onSubmit={async (body) => {
          await api.post('/api/gpo/exceptions', body);
          setExceptionPanel(false);
          setNotice('Exception submitted. A different approver must approve it.');
          await load(true);
        }}
      />
    </Stack>
  );
}

const TEMPLATE_SECTIONS = ['Privilege Rights', 'System Access', 'Kerberos Policy', 'Event Audit', 'Registry Values', 'Service General Setting', 'Group Membership', 'Application Log', 'Security Log', 'System Log'];
const VALUE_TYPES = ['DWord', 'String', 'ExpandString', 'MultiString', 'QWord', 'Binary'];

function ExceptionPanel({ open, families, onDismiss, onSubmit }: {
  open: boolean;
  families: string[];
  onDismiss: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState<'securityTemplate' | 'registry'>('securityTemplate');
  const [action, setAction] = useState<'set' | 'delete'>('set');
  const [form, setForm] = useState<Record<string, string>>({ hive: 'HKLM', valueType: 'DWord', section: 'Privilege Rights' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (_: unknown, v?: string) => setForm((f) => ({ ...f, [k]: v ?? '' }));
  const opt = (values: string[]): IDropdownOption[] => values.map((v) => ({ key: v, text: v }));

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const common = {
        gpoFamily: form.gpoFamily, kind, action, justification: form.justification,
        reference: form.reference || undefined,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
      };
      const body = kind === 'registry'
        ? { ...common, hive: form.hive, key: form.key, valueName: form.valueName, ...(action === 'set' ? { valueType: form.valueType, value: form.value ?? '' } : {}) }
        : { ...common, section: form.section, settingKey: form.settingKey, ...(action === 'set' ? { settingValue: form.settingValue ?? '' } : {}) };
      await onSubmit(body);
      setForm({ hive: 'HKLM', valueType: 'DWord', section: 'Privilege Rights' });
    } catch (e) {
      setError(errorText(e, 'Could not save the exception'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel isOpen={open} onDismiss={onDismiss} type={PanelType.medium} headerText="New GPO exception">
      <Stack tokens={{ childrenGap: 12 }}>
        {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}
        <Dropdown label="GPO" required options={opt(families)} selectedKey={form.gpoFamily}
          placeholder={families.length ? 'Select a DISA GPO' : 'Discover a DISA package first'}
          onChange={(_, o) => setForm((f) => ({ ...f, gpoFamily: String(o?.key ?? '') }))} />
        <ChoiceGroup label="Type" selectedKey={kind} onChange={(_, o) => setKind(o?.key as typeof kind)} options={[
          { key: 'securityTemplate', text: 'Security setting (user rights, account policy, security options)' },
          { key: 'registry', text: 'Administrative template / registry value' },
        ]} />
        <ChoiceGroup label="Action" selectedKey={action} onChange={(_, o) => setAction(o?.key as typeof action)} options={[
          { key: 'set', text: 'Set value' }, { key: 'delete', text: 'Remove the DISA setting' },
        ]} />
        {kind === 'securityTemplate' ? (
          <>
            <Dropdown label="Section" options={opt(TEMPLATE_SECTIONS)} selectedKey={form.section} onChange={(_, o) => setForm((f) => ({ ...f, section: String(o?.key) }))} />
            <TextField label="Setting" required placeholder="SeDenyNetworkLogonRight" value={form.settingKey ?? ''} onChange={set('settingKey')} />
            {action === 'set' && (
              <TextField label="Value" required placeholder="*S-1-5-114,*S-1-5-32-546,*S-1-5-21-…-512" value={form.settingValue ?? ''} onChange={set('settingValue')}
                description="Use the GptTmpl.inf format. Prefer *SIDs over account names." />
            )}
          </>
        ) : (
          <>
            <Dropdown label="Hive" options={opt(['HKLM', 'HKCU'])} selectedKey={form.hive} onChange={(_, o) => setForm((f) => ({ ...f, hive: String(o?.key) }))} />
            <TextField label="Key" required placeholder="Software\Policies\Microsoft\Edge" value={form.key ?? ''} onChange={set('key')} />
            <TextField label="Value name" required value={form.valueName ?? ''} onChange={set('valueName')} />
            {action === 'set' && (
              <>
                <Dropdown label="Value type" options={opt(VALUE_TYPES)} selectedKey={form.valueType} onChange={(_, o) => setForm((f) => ({ ...f, valueType: String(o?.key) }))} />
                <TextField label="Value" required value={form.value ?? ''} onChange={set('value')}
                  description="MultiString entries are separated by \0; Binary values are hex bytes." />
              </>
            )}
          </>
        )}
        <TextField label="Justification" required multiline rows={3} value={form.justification ?? ''} onChange={set('justification')} />
        <TextField label="Reference (POA&M, waiver, ticket)" value={form.reference ?? ''} onChange={set('reference')} />
        <TextField label="Expires" type="date" value={form.expiresAt ?? ''} onChange={set('expiresAt')} />
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <PrimaryButton text="Submit for approval" disabled={saving || !form.gpoFamily || !form.justification} onClick={() => void submit()} />
          <DefaultButton text="Cancel" onClick={onDismiss} />
        </Stack>
      </Stack>
    </Panel>
  );
}
