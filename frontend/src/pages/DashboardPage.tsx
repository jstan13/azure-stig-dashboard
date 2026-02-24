/**
 * Overview Dashboard Page
 *
 * Shows:
 *  - Global compliance score (donut chart)
 *  - Recent scans
 *  - Top failing controls (bar chart)
 *  - Machine inventory quick view
 */

import { useEffect, useState } from 'react';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  PrimaryButton, DefaultButton, DetailsList, DetailsListLayoutMode,
  SelectionMode, IColumn,
} from '@fluentui/react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { api } from '../hooks/useApi';
import ComplianceDonut from '../components/ComplianceDonut';
import ComplianceBadge from '../components/ComplianceBadge';
import type { Machine, Scan, Finding } from '../types';

export default function DashboardPage() {
  const navigate = useNavigate();

  const [machines, setMachines] = useState<Machine[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [mRes, sRes] = await Promise.all([
          api.get<{ data: Machine[] }>('/api/machines?pageSize=100'),
          api.get<{ data: Scan[] }>('/api/scan?pageSize=10'),
        ]);
        setMachines(mRes.data.data);
        setScans(sRes.data.data);
      } catch (e: any) {
        setError(e.message || 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Derived global stats
  const totalMachines = machines.length;
  const avgScore = totalMachines
    ? Math.round(machines.reduce((s, m) => s + m.complianceScore, 0) / totalMachines)
    : 0;

  // Simulate global finding counts from machine scores (approximation)
  const openCount = machines.filter((m) => m.complianceScore < 80).length * 2;
  const passingCount = machines.filter((m) => m.complianceScore >= 80).length * 3;

  async function triggerFullScan() {
    setScanning(true);
    setScanMessage(null);
    try {
      const res = await api.post('/api/scan/trigger', {});
      setScanMessage(`✓ Scan started (ID: ${res.data.scanId})`);
    } catch (e: any) {
      setScanMessage(`✗ Scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }

  const machineColumns: IColumn[] = [
    { key: 'name', name: 'Machine', fieldName: 'name', minWidth: 160, onRender: (item: Machine) => <a href="#" onClick={() => navigate(`/machines/${item.id}`)}>{item.name}</a> },
    { key: 'rg', name: 'Resource Group', fieldName: 'resourceGroupName', minWidth: 120 },
    { key: 'os', name: 'OS', fieldName: 'osType', minWidth: 80 },
    { key: 'score', name: 'Compliance', minWidth: 90, onRender: (item: Machine) => <ComplianceBadge score={item.complianceScore} /> },
    { key: 'scan', name: 'Last Scan', minWidth: 140, onRender: (item: Machine) => item.lastScanDate ? new Date(item.lastScanDate).toLocaleString() : 'Never' },
  ];

  const scanColumns: IColumn[] = [
    { key: 'type', name: 'Type', fieldName: 'scanType', minWidth: 80 },
    { key: 'status', name: 'Status', fieldName: 'status', minWidth: 80 },
    { key: 'open', name: 'Open Findings', fieldName: 'openFindings', minWidth: 100 },
    { key: 'started', name: 'Started', minWidth: 140, onRender: (item: Scan) => item.startedAt ? new Date(item.startedAt).toLocaleString() : '-' },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading dashboard…" style={{ marginTop: 80 }} />;
  if (error) return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;

  return (
    <Stack tokens={{ childrenGap: 24 }}>
      {/* Header */}
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center">
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>Overview</Text>
        <Stack horizontal tokens={{ childrenGap: 8 }}>
          {scanMessage && (
            <MessageBar messageBarType={scanMessage.startsWith('✓') ? MessageBarType.success : MessageBarType.error} styles={{ root: { maxWidth: 380 } }}>
              {scanMessage}
            </MessageBar>
          )}
          <PrimaryButton text={scanning ? 'Scanning…' : 'Trigger Full Scan'} disabled={scanning} onClick={triggerFullScan} iconProps={{ iconName: 'Refresh' }} />
        </Stack>
      </Stack>

      {/* KPI cards */}
      <Stack horizontal tokens={{ childrenGap: 16 }} wrap>
        {[
          { label: 'Total Machines', value: totalMachines, color: '#0078d4' },
          { label: 'Avg Compliance', value: `${avgScore}%`, color: avgScore >= 80 ? '#107c10' : avgScore >= 60 ? '#835b00' : '#a4262c' },
          { label: 'Recent Scans', value: scans.length, color: '#8a8886' },
        ].map((kpi) => (
          <div key={kpi.label} style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: '20px 28px', minWidth: 160 }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
            <div style={{ color: '#605e5c', fontSize: 13 }}>{kpi.label}</div>
          </div>
        ))}
      </Stack>

      {/* Charts row */}
      <Stack horizontal tokens={{ childrenGap: 24 }} wrap>
        {/* Compliance donut */}
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 24 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>Global Compliance</Text>
          <ComplianceDonut
            open={openCount}
            notAFinding={passingCount}
            notApplicable={0}
            notReviewed={0}
            size={240}
          />
        </div>

        {/* Compliance bar chart per machine */}
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 24, flex: 1, minWidth: 300 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 16 }}>Per-Machine Score</Text>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={machines} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <Tooltip formatter={(v) => [`${v}%`, 'Score']} />
              <Bar dataKey="complianceScore" name="Score" fill="#0078d4" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Stack>

      {/* Machine table */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 24 }}>
        <Stack horizontal horizontalAlign="space-between" verticalAlign="center" style={{ marginBottom: 16 }}>
          <Text variant="large" style={{ fontWeight: 600 }}>Machines</Text>
          <DefaultButton text="View all" onClick={() => navigate('/inventory')} />
        </Stack>
        <DetailsList
          items={machines.slice(0, 5)}
          columns={machineColumns}
          layoutMode={DetailsListLayoutMode.justified}
          selectionMode={SelectionMode.none}
          compact
        />
      </div>

      {/* Recent scans table */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 24 }}>
        <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 16 }}>Recent Scans</Text>
        <DetailsList
          items={scans.slice(0, 5)}
          columns={scanColumns}
          layoutMode={DetailsListLayoutMode.justified}
          selectionMode={SelectionMode.none}
          compact
        />
      </div>
    </Stack>
  );
}
