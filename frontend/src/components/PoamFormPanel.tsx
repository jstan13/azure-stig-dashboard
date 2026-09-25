/**
 * POA&M form panel — create or edit a single POA&M.
 *
 * Create: record a weakness that did not come from a scan (assessments, audits,
 * pen tests) or one specific open finding. Linking a finding pre-fills the
 * weakness and fixes the severity to the finding's CAT.
 *
 * Edit: change any POA&M field except the linked finding. Only changed fields
 * are sent; clearing a text box clears the field. Risk acceptance is not set
 * here — it goes through the approval workflow.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Stack, Panel, PanelType, TextField, Dropdown, IDropdownOption, ComboBox, IComboBoxOption,
  DatePicker, PrimaryButton, DefaultButton, MessageBar, MessageBarType, Text, Separator,
} from '@fluentui/react';
import { api } from '../hooks/useApi';
import type { Finding, Machine, MachineDetail, PaginatedResponse } from '../types';

const SEVERITY_OPTIONS: IDropdownOption[] = [
  { key: 'high', text: 'CAT I (High) — due in 30 days' },
  { key: 'medium', text: 'CAT II (Medium) — due in 90 days' },
  { key: 'low', text: 'CAT III (Low) — due in 180 days' },
];

const STATUS_OPTIONS: IDropdownOption[] = [
  { key: 'open', text: 'Open' },
  { key: 'in_remediation', text: 'In Remediation' },
  { key: 'resolved', text: 'Resolved' },
  { key: 'false_positive', text: 'False Positive' },
  { key: 'closed', text: 'Closed' },
];

const CONTROL_RE = /^[A-Z]{2}-\d{1,2}(\(\d{1,2}\))?$/;

const TEXT_FIELDS = [
  'weakness', 'controlAcronym', 'sourceIdentifyingControl', 'description', 'impact',
  'countermeasures', 'resourcesRequired', 'assignedToName', 'delayReason',
] as const;

type TextKey = typeof TEXT_FIELDS[number];

type FormState = Record<TextKey, string> & {
  severity: string;
  status: string;
  scheduledCompletion?: Date;
};

const EMPTY_FORM: FormState = {
  weakness: '', severity: '', status: 'open', controlAcronym: '', sourceIdentifyingControl: '',
  description: '', impact: '', countermeasures: '', resourcesRequired: '', assignedToName: '', delayReason: '',
};

function formFromPoam(p: any): FormState {
  const form = { ...EMPTY_FORM };
  for (const k of TEXT_FIELDS) form[k] = p[k] ?? '';
  form.severity = p.severity ?? '';
  form.status = p.status ?? 'open';
  form.scheduledCompletion = p.scheduledCompletion ? new Date(p.scheduledCompletion) : undefined;
  return form;
}

function errorMessage(e: any): string {
  return e?.response?.data?.message ?? e?.message ?? 'Request failed';
}

/** Noon local time keeps the chosen calendar day in every time zone. */
function toDateParam(d?: Date): string | undefined {
  if (!d) return undefined;
  const noon = new Date(d);
  noon.setHours(12, 0, 0, 0);
  return noon.toISOString();
}

const sameDay = (a?: Date, b?: Date) => (a && b ? a.toDateString() === b.toDateString() : a === b);

const catOf = (severity: string) =>
  severity === 'high' ? 'CAT I' : severity === 'medium' ? 'CAT II' : 'CAT III';

export interface PoamFormPanelProps {
  isOpen: boolean;
  /** The POA&M to edit; omit to create a new one. */
  poam?: any;
  onDismiss: () => void;
  onSaved: (poam: any, mode: 'created' | 'updated') => void;
}

export default function PoamFormPanel({ isOpen, poam, onDismiss, onSaved }: PoamFormPanelProps) {
  const editing = !!poam;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineId, setMachineId] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);
  const [findingId, setFindingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setForm(poam ? formFromPoam(poam) : EMPTY_FORM);
    setMachineId('');
    setFindings([]);
    setFindingId('');
    setError('');
    if (poam) return;
    api.get<PaginatedResponse<Machine>>('/api/machines?pageSize=500')
      .then((res) => setMachines(res.data?.data ?? []))
      .catch(() => setMachines([]));
  }, [isOpen, poam]);

  useEffect(() => {
    setFindingId('');
    setFindings([]);
    if (!machineId) return;
    let cancelled = false;
    setFindingsLoading(true);
    api.get<MachineDetail>(`/api/machines/${encodeURIComponent(machineId)}`)
      .then((res) => {
        if (!cancelled) setFindings((res.data?.findings ?? []).filter((f) => f.status === 'open'));
      })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setFindingsLoading(false); });
    return () => { cancelled = true; };
  }, [machineId]);

  const finding = useMemo(() => findings.find((f) => f.id === findingId), [findings, findingId]);
  const severityLocked = editing ? !!poam.findingId : !!finding;

  const machineOptions: IComboBoxOption[] = useMemo(
    () => [{ key: '', text: 'None — not from a scan' }, ...machines.map((m) => ({ key: m.id, text: m.name }))],
    [machines],
  );
  const findingOptions: IDropdownOption[] = useMemo(
    () => findings.map((f) => ({
      key: f.id,
      text: `[${catOf(f.severity)}] ${f.control?.stigId ?? f.controlId} — ${f.control?.title ?? ''}`.trim(),
    })),
    [findings],
  );
  const statusOptions: IDropdownOption[] = useMemo(
    () => (poam?.status === 'risk_accepted'
      ? [{ key: 'risk_accepted', text: 'Risk Accepted', disabled: true }, ...STATUS_OPTIONS]
      : STATUS_OPTIONS),
    [poam],
  );

  const set = (key: TextKey) => (_: unknown, v?: string) => setForm((f) => ({ ...f, [key]: v ?? '' }));

  const selectFinding = (id: string) => {
    setFindingId(id);
    const f = findings.find((x) => x.id === id);
    if (!f) return;
    setForm((prev) => ({
      ...prev,
      weakness: prev.weakness || f.control?.title || '',
      description: prev.description || f.control?.description || '',
      severity: f.severity,
    }));
  };

  const control = form.controlAcronym.trim().toUpperCase().replace(/\s+/g, '');
  const controlError = control && !CONTROL_RE.test(control) ? 'Use a NIST SP 800-53 control, e.g. AC-2 or AC-2(1)' : undefined;
  const hasSeverity = severityLocked || !!form.severity;
  const canSave = !saving && form.weakness.trim() !== '' && hasSeverity && !controlError;

  /** Only what changed; '' clears a field on the server. */
  const buildPatch = () => {
    const patch: Record<string, unknown> = {};
    const next: Record<TextKey, string> = { ...form, controlAcronym: control };
    for (const k of TEXT_FIELDS) {
      if (next[k].trim() !== String(poam[k] ?? '').trim()) patch[k] = next[k];
    }
    if (!severityLocked && form.severity !== (poam.severity ?? '')) patch.severity = form.severity;
    if (form.status !== poam.status) patch.status = form.status;
    const original = poam.scheduledCompletion ? new Date(poam.scheduledCompletion) : undefined;
    if (!sameDay(form.scheduledCompletion, original)) patch.scheduledCompletion = toDateParam(form.scheduledCompletion) ?? '';
    return patch;
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      if (editing) {
        const patch = buildPatch();
        if (Object.keys(patch).length === 0) { onDismiss(); return; }
        const res = await api.patch<any>(`/api/poams/${encodeURIComponent(poam.id)}`, patch);
        onSaved(res.data, 'updated');
      } else {
        const res = await api.post<any>('/api/poams', {
          findingId: finding?.id,
          weakness: form.weakness,
          severity: finding ? undefined : form.severity,
          controlAcronym: control || undefined,
          sourceIdentifyingControl: form.sourceIdentifyingControl,
          description: form.description,
          impact: form.impact,
          countermeasures: form.countermeasures,
          resourcesRequired: form.resourcesRequired,
          assignedToName: form.assignedToName,
          scheduledCompletion: toDateParam(form.scheduledCompletion),
        });
        onSaved(res.data, 'created');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const saveText = editing ? (saving ? 'Saving…' : 'Save changes') : (saving ? 'Creating…' : 'Create POA&M');

  return (
    <Panel
      isOpen={isOpen}
      onDismiss={onDismiss}
      type={PanelType.medium}
      headerText={editing ? `Edit ${poam.poamId}` : 'New POA&M'}
      closeButtonAriaLabel="Close"
      isFooterAtBottom
      onRenderFooterContent={() => (
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <PrimaryButton text={saveText} disabled={!canSave} onClick={() => { void submit(); }} />
          <DefaultButton text="Cancel" onClick={onDismiss} disabled={saving} />
        </Stack>
      )}
    >
      <Stack tokens={{ childrenGap: 12 }} style={{ padding: '16px 0' }}>
        {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}

        {!editing && (
          <>
            <Text variant="small" style={{ color: '#605e5c' }}>
              Record a weakness from an assessment, audit or penetration test, or link it to an open scan finding.
            </Text>
            <ComboBox
              label="Related machine (optional)"
              options={machineOptions}
              selectedKey={machineId}
              autoComplete="on"
              allowFreeform={false}
              useComboBoxAsMenuWidth
              placeholder="None — not from a scan"
              onChange={(_, o) => setMachineId(String(o?.key ?? ''))}
            />
            {machineId && (
              <Dropdown
                label="Open finding"
                options={findingOptions}
                selectedKey={findingId || null}
                disabled={findingsLoading || findingOptions.length === 0}
                placeholder={findingsLoading ? 'Loading findings…' : findingOptions.length ? 'Select a finding' : 'No open findings on this machine'}
                onChange={(_, o) => selectFinding(String(o?.key ?? ''))}
              />
            )}
            <Separator />
          </>
        )}

        <TextField label="Weakness" required multiline autoAdjustHeight value={form.weakness} onChange={set('weakness')} maxLength={2000} />
        <Dropdown
          label="Severity"
          required
          options={SEVERITY_OPTIONS}
          selectedKey={
            !editing && finding
              ? (['high', 'medium', 'low'].includes(finding.severity) ? finding.severity : 'low')
              : (form.severity || null)
          }
          disabled={severityLocked}
          placeholder="Select a CAT"
          onChange={(_, o) => setForm((f) => ({ ...f, severity: String(o?.key ?? '') }))}
        />
        {severityLocked && <Text variant="small" style={{ color: '#605e5c' }}>Severity follows the linked finding.</Text>}
        {editing && (
          <Dropdown
            label="Status"
            options={statusOptions}
            selectedKey={form.status}
            onChange={(_, o) => setForm((f) => ({ ...f, status: String(o?.key ?? f.status) }))}
          />
        )}
        <TextField
          label="Security control"
          placeholder="e.g. AC-2 or CM-6(1)"
          value={form.controlAcronym}
          onChange={set('controlAcronym')}
          errorMessage={controlError}
          maxLength={32}
        />
        <TextField
          label="Source identifying weakness"
          placeholder="e.g. FY25 annual security assessment"
          value={form.sourceIdentifyingControl}
          onChange={set('sourceIdentifyingControl')}
          maxLength={500}
        />
        <TextField label="Description" multiline autoAdjustHeight value={form.description} onChange={set('description')} maxLength={8000} />
        <TextField label="Impact" multiline autoAdjustHeight value={form.impact} onChange={set('impact')} maxLength={4000} />
        <TextField label="Mitigations / countermeasures" multiline autoAdjustHeight value={form.countermeasures} onChange={set('countermeasures')} maxLength={8000} />
        <TextField label="Resources required" value={form.resourcesRequired} onChange={set('resourcesRequired')} maxLength={4000} />
        <DatePicker
          label="Scheduled completion"
          placeholder={editing ? 'No date set' : 'Defaults from the CAT (30 / 90 / 180 days)'}
          value={form.scheduledCompletion}
          minDate={editing ? undefined : new Date()}
          onSelectDate={(d) => setForm((f) => ({ ...f, scheduledCompletion: d ?? undefined }))}
          allowTextInput
        />
        {editing && (
          <TextField
            label="Delay reason"
            placeholder="Why the scheduled completion slipped, if it did"
            multiline
            autoAdjustHeight
            value={form.delayReason}
            onChange={set('delayReason')}
            maxLength={4000}
          />
        )}
        <TextField label="Assigned to" value={form.assignedToName} onChange={set('assignedToName')} maxLength={200} />
      </Stack>
    </Panel>
  );
}
