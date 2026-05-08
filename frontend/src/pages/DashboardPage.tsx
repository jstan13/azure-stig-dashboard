/**
 * Executive Overview Dashboard
 *
 * Top row:    8 real KPIs sourced from /api/hierarchy/kpis
 * Second row: per-tenant tiles (avg score + CAT I/II/III + drill-in link)
 * Third row:  Compliance donut + Per-machine bar chart
 * Fourth row: Severity heat-map (RG x CAT)
 * Bottom:     Recent scans table
 *
 * Designed so an executive can see the global posture in one screen, while
 * an operator can click any tile to drill into the Cloud Explorer or a
 * specific machine.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  PrimaryButton, DefaultButton, DetailsList, DetailsListLayoutMode,
  SelectionMode, IColumn,
} from '@fluentui/react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { api } from '../hooks/useApi';
import ComplianceDonut from '../components/ComplianceDonut';
import ComplianceBadge from '../components/ComplianceBadge';
import SeverityHeatmap from '../components/SeverityHeatmap';
import type { Scan } from '../types';

interface Rollup {
  total: number; open: number;
  catIOpen: number; catIIOpen: number; catIIIOpen: number;
  notAFinding: number; notApplicable: number; notReviewed: number;
}
interface Kpis {
  tenantCount: number; subscriptionCount: number; resourceGroupCount: number;
  machineCount: number; avgComplianceScore: number; machinesBelow80: number;
  rollup: Rollup; lastScanAt: string | null;
}
interface TenantSummary {
  id: string; name: string; subscriptionCount: number; machineCount: number;
  avgScore: number; rollup: Rollup;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [kpis,    setKpis]    = useState<Kpis | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [machines, setMachines] = useState<any[]>([]);
  const [scans,   setScans]   = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [kRes, hRes, mRes, sRes] = await Promise.all([
          api.get<Kpis>('/api/hierarchy/kpis'),
          api.get<{ tenants: TenantSummary[] }>('/api/hierarchy'),
          api.get<{ data: any[] }>('/api/machines?pageSize=100'),
          api.get<{ data: Scan[] }>('/api/scan?pageSize=10'),
        ]);
        setKpis(kRes.data);
        setTenants(hRes.data.tenants);
        setMachines(mRes.data.data);
        setScans(sRes.data.data);
      } catch (e: any) {
        setError(e?.message || 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function triggerFullScan() {
    setScanning(true); setScanMessage(null);
    try {
      const res = await api.post('/api/scan/trigger', {});
      setScanMessage(`OK Scan started (ID: ${res.data.scanId})`);
    } catch (e: any) {
      setScanMessage(`X Scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading dashboard..." style={{ marginTop: 80 }} />;
  if (error)   return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;
  if (!kpis)   return null;

  const scanColumns: IColumn[] = [
    { key: 'type',    name: 'Type',          fieldName: 'scanType',     minWidth: 80 },
    { key: 'status',  name: 'Status',        fieldName: 'status',       minWidth: 80 },
    { key: 'open',    name: 'Open Findings', fieldName: 'openFindings', minWidth: 100 },
    { key: 'started', name: 'Started',       minWidth: 140, onRender: (item: Scan) => item.startedAt ? new Date(item.startedAt).toLocaleString() : '-' },
  ];

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      {/* Header */}
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap tokens={{ childrenGap: 8 }}>
        <Stack>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>Compliance Overview</Text>
          <Text style={{ color: '#605e5c' }}>
            {kpis.tenantCount} tenant{kpis.tenantCount === 1 ? '' : 's'}
            {' . '}{kpis.subscriptionCount} subscription{kpis.subscriptionCount === 1 ? '' : 's'}
            {' . '}{kpis.resourceGroupCount} resource group{kpis.resourceGroupCount === 1 ? '' : 's'}
            {' . '}{kpis.machineCount} machines
            {kpis.lastScanAt && <>{' . last scan '}{new Date(kpis.lastScanAt).toLocaleString()}</>}
          </Text>
        </Stack>
        <Stack horizontal tokens={{ childrenGap: 8 }} verticalAlign="center">
          {scanMessage && (
            <MessageBar
              messageBarType={scanMessage.startsWith('OK') ? MessageBarType.success : MessageBarType.error}
              styles={{ root: { maxWidth: 360 } }}
            >
              {scanMessage}
            </MessageBar>
          )}
          <DefaultButton text="Cloud Explorer" iconProps={{ iconName: 'AzureLogo' }} onClick={() => navigate('/explorer')} />
          <PrimaryButton text={scanning ? 'Scanning...' : 'Trigger Full Scan'} disabled={scanning} onClick={triggerFullScan} iconProps={{ iconName: 'Refresh' }} />
        </Stack>
      </Stack>

      {/* KPI strip */}
      <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
        <Kpi label="Avg compliance"     value={`${kpis.avgComplianceScore}%`} color={scoreColor(kpis.avgComplianceScore)} />
        <Kpi label="Machines"            value={kpis.machineCount} />
        <Kpi label="Below 80%"           value={kpis.machinesBelow80} color={kpis.machinesBelow80 > 0 ? '#a4262c' : '#107c10'} onClick={() => navigate('/inventory')} />
        <Kpi label="CAT I open"          value={kpis.rollup.catIOpen}   color="#a4262c" />
        <Kpi label="CAT II open"         value={kpis.rollup.catIIOpen}  color="#ca5010" />
        <Kpi label="CAT III open"        value={kpis.rollup.catIIIOpen} color="#605e5c" />
        <Kpi label="Tenants"             value={kpis.tenantCount}        onClick={() => navigate('/explorer')} />
        <Kpi label="Subscriptions"       value={kpis.subscriptionCount}  onClick={() => navigate('/explorer')} />
      </Stack>

      {/* Tenant tiles */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
        <Stack horizontal horizontalAlign="space-between" verticalAlign="center" style={{ marginBottom: 12 }}>
          <Text variant="large" style={{ fontWeight: 600 }}>Tenants</Text>
          <Text style={{ color: '#605e5c', fontSize: 12 }}>Multi-tenant rollup. Click a tile to drill in.</Text>
        </Stack>
        <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
          {tenants.map((t) => (
            <button
              key={t.id}
              onClick={() => navigate('/explorer')}
              style={{
                background: '#fafafa', border: '1px solid #edebe9', borderRadius: 8,
                padding: 16, minWidth: 260, textAlign: 'left', cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ms-Icon ms-Icon--AzureLogo" style={{ color: '#0078d4', fontSize: 18 }} />
                <span style={{ fontWeight: 600 }}>{t.name}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: scoreColor(t.avgScore) }}>{t.avgScore}%</span>
                <ComplianceBadge score={t.avgScore} />
              </div>
              <div style={{ color: '#605e5c', fontSize: 12, marginTop: 4 }}>
                {t.subscriptionCount} subs . {t.machineCount} machines
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <Pill color="#a4262c" label="I"   value={t.rollup.catIOpen}   />
                <Pill color="#ca5010" label="II"  value={t.rollup.catIIOpen}  />
                <Pill color="#605e5c" label="III" value={t.rollup.catIIIOpen} />
              </div>
            </button>
          ))}
        </Stack>
      </div>

      {/* Charts row */}
      <Stack horizontal tokens={{ childrenGap: 16 }} wrap>
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>Global findings</Text>
          <ComplianceDonut
            open={kpis.rollup.open}
            notAFinding={kpis.rollup.notAFinding}
            notApplicable={kpis.rollup.notApplicable}
            notReviewed={kpis.rollup.notReviewed}
            size={220}
          />
        </div>
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20, flex: 1, minWidth: 300 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 12 }}>Machine compliance</Text>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={machines}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={70} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <Tooltip formatter={(v: any) => [`${v}%`, 'Score']} />
              <Bar dataKey="complianceScore" name="Score" fill="#0078d4" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Stack>

      {/* Severity heat-map */}
      <SeverityHeatmap />

      {/* Recent scans */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
        <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 12 }}>Recent scans</Text>
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

function scoreColor(score: number): string {
  if (score >= 90) return '#107c10';
  if (score >= 80) return '#498205';
  if (score >= 60) return '#835b00';
  return '#a4262c';
}

function Kpi({ label, value, color, onClick }: { label: string; value: number | string; color?: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        background: '#fff', border: '1px solid #edebe9', borderRadius: 8,
        padding: '14px 20px', minWidth: 140, textAlign: 'left',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, color: color || '#0078d4' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#605e5c' }}>{label}</div>
    </button>
  );
}

function Pill({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span style={{
      background: value > 0 ? color : '#f3f2f1',
      color: value > 0 ? '#fff' : '#8a8886',
      borderRadius: 10, padding: '2px 10px', fontSize: 11, fontWeight: 600,
    }}>
      CAT {label} . {value}
    </span>
  );
}
