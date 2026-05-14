/**
 * POA&M Page
 *
 * Displays Plan of Action & Milestones:
 *   - Filterable, sortable table with status badges
 *   - Overdue highlighting (red rows)
 *   - Detail panel with milestones & timeline
 *   - Bulk-create from open CAT I findings
 *   - CSV export (DISA format)
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Stack, Text, DetailsList, DetailsListLayoutMode, IColumn,
  SelectionMode, CommandBar, ICommandBarItemProps,
  MessageBar, MessageBarType, Spinner, SpinnerSize,
  Panel, PanelType, Label, DefaultButton, PrimaryButton,
  Dropdown, IDropdownOption, SearchBox, mergeStyleSets, Icon,
} from '@fluentui/react';
import { api } from '../hooks/useApi';

const BASE = import.meta.env.VITE_API_URL || '';

const classes = mergeStyleSets({
  overdue: { background: '#fde7e9 !important' },
  statusBadge: { display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 },
});

const STATUS_COLORS: Record<string, string> = {
  open:              '#a4262c',
  in_remediation:    '#ca5010',
  resolved:          '#107c10',
  risk_accepted:     '#8764b8',
  false_positive:    '#2b88d8',
  closed:            '#605e5c',
};

const STATUS_OPTIONS: IDropdownOption[] = [
  { key: '', text: 'All Statuses' },
  { key: 'open', text: 'Open' },
  { key: 'in_remediation', text: 'In Remediation' },
  { key: 'resolved', text: 'Resolved' },
  { key: 'risk_accepted', text: 'Risk Accepted' },
  { key: 'false_positive', text: 'False Positive' },
  { key: 'closed', text: 'Closed' },
];

const SEVERITY_OPTIONS: IDropdownOption[] = [
  { key: '', text: 'All Severities' },
  { key: 'high', text: 'CAT I (High)' },
  { key: 'medium', text: 'CAT II (Medium)' },
  { key: 'low', text: 'CAT III (Low)' },
];

export default function PoamPage() {
  const [poams, setPoams]         = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [selected, setSelected]   = useState<any | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);

  const loadPoams = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);
      const res = await api.get<any>(`/api/poams?${params}`);
      setPoams(res.data?.poams ?? res.data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [api, statusFilter, severityFilter]);

  useEffect(() => { loadPoams(); }, [loadPoams]);

  const today = new Date();
  const isOverdue = (p: any) =>
    p.scheduledCompletion &&
    new Date(p.scheduledCompletion) < today &&
    !['resolved', 'closed', 'false_positive'].includes(p.status);

  const filtered = poams.filter((p) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return p.poamId?.toLowerCase().includes(s) || p.weakness?.toLowerCase().includes(s);
  });

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: IColumn[] = [
    {
      key: 'poamId', name: 'POA&M ID', minWidth: 110, maxWidth: 130,
      onRender: (p) => <Text variant="small" style={{ fontFamily: 'monospace' }}>{p.poamId}</Text>,
    },
    {
      key: 'weakness', name: 'Weakness', minWidth: 200, isMultiline: true,
      onRender: (p) => <Text variant="small">{p.weakness}</Text>,
    },
    {
      key: 'severity', name: 'CAT', minWidth: 70, maxWidth: 80,
      onRender: (p) => {
        const cat = p.severity === 'high' ? 'I' : p.severity === 'medium' ? 'II' : 'III';
        const color = p.severity === 'high' ? '#a4262c' : p.severity === 'medium' ? '#ca5010' : '#107c10';
        return <span className={classes.statusBadge} style={{ background: color, color: '#fff' }}>CAT {cat}</span>;
      },
    },
    {
      key: 'status', name: 'Status', minWidth: 120, maxWidth: 140,
      onRender: (p) => (
        <span className={classes.statusBadge} style={{ background: STATUS_COLORS[p.status] ?? '#605e5c', color: '#fff' }}>
          {p.status?.replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key: 'scheduledCompletion', name: 'Due Date', minWidth: 100, maxWidth: 110,
      onRender: (p) => {
        const overdue = isOverdue(p);
        return (
          <Text variant="small" style={{ color: overdue ? '#a4262c' : 'inherit', fontWeight: overdue ? 600 : 400 }}>
            {p.scheduledCompletion ? new Date(p.scheduledCompletion).toLocaleDateString() : '—'}
            {overdue && ' ⚠'}
          </Text>
        );
      },
    },
    {
      key: 'assignedTo', name: 'Assigned To', minWidth: 120, maxWidth: 160,
      onRender: (p) => <Text variant="small">{p.assignedToName ?? '—'}</Text>,
    },
    {
      key: 'milestones', name: 'Milestones', minWidth: 80, maxWidth: 90,
      onRender: (p) => <Text variant="small">{p.milestones?.length ?? 0}</Text>,
    },
  ];

  // ── Command bar ───────────────────────────────────────────────────────────
  const commandItems: ICommandBarItemProps[] = [
    {
      key: 'refresh', text: 'Refresh', iconProps: { iconName: 'Refresh' },
      onClick: () => { void loadPoams(); },
    },
    {
      key: 'bulkCreate', text: 'Bulk Create from Open Findings', iconProps: { iconName: 'BulkUpload' },
      disabled: bulkCreating,
      onClick: () => { void (async () => {
        setBulkCreating(true);
        try {
          const res = await api.post<any>('/api/poams/bulk-create', { status: 'open', severity: 'high' }); const result = res.data;
          alert(`Created ${result.created} new POA&M(s) from open CAT I findings.`);
          loadPoams();
        } catch (e: any) {
          alert('Bulk create failed: ' + e.message);
        } finally {
          setBulkCreating(false);
        }
      })(); },
    },
    {
      key: 'export', text: 'Export CSV', iconProps: { iconName: 'Download' },
      onClick: () => {
        window.open(`${BASE}/api/poams/export`, '_blank');
      },
    },
  ];

  // ── Detail panel ──────────────────────────────────────────────────────────
  const openDetail = (item: any) => { setSelected(item); setPanelOpen(true); };

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center">
        <Text variant="xLarge" style={{ fontWeight: 700 }}>Plan of Action & Milestones (POA&M)</Text>
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <Text variant="small" style={{ color: '#605e5c' }}>
            {filtered.filter(isOverdue).length} overdue
          </Text>
          <Text variant="small" style={{ color: '#605e5c' }}>
            · {filtered.filter((p) => p.status === 'open').length} open
          </Text>
        </Stack>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}

      {/* Filters */}
      <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
        <SearchBox placeholder="Search POA&M ID or weakness..." value={search} onChange={(_, v) => setSearch(v ?? '')} styles={{ root: { width: 280 } }} />
        <Dropdown options={STATUS_OPTIONS} selectedKey={statusFilter} onChange={(_, o) => setStatusFilter(String(o?.key ?? ''))} placeholder="Status" styles={{ root: { width: 160 } }} />
        <Dropdown options={SEVERITY_OPTIONS} selectedKey={severityFilter} onChange={(_, o) => setSeverityFilter(String(o?.key ?? ''))} placeholder="Severity" styles={{ root: { width: 160 } }} />
      </Stack>

      <CommandBar items={commandItems} styles={{ root: { padding: 0 } }} />

      {loading
        ? <Spinner size={SpinnerSize.large} label="Loading POA&Ms..." />
        : (
          <DetailsList
            items={filtered}
            columns={columns}
            layoutMode={DetailsListLayoutMode.justified}
            selectionMode={SelectionMode.single}
            onActiveItemChanged={openDetail}
            onRenderRow={(props, defaultRender) => {
              if (!props || !defaultRender) return null;
              const item = props.item;
              const style = isOverdue(item) ? { background: '#fde7e9' } : {};
              return <div style={style}>{defaultRender(props)}</div>;
            }}
          />
        )
      }
      {!loading && filtered.length === 0 && (
        <Stack horizontalAlign="center" tokens={{ padding: 40 }}>
          <Icon iconName="TaskSolid" style={{ fontSize: 48, color: '#c8c6c4' }} />
          <Text variant="large" style={{ color: '#605e5c', marginTop: 8 }}>No POA&Ms found</Text>
        </Stack>
      )}

      {/* Detail Panel */}
      <Panel
        isOpen={panelOpen}
        onDismiss={() => setPanelOpen(false)}
        type={PanelType.medium}
        headerText={selected?.poamId ?? ''}
        isLightDismiss
      >
        {selected && (
          <Stack tokens={{ childrenGap: 12 }} style={{ padding: '16px 0' }}>
            <PoamDetailField label="Weakness"                value={selected.weakness} />
            <PoamDetailField label="Status"                  value={selected.status?.replace(/_/g, ' ')} />
            <PoamDetailField label="Severity"                value={selected.severity === 'high' ? 'CAT I' : selected.severity === 'medium' ? 'CAT II' : 'CAT III'} />
            <PoamDetailField label="Assigned To"             value={selected.assignedToName ?? 'Unassigned'} />
            <PoamDetailField label="Scheduled Completion"    value={selected.scheduledCompletion ? new Date(selected.scheduledCompletion).toLocaleDateString() : '—'} />
            <PoamDetailField label="Actual Completion"       value={selected.actualCompletion ? new Date(selected.actualCompletion).toLocaleDateString() : '—'} />
            <PoamDetailField label="Countermeasures"         value={selected.countermeasures ?? '—'} />
            <PoamDetailField label="Resources Required"      value={selected.resourcesRequired ?? '—'} />
            <PoamDetailField label="Risk Acceptance"         value={selected.riskAcceptanceRationale ?? '—'} />

            {selected.milestones?.length > 0 && (
              <>
                <Label>Milestones</Label>
                {selected.milestones.map((m: any, i: number) => (
                  <Stack key={i} horizontal tokens={{ childrenGap: 8 }} verticalAlign="center">
                    <Icon iconName={m.status === 'completed' ? 'CheckMark' : 'CircleRing'} style={{ color: m.status === 'completed' ? '#107c10' : '#605e5c' }} />
                    <Stack.Item grow><Text variant="small">{m.description}</Text></Stack.Item>
                    <Text variant="small" style={{ color: '#605e5c' }}>{m.dueDate ? new Date(m.dueDate).toLocaleDateString() : ''}</Text>
                  </Stack>
                ))}
              </>
            )}
          </Stack>
        )}
      </Panel>
    </Stack>
  );
}

function PoamDetailField({ label, value }: { label: string; value: string }) {
  return (
    <Stack>
      <Label styles={{ root: { fontWeight: 600, color: '#323130', paddingBottom: 2 } }}>{label}</Label>
      <Text variant="small">{value}</Text>
    </Stack>
  );
}
