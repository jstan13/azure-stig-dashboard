/**
 * Bulk Remediation page — select open findings across many machines and
 * push remediation jobs through the existing remediationRunner. Includes a
 * mandatory approval gate (admin or operator with explicit confirm box).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  PrimaryButton, DefaultButton, Dialog, DialogType, DialogFooter, Checkbox,
  DetailsList, DetailsListLayoutMode, SelectionMode, Selection, IColumn,
  Dropdown, IDropdownOption,
} from '@fluentui/react';
import { api } from '../hooks/useApi';

interface Finding {
  id: string; machineId: string; controlId: string; status: string;
  severity: string; comments?: string;
}
interface Job {
  id: string; status: string; targetType: string; targetId: string;
  controlIds: string[]; createdAt: string; completedAt?: string;
  result?: any; createdBy?: string;
}

export default function BulkRemediationPage() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error,   setError]     = useState<string | null>(null);

  const [sevFilter, setSevFilter] = useState<string | undefined>('high');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [selection] = useState(() => new Selection({ onSelectionChanged: () => setSelectedKey((s) => s + 1) }));
  const [, setSelectedKey] = useState(0);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [f, j] = await Promise.all([
        api.get<{ data: Finding[] }>('/api/machines?pageSize=1000&includeFindings=true'),
        api.get<{ jobs: Job[] }>('/api/remediation/jobs?limit=20'),
      ]);
      // Flatten findings out of machines payload
      const all: Finding[] = [];
      (f.data.data as any[]).forEach((m: any) => {
        (m.findings || []).forEach((fd: Finding) => all.push({ ...fd, machineId: m.id }));
      });
      setFindings(all.filter((x) => x.status === 'open'));
      setJobs(j.data.jobs);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => findings.filter((f) =>
    !sevFilter || f.severity === sevFilter
  ), [findings, sevFilter]);

  async function submitBulk() {
    setSubmitting(true);
    try {
      const items = selection.getSelection() as any as Finding[];
      // group by machine so the runner can batch DSC pushes per host
      const byMachine = new Map<string, string[]>();
      items.forEach((f) => {
        const arr = byMachine.get(f.machineId) || [];
        arr.push(f.controlId);
        byMachine.set(f.machineId, arr);
      });
      for (const [machineId, controlIds] of byMachine) {
        await api.post('/api/remediation/jobs', {
          targetType: 'machine',
          targetId: machineId,
          controlIds,
          dryRun: false,
        });
      }
      setConfirmOpen(false);
      setAcknowledged(false);
      selection.setAllSelected(false);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Bulk submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  const columns: IColumn[] = [
    { key: 'sev', name: 'Severity', minWidth: 90, onRender: (f: Finding) => (
      <span style={{ background: sevColor(f.severity), color: '#fff', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
        {f.severity}
      </span>
    ) },
    { key: 'control', name: 'Control', fieldName: 'controlId', minWidth: 140 },
    { key: 'machine', name: 'Machine', fieldName: 'machineId', minWidth: 160 },
    { key: 'comments', name: 'Comments', fieldName: 'comments', minWidth: 200, isMultiline: true },
  ];

  const jobColumns: IColumn[] = [
    { key: 'st', name: 'Status', fieldName: 'status', minWidth: 90 },
    { key: 'tgt', name: 'Target', minWidth: 160, onRender: (j: Job) => `${j.targetType}/${j.targetId}` },
    { key: 'ct', name: 'Controls', minWidth: 80, onRender: (j: Job) => `${j.controlIds?.length || 0}` },
    { key: 'who', name: 'Created by', fieldName: 'createdBy', minWidth: 160 },
    { key: 'when', name: 'Created', minWidth: 160, onRender: (j: Job) => new Date(j.createdAt).toLocaleString() },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading…" style={{ marginTop: 80 }} />;

  const selCount = selection.getSelectedCount();
  const machineCount = new Set((selection.getSelection() as any as Finding[]).map((f) => f.machineId)).size;

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap tokens={{ childrenGap: 8 }}>
        <Stack>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>Bulk Remediation</Text>
          <Text style={{ color: '#605e5c' }}>
            Select open findings across machines and push approved DSC/PowerSTIG remediation jobs in one batch.
          </Text>
        </Stack>
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <Dropdown label="Severity filter"
            selectedKey={sevFilter}
            options={[{ key: '', text: '(any)' }, ...['high','medium','low'].map((k) => ({ key: k, text: k }))] as IDropdownOption[]}
            onChange={(_e, o) => setSevFilter(o?.key ? String(o.key) : undefined)}
            styles={{ root: { width: 160 } }}
          />
          <PrimaryButton
            iconProps={{ iconName: 'Repair' }}
            text={`Remediate ${selCount} finding${selCount === 1 ? '' : 's'}${machineCount ? ` on ${machineCount} machine${machineCount === 1 ? '' : 's'}` : ''}`}
            disabled={!selCount}
            onClick={() => setConfirmOpen(true)}
          />
        </Stack>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError(null)}>{error}</MessageBar>}

      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
        <DetailsList
          items={filtered}
          columns={columns}
          selection={selection}
          selectionMode={SelectionMode.multiple}
          layoutMode={DetailsListLayoutMode.justified}
          compact
        />
        {!filtered.length && <div style={{ padding: 24, color: '#605e5c' }}>No open findings at this severity.</div>}
      </div>

      <Text variant="large" style={{ fontWeight: 600, marginTop: 8 }}>Recent jobs</Text>
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
        <DetailsList
          items={jobs}
          columns={jobColumns}
          layoutMode={DetailsListLayoutMode.justified}
          selectionMode={SelectionMode.none}
          compact
        />
        {!jobs.length && <div style={{ padding: 24, color: '#605e5c' }}>No remediation jobs yet.</div>}
      </div>

      <Dialog
        hidden={!confirmOpen}
        onDismiss={() => setConfirmOpen(false)}
        dialogContentProps={{
          type: DialogType.normal,
          title: 'Confirm bulk remediation',
          subText: `You are about to push DSC/PowerSTIG remediation for ${selCount} finding${selCount === 1 ? '' : 's'} across ${machineCount} machine${machineCount === 1 ? '' : 's'}. Each job is logged to the audit trail and is reversible only by re-running with the previous policy.`,
        }}
      >
        <Checkbox
          label="I have authorisation to remediate the selected hosts and accept the operational risk."
          checked={acknowledged}
          onChange={(_e, c) => setAcknowledged(!!c)}
        />
        <DialogFooter>
          <PrimaryButton onClick={submitBulk} disabled={!acknowledged || submitting} text={submitting ? 'Submitting…' : 'Push remediation'} />
          <DefaultButton onClick={() => setConfirmOpen(false)} text="Cancel" />
        </DialogFooter>
      </Dialog>
    </Stack>
  );
}

function sevColor(s: string): string {
  return ({ high: '#a4262c', medium: '#ca5010', low: '#605e5c' } as any)[s] || '#605e5c';
}
