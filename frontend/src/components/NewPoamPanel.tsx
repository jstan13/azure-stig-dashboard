/**
 * New POA&M panel
 *
 * Creates a single POA&M by hand, for weaknesses that did not come from a scan
 * (assessments, audits, pen tests) or for one specific open finding. Linking a
 * finding pre-fills the weakness and fixes the severity to the finding's CAT.
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

const CONTROL_RE = /^[A-Z]{2}-\d{1,2}(\(\d{1,2}\))?$/;

interface FormState {
  weakness: string;
  severity: string;
  controlAcronym: string;
  sourceIdentifyingControl: string;
  description: string;
  impact: string;
  countermeasures: string;
  resourcesRequired: string;
  assignedToName: string;
  scheduledCompletion?: Date;
}

const EMPTY_FORM: FormState = {
  weakness: '', severity: '', controlAcronym: '', sourceIdentifyingControl: '', description: '',
  impact: '', countermeasures: '', resourcesRequired: '', assignedToName: '',
};

function errorMessage(e: any): string {
  return e?.response?.data?.message ?? e?.message ?? 'Request failed';
}

const catOf = (severity: string) =>
  severity === 'high' ? 'CAT I' : severity === 'medium' ? 'CAT II' : 'CAT III';

export interface NewPoamPanelProps {
  isOpen: boolean;
  onDismiss: () => void;
  onCreated: (poam: any) => void;
}

export default function NewPoamPanel({ isOpen, onDismiss, onCreated }: NewPoamPanelProps) {
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
    setForm(EMPTY_FORM);
    setMachineId('');
    setFindings([]);
    setFindingId('');
    setError('');
    api.get<PaginatedResponse<Machine>>('/api/machines?pageSize=500')
      .then((res) => setMachines(res.data?.data ?? []))
      .catch(() => setMachines([]));
  }, [isOpen]);

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

  const set = (key: keyof FormState) => (_: unknown, v?: string) => setForm((f) => ({ ...f, [key]: v ?? '' }));

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
  const canSave = !saving && form.weakness.trim() !== '' && (finding || form.severity) && !controlError;

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      let scheduledCompletion: string | undefined;
      if (form.scheduledCompletion) {
        // Noon local time keeps the chosen calendar day in every time zone.
        const d = new Date(form.scheduledCompletion);
        d.setHours(12, 0, 0, 0);
        scheduledCompletion = d.toISOString();
      }
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
        scheduledCompletion,
      });
      onCreated(res.data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      isOpen={isOpen}
      onDismiss={onDismiss}
      type={PanelType.medium}
      headerText="New POA&M"
      closeButtonAriaLabel="Close"
      isFooterAtBottom
      onRenderFooterContent={() => (
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <PrimaryButton text={saving ? 'Creating…' : 'Create POA&M'} disabled={!canSave} onClick={() => { void submit(); }} />
          <DefaultButton text="Cancel" onClick={onDismiss} disabled={saving} />
        </Stack>
      )}
    >
      <Stack tokens={{ childrenGap: 12 }} style={{ padding: '16px 0' }}>
        {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}

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

        <TextField label="Weakness" required multiline autoAdjustHeight value={form.weakness} onChange={set('weakness')} maxLength={2000} />
        <Dropdown
          label="Severity"
          required
          options={SEVERITY_OPTIONS}
          selectedKey={finding ? (['high', 'medium', 'low'].includes(finding.severity) ? finding.severity : 'low') : (form.severity || null)}
          disabled={!!finding}
          placeholder="Select a CAT"
          onChange={(_, o) => setForm((f) => ({ ...f, severity: String(o?.key ?? '') }))}
        />
        {finding && <Text variant="small" style={{ color: '#605e5c' }}>Severity follows the linked finding.</Text>}
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
          placeholder="Defaults from the CAT (30 / 90 / 180 days)"
          value={form.scheduledCompletion}
          minDate={new Date()}
          onSelectDate={(d) => setForm((f) => ({ ...f, scheduledCompletion: d ?? undefined }))}
          allowTextInput
        />
        <TextField label="Assigned to" value={form.assignedToName} onChange={set('assignedToName')} maxLength={200} />
      </Stack>
    </Panel>
  );
}
