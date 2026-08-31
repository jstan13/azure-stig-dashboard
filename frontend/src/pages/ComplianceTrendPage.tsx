/**
 * Compliance Trend Page
 *
 * Line charts showing compliance score over time:
 *   - Fleet rollup (all machines) 
 *   - Per-machine drilldown
 *   - CAT I/II/III finding distribution bar chart
 *   - Resolved vs Open delta area chart
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Stack, Text, Dropdown, IDropdownOption,
  Spinner, SpinnerSize, MessageBar, MessageBarType,
  CommandBar, ICommandBarItemProps, Pivot, PivotItem,
} from '@fluentui/react';
import {
  LineChart, Line, BarChart, Bar,
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../hooks/useApi';

const DAYS_OPTIONS: IDropdownOption[] = [
  { key: 7,   text: 'Last 7 days' },
  { key: 14,  text: 'Last 14 days' },
  { key: 30,  text: 'Last 30 days' },
  { key: 60,  text: 'Last 60 days' },
  { key: 90,  text: 'Last 90 days' },
  { key: 180, text: 'Last 6 months' },
  { key: 365, text: 'Last year' },
];

const CHART_COLORS = {
  score:     '#0078d4',
  catI:      '#a4262c',
  catII:     '#ca5010',
  catIII:    '#107c10',
  resolved:  '#107c10',
  open:      '#a4262c',
};

export default function ComplianceTrendPage() {
  const [days, setDays]               = useState(30);
  const [rollup, setRollup]           = useState<any[]>([]);
  const [machines, setMachines]       = useState<any[]>([]);
  const [machineId, setMachineId]     = useState('');
  const [machineData, setMachineData] = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');

  const loadRollup = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<any[]>(`/api/compliance-history/rollup?days=${days}`);
      setRollup(res.data);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [api, days]);

  const loadMachines = useCallback(async () => {
    try {
      const res = await api.get<any>('/api/machines');
      // The list endpoints answer with a { data, total, page, pageSize } envelope.
      const raw = res.data?.data ?? res.data;
      const list = Array.isArray(raw) ? raw : [];
      setMachines(list.map((m: any) => ({ key: m.id, text: m.name })));
      if (list.length > 0 && !machineId) setMachineId(list[0].id);
    } catch {}
  }, [api]);

  const loadMachineData = useCallback(async () => {
    if (!machineId) return;
    try {
      const res = await api.get<any[]>(`/api/compliance-history/${machineId}?days=${days}`);
      setMachineData(res.data);
    } catch {}
  }, [api, machineId, days]);

  useEffect(() => { loadRollup(); loadMachines(); }, [loadRollup, loadMachines]);
  useEffect(() => { loadMachineData(); }, [loadMachineData]);

  // Format date labels
  const fmt = (d: string) => {
    const date = new Date(d);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };

  const commandItems: ICommandBarItemProps[] = [
    { key: 'refresh', text: 'Refresh', iconProps: { iconName: 'Refresh' }, onClick: () => { loadRollup(); loadMachineData(); } },
  ];

  // Summary stats from latest rollup data
  const latest = rollup[rollup.length - 1];
  const earliest = rollup[0];
  const scoreDelta = latest && earliest ? (latest.avgScore - earliest.avgScore).toFixed(1) : '—';

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap tokens={{ childrenGap: 8 }}>
        <Text variant="xLarge" style={{ fontWeight: 700 }}>Compliance Trends</Text>
        <Stack horizontal tokens={{ childrenGap: 12 }} verticalAlign="center">
          <Dropdown
            options={DAYS_OPTIONS} selectedKey={days}
            onChange={(_, o) => setDays(Number(o?.key ?? 30))}
            styles={{ root: { width: 160 } }}
          />
        </Stack>
      </Stack>

      <CommandBar items={commandItems} styles={{ root: { padding: 0 } }} />

      {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}

      {/* Summary tiles */}
      <Stack horizontal wrap tokens={{ childrenGap: 12 }}>
        <SummaryTile label="Current Avg Score" value={latest ? `${latest.avgScore.toFixed(1)}%` : '—'} color="#0078d4" />
        <SummaryTile label={`Score Δ (${days}d)`} value={`${Number(scoreDelta) >= 0 ? '+' : ''}${scoreDelta}%`} color={Number(scoreDelta) >= 0 ? '#107c10' : '#a4262c'} />
        <SummaryTile label="Open Findings" value={latest?.openFindings ?? '—'} color="#ca5010" />
        <SummaryTile label="CAT I Open" value={latest?.catIOpen ?? '—'} color="#a4262c" />
        <SummaryTile label="Machines" value={latest?.machineCount ?? machines.length} color="#605e5c" />
      </Stack>

      {loading
        ? <Spinner size={SpinnerSize.large} label="Loading trend data..." />
        : (
          <Pivot>
            {/* Fleet rollup */}
            <PivotItem headerText="Fleet Overview">
              <Stack tokens={{ childrenGap: 24 }} style={{ paddingTop: 16 }}>
                <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Average Compliance Score — Fleet</Text>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={rollup.map((r) => ({ ...r, date: fmt(r.date) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
                    <Legend />
                    <ReferenceLine y={70} stroke="#ca5010" strokeDasharray="4 4" label={{ value: '70% threshold', position: 'right', fontSize: 10 }} />
                    <Line type="monotone" dataKey="avgScore" stroke={CHART_COLORS.score} strokeWidth={2} dot={false} name="Avg Score %" />
                  </LineChart>
                </ResponsiveContainer>

                <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Open vs Resolved Findings</Text>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={rollup.map((r) => ({ ...r, date: fmt(r.date) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Area type="monotone" dataKey="resolved"     stroke={CHART_COLORS.resolved} fill="#c7e0f4" name="Resolved" />
                    <Area type="monotone" dataKey="openFindings" stroke={CHART_COLORS.open}     fill="#fde7e9" name="Open" />
                  </AreaChart>
                </ResponsiveContainer>
              </Stack>
            </PivotItem>

            {/* Per-machine */}
            <PivotItem headerText="Per Machine">
              <Stack tokens={{ childrenGap: 16 }} style={{ paddingTop: 16 }}>
                <Dropdown
                  label="Select machine"
                  options={machines}
                  selectedKey={machineId}
                  onChange={(_, o) => setMachineId(String(o?.key ?? ''))}
                  styles={{ root: { width: 300 } }}
                />
                <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Compliance Score</Text>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={machineData.map((r: any) => ({ ...r, date: fmt(r.snapshotDate) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
                    <ReferenceLine y={70} stroke="#ca5010" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="score" stroke={CHART_COLORS.score} strokeWidth={2} dot={false} name="Score %" />
                  </LineChart>
                </ResponsiveContainer>

                <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Finding Breakdown by Category</Text>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={machineData.map((r: any) => ({ ...r, date: fmt(r.snapshotDate) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="catIOpen"   fill={CHART_COLORS.catI}   name="CAT I"   stackId="a" />
                    <Bar dataKey="catIIOpen"  fill={CHART_COLORS.catII}  name="CAT II"  stackId="a" />
                    <Bar dataKey="catIIIOpen" fill={CHART_COLORS.catIII} name="CAT III" stackId="a" />
                  </BarChart>
                </ResponsiveContainer>
              </Stack>
            </PivotItem>
          </Pivot>
        )
      }
    </Stack>
  );
}

function SummaryTile({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <Stack
      horizontalAlign="center"
      tokens={{ childrenGap: 4 }}
      style={{ background: '#f3f2f1', borderRadius: 8, padding: '14px 22px', minWidth: 120, borderTop: `3px solid ${color}` }}
    >
      <Text variant="xLarge" style={{ fontWeight: 700, color }}>{value}</Text>
      <Text variant="small" style={{ color: '#605e5c', textAlign: 'center' }}>{label}</Text>
    </Stack>
  );
}
