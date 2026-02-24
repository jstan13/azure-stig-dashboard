/**
 * Machine Detail Page
 * Shows per-control findings, evidence, remediation steps, and an export button.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  DefaultButton, PrimaryButton, DetailsList, DetailsListLayoutMode,
  SelectionMode, IColumn, CommandBar, ICommandBarItemProps,
  Panel, PanelType, Label, Dropdown, IDropdownOption, TextField,
} from '@fluentui/react';
import { api } from '../hooks/useApi';
import ComplianceDonut from '../components/ComplianceDonut';
import ComplianceBadge from '../components/ComplianceBadge';
import type { MachineDetail, Finding } from '../types';

const STATUS_OPTIONS: IDropdownOption[] = [
  { key: 'open', text: 'Open' },
  { key: 'not_a_finding', text: 'Not a Finding' },
  { key: 'not_applicable', text: 'Not Applicable' },
  { key: 'not_reviewed', text: 'Not Reviewed' },
];

function statusBadge(status: string) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    open:           { bg: '#fde7e9', text: '#a4262c', label: 'Open' },
    not_a_finding:  { bg: '#dff6dd', text: '#107c10', label: 'Not a Finding' },
    not_applicable: { bg: '#f3f2f1', text: '#605e5c', label: 'N/A' },
    not_reviewed:   { bg: '#fff4ce', text: '#835b00', label: 'Not Reviewed' },
  };
  const { bg, text, label } = map[status] || { bg: '#f3f2f1', text: '#201f1e', label: status };
  return <span style={{ background: bg, color: text, padding: '2px 10px', borderRadius: 10, fontWeight: 600, fontSize: 12 }}>{label}</span>;
}

export default function MachinePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [machine, setMachine] = useState<MachineDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editComments, setEditComments] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<MachineDetail>(`/api/machines/${id}`);
      setMachine(res.data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function handleExport(format: 'ckl' | 'json' | 'csv') {
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await api.post(
        '/api/export/checklist',
        { machineId: id, format },
        { responseType: format === 'json' ? 'json' : 'blob' },
      );

      const mimeMap = { ckl: 'application/xml', json: 'application/json', csv: 'text/csv' };
      const extMap  = { ckl: '.ckl', json: '.json', csv: '.csv' };
      const blob = format === 'json' ? new Blob([JSON.stringify(res.data, null, 2)], { type: mimeMap.json }) : res.data as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${machine?.name}_${new Date().toISOString().slice(0, 10)}${extMap[format]}`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMsg(`✓ Exported as ${format.toUpperCase()}`);
    } catch (e: any) {
      setExportMsg(`✗ Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  async function saveFinding() {
    if (!selectedFinding) return;
    setSaving(true);
    try {
      await api.patch(`/api/machines/${id}/findings/${selectedFinding.id}`, {
        status: editStatus,
        comments: editComments,
        findingDetails: editDetails,
      });
      setSelectedFinding(null);
      await load();
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const commandItems: ICommandBarItemProps[] = [
    { key: 'back', text: 'Back', iconProps: { iconName: 'Back' }, onClick: () => navigate('/inventory') },
    {
      key: 'export',
      text: exporting ? 'Exporting…' : 'Export',
      disabled: exporting,
      iconProps: { iconName: 'Download' },
      subMenuProps: {
        items: [
          { key: 'ckl',  text: 'Export as .ckl (STIG Viewer)',  onClick: () => handleExport('ckl')  },
          { key: 'json', text: 'Export as JSON',                onClick: () => handleExport('json') },
          { key: 'csv',  text: 'Export as CSV',                 onClick: () => handleExport('csv')  },
        ],
      },
    },
    { key: 'scan', text: 'Scan Now', iconProps: { iconName: 'Refresh' }, onClick: async () => { await api.post('/api/scan/trigger', { resourceIds: [machine?.resourceId] }); } },
  ];

  const columns: IColumn[] = [
    { key: 'vulnId', name: 'Vuln ID', minWidth: 80, onRender: (f: Finding) => f.control?.id || f.controlId },
    { key: 'stigId', name: 'Rule', minWidth: 110, onRender: (f: Finding) => f.control?.stigId || '-' },
    { key: 'title', name: 'Title', minWidth: 260, isResizable: true, onRender: (f: Finding) => <span title={f.control?.title}>{f.control?.title?.slice(0, 70)}…</span> },
    { key: 'severity', name: 'Sev', minWidth: 60, onRender: (f: Finding) => f.severity },
    { key: 'status', name: 'Status', minWidth: 110, onRender: (f: Finding) => statusBadge(f.status) },
    {
      key: 'edit', name: '', minWidth: 60,
      onRender: (f: Finding) => (
        <DefaultButton text="Edit" styles={{ root: { height: 24, fontSize: 11 } }} onClick={() => { setSelectedFinding(f); setEditStatus(f.status); setEditComments(f.comments || ''); setEditDetails(f.findingDetails || ''); }} />
      ),
    },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading…" style={{ marginTop: 80 }} />;
  if (error)   return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;
  if (!machine) return null;

  const { summary } = machine;

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <CommandBar items={commandItems} />

      {exportMsg && (
        <MessageBar messageBarType={exportMsg.startsWith('✓') ? MessageBarType.success : MessageBarType.error} onDismiss={() => setExportMsg(null)}>
          {exportMsg}
        </MessageBar>
      )}

      {/* Machine header */}
      <Stack horizontal tokens={{ childrenGap: 24 }} verticalAlign="start" wrap>
        <Stack tokens={{ childrenGap: 4 }}>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>{machine.name}</Text>
          <Text style={{ color: '#605e5c' }}>{machine.osType} — {machine.osVersion}</Text>
          <Text style={{ color: '#a19f9d', fontSize: 12 }}>{machine.resourceId}</Text>
          <Text style={{ color: '#605e5c' }}>RG: {machine.resourceGroupName} | Location: {machine.location}</Text>
          {machine.lastScanDate && <Text style={{ color: '#605e5c' }}>Last scanned: {new Date(machine.lastScanDate).toLocaleString()}</Text>}
        </Stack>
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 16 }}>
          <ComplianceDonut
            open={summary.open}
            notAFinding={summary.notAFinding}
            notApplicable={summary.notApplicable}
            notReviewed={summary.notReviewed}
            size={220}
          />
        </div>

        {/* Summary chips */}
        <Stack tokens={{ childrenGap: 8 }} verticalAlign="center">
          {[
            { label: 'Open', value: summary.open, color: '#a4262c', bg: '#fde7e9' },
            { label: 'Not a Finding', value: summary.notAFinding, color: '#107c10', bg: '#dff6dd' },
            { label: 'Not Applicable', value: summary.notApplicable, color: '#605e5c', bg: '#f3f2f1' },
            { label: 'Not Reviewed', value: summary.notReviewed, color: '#835b00', bg: '#fff4ce' },
          ].map((s) => (
            <div key={s.label} style={{ background: s.bg, color: s.color, padding: '6px 16px', borderRadius: 6, fontWeight: 600 }}>
              {s.value} {s.label}
            </div>
          ))}
        </Stack>
      </Stack>

      {/* Findings table */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
        <div style={{ padding: '16px 20px 0' }}>
          <Text variant="large" style={{ fontWeight: 600 }}>Control Findings ({machine.findings.length})</Text>
        </div>
        <DetailsList
          items={machine.findings}
          columns={columns}
          layoutMode={DetailsListLayoutMode.justified}
          selectionMode={SelectionMode.none}
        />
      </div>

      {/* Edit finding panel */}
      <Panel
        isOpen={!!selectedFinding}
        onDismiss={() => setSelectedFinding(null)}
        type={PanelType.medium}
        headerText="Edit Finding"
        isFooterAtBottom
        onRenderFooterContent={() => (
          <Stack horizontal tokens={{ childrenGap: 8 }}>
            <PrimaryButton text={saving ? 'Saving…' : 'Save'} disabled={saving} onClick={saveFinding} />
            <DefaultButton text="Cancel" onClick={() => setSelectedFinding(null)} />
          </Stack>
        )}
      >
        {selectedFinding && (
          <Stack tokens={{ childrenGap: 16 }} style={{ padding: '16px 0' }}>
            <Label>Control: {selectedFinding.control?.id} — {selectedFinding.control?.stigId}</Label>
            <Text style={{ color: '#605e5c' }}>{selectedFinding.control?.title}</Text>
            <Dropdown
              label="Status"
              selectedKey={editStatus}
              options={STATUS_OPTIONS}
              onChange={(_e, o) => setEditStatus(o?.key as string)}
            />
            <TextField
              label="Finding Details"
              multiline rows={4}
              value={editDetails}
              onChange={(_e, v) => setEditDetails(v || '')}
            />
            <TextField
              label="Comments"
              multiline rows={3}
              value={editComments}
              onChange={(_e, v) => setEditComments(v || '')}
            />
            {selectedFinding.control?.checkContent && (
              <div style={{ background: '#f3f2f1', borderRadius: 6, padding: 12 }}>
                <Label>Check Content</Label>
                <Text style={{ fontSize: 12 }}>{selectedFinding.control.checkContent}</Text>
              </div>
            )}
            {selectedFinding.control?.fixText && (
              <div style={{ background: '#dff6dd', borderRadius: 6, padding: 12 }}>
                <Label>Fix Text</Label>
                <Text style={{ fontSize: 12 }}>{selectedFinding.control.fixText}</Text>
              </div>
            )}
          </Stack>
        )}
      </Panel>
    </Stack>
  );
}
