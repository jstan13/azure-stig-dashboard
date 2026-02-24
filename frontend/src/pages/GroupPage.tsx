import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  DetailsList, DetailsListLayoutMode, SelectionMode, IColumn,
  DefaultButton, PrimaryButton,
} from '@fluentui/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../hooks/useApi';
import ComplianceBadge from '../components/ComplianceBadge';
import type { GroupCompliance, ControlRollup } from '../types';

export default function GroupPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<GroupCompliance | null>(null);
  const [allGroups, setAllGroups] = useState<{ resourceGroupName: string; machineCount: number; avgComplianceScore: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await api.get<any>(`/api/groups/${id}/compliance`);
        if (id === 'all') {
          setAllGroups(res.data.data || []);
        } else {
          setData(res.data);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  async function bulkExport(format: 'ckl' | 'json' | 'csv') {
    if (!data?.machines) return;
    setExporting(true);
    // Export each machine in the group
    for (const m of data.machines) {
      try {
        const res = await api.post('/api/export/checklist', { machineId: m.id, format }, { responseType: 'blob' });
        const extMap = { ckl: '.ckl', json: '.json', csv: '.csv' };
        const url = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${m.name}${extMap[format]}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch { /* skip failed exports */ }
    }
    setExporting(false);
  }

  const machineColumns: IColumn[] = [
    {
      key: 'name', name: 'Machine', minWidth: 180,
      onRender: (m: any) => <a href="#" style={{ color: '#0078d4' }} onClick={(e) => { e.preventDefault(); navigate(`/machines/${m.id}`); }}>{m.name}</a>,
    },
    { key: 'score', name: 'Compliance', minWidth: 100, onRender: (m: any) => <ComplianceBadge score={m.complianceScore} /> },
    { key: 'scan', name: 'Last Scan', minWidth: 140, onRender: (m: any) => m.lastScanDate ? new Date(m.lastScanDate).toLocaleString() : 'Never' },
  ];

  const controlColumns: IColumn[] = [
    { key: 'stigId', name: 'Rule', fieldName: 'stigId', minWidth: 110 },
    { key: 'title', name: 'Title', minWidth: 240, isResizable: true, onRender: (c: ControlRollup) => <span title={c.title}>{c.title?.slice(0, 60)}…</span> },
    { key: 'sev', name: 'Sev', fieldName: 'severity', minWidth: 60 },
    { key: 'open', name: 'Open', fieldName: 'open', minWidth: 60 },
    { key: 'naf', name: 'Pass', fieldName: 'not_a_finding', minWidth: 60 },
    { key: 'na', name: 'N/A', fieldName: 'not_applicable', minWidth: 60 },
    { key: 'nr', name: 'Unreviewed', fieldName: 'not_reviewed', minWidth: 80 },
    { key: 'total', name: 'Total', fieldName: 'total', minWidth: 60 },
  ];

  const allGroupColumns: IColumn[] = [
    {
      key: 'rg', name: 'Resource Group', minWidth: 180,
      onRender: (g: any) => <a href="#" style={{ color: '#0078d4' }} onClick={(e) => { e.preventDefault(); navigate(`/groups/${g.resourceGroupName}`); }}>{g.resourceGroupName}</a>,
    },
    { key: 'cnt', name: 'Machines', fieldName: 'machineCount', minWidth: 80 },
    { key: 'score', name: 'Avg Compliance', minWidth: 120, onRender: (g: any) => <ComplianceBadge score={g.avgComplianceScore} /> },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading…" style={{ marginTop: 80 }} />;
  if (error) return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;

  // "All groups" view
  if (id === 'all') {
    return (
      <Stack tokens={{ childrenGap: 20 }}>
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>All Resource Groups</Text>
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
          <DetailsList items={allGroups} columns={allGroupColumns} layoutMode={DetailsListLayoutMode.justified} selectionMode={SelectionMode.none} />
        </div>
      </Stack>
    );
  }

  if (!data) return null;

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center">
        <Stack>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>Group: {data.resourceGroupName}</Text>
          <Text style={{ color: '#605e5c' }}>{data.machineCount} machines — avg compliance{' '}<strong>{data.avgComplianceScore}%</strong></Text>
        </Stack>
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          <DefaultButton text="Back" iconProps={{ iconName: 'Back' }} onClick={() => navigate('/groups/all')} />
          <PrimaryButton
            text={exporting ? 'Exporting…' : 'Bulk Export .ckl'}
            disabled={exporting}
            iconProps={{ iconName: 'Download' }}
            onClick={() => bulkExport('ckl')}
          />
        </Stack>
      </Stack>

      {/* Bar chart of control failures */}
      {data.controls && data.controls.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 24 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 16 }}>Top Failing Controls</Text>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.controls.filter((c) => c.open > 0).slice(0, 10)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="stigId" tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="open" name="Open" fill="#d13438" />
              <Bar dataKey="not_a_finding" name="Pass" fill="#107c10" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Machines */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
        <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 12 }}>Machines</Text>
        <DetailsList items={data.machines || []} columns={machineColumns} layoutMode={DetailsListLayoutMode.justified} selectionMode={SelectionMode.none} compact />
      </div>

      {/* Control rollup */}
      {data.controls && (
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 12 }}>Control Rollup</Text>
          <DetailsList items={data.controls} columns={controlColumns} layoutMode={DetailsListLayoutMode.justified} selectionMode={SelectionMode.none} compact />
        </div>
      )}
    </Stack>
  );
}
