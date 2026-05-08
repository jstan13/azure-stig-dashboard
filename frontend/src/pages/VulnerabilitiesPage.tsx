/**
 * Vulnerabilities page — CVE-class findings from Microsoft Defender for Cloud
 * Servers Plan 2 (Microsoft Defender Vulnerability Management). Distinct from
 * STIG findings; this is the ACAS/Tenable equivalent native to Azure.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Stack, Text, SearchBox, Spinner, SpinnerSize, MessageBar, MessageBarType,
  PrimaryButton, DefaultButton, Dropdown, Toggle, IDropdownOption,
  DetailsList, DetailsListLayoutMode, SelectionMode, IColumn, Link as FluentLink,
} from '@fluentui/react';
import { api } from '../hooks/useApi';

interface Vuln {
  id: string; machineId: string; cve: string | null; title: string;
  description?: string; severity: string; cvssScore?: number;
  status: string; exploitAvailable: boolean;
  productName?: string; productVendor?: string; productVersion?: string;
  remediation?: string; firstDetectedAt?: string; lastDetectedAt?: string;
}
interface Summary {
  total: number; open: number; critical: number; high: number;
  medium: number; low: number; exploitable: number;
  uniqueCves: number; affectedHosts: number;
}

const sevColor = (s: string) => ({
  critical: '#a4262c', high: '#ca5010', medium: '#835b00',
  low: '#605e5c', informational: '#8a8886',
}[s as any] || '#605e5c');

export default function VulnerabilitiesPage() {
  const [rows, setRows] = useState<Vuln[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const [filter,        setFilter]        = useState('');
  const [sevFilter,     setSevFilter]     = useState<string | undefined>();
  const [statusFilter,  setStatusFilter]  = useState<string | undefined>('open');
  const [exploitOnly,   setExploitOnly]   = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [list, sum] = await Promise.all([
        api.get<{ data: Vuln[] }>('/api/vulnerabilities?limit=500'),
        api.get<Summary>('/api/vulnerabilities/summary'),
      ]);
      setRows(list.data.data);
      setSummary(sum.data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load vulnerabilities');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    try {
      await api.post('/api/vulnerabilities/sync', {});
      await load();
    } catch (e: any) {
      setError(e?.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function changeStatus(id: string, status: string) {
    try {
      await api.patch(`/api/vulnerabilities/${id}`, { status });
      await load();
    } catch (e: any) {
      setError(e?.message || 'Update failed');
    }
  }

  const filtered = useMemo(() => rows.filter((v) => {
    if (sevFilter && v.severity !== sevFilter) return false;
    if (statusFilter && v.status !== statusFilter) return false;
    if (exploitOnly && !v.exploitAvailable) return false;
    if (filter) {
      const hay = `${v.title} ${v.cve || ''} ${v.productName || ''} ${v.machineId}`.toLowerCase();
      if (!hay.includes(filter.toLowerCase())) return false;
    }
    return true;
  }), [rows, filter, sevFilter, statusFilter, exploitOnly]);

  const columns: IColumn[] = [
    { key: 'sev', name: 'Severity', minWidth: 90, onRender: (v: Vuln) => (
      <span style={{ background: sevColor(v.severity), color: '#fff', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
        {v.severity.toUpperCase()}{v.cvssScore ? ` ${v.cvssScore.toFixed(1)}` : ''}
      </span>
    ) },
    { key: 'cve', name: 'CVE', minWidth: 140, onRender: (v: Vuln) => v.cve ? (
      <FluentLink href={`https://nvd.nist.gov/vuln/detail/${v.cve}`} target="_blank">{v.cve}</FluentLink>
    ) : <span style={{ color: '#8a8886' }}>—</span> },
    { key: 'title', name: 'Title', fieldName: 'title', minWidth: 240, isMultiline: true },
    { key: 'product', name: 'Product', minWidth: 160, onRender: (v: Vuln) => (
      <span>{v.productName || '—'}{v.productVersion ? ` ${v.productVersion}` : ''}</span>
    ) },
    { key: 'machine', name: 'Machine', fieldName: 'machineId', minWidth: 140 },
    { key: 'expl', name: 'Exploit', minWidth: 70, onRender: (v: Vuln) => v.exploitAvailable
      ? <span style={{ color: '#a4262c', fontWeight: 600 }}>● known</span>
      : <span style={{ color: '#8a8886' }}>—</span> },
    { key: 'status', name: 'Status', minWidth: 130, onRender: (v: Vuln) => (
      <Dropdown
        selectedKey={v.status}
        options={[
          { key: 'open',           text: 'Open' },
          { key: 'mitigated',      text: 'Mitigated' },
          { key: 'risk_accepted',  text: 'Risk accepted' },
          { key: 'false_positive', text: 'False positive' },
        ]}
        onChange={(_e, opt) => opt && changeStatus(v.id, String(opt.key))}
        styles={{ root: { width: 140 } }}
      />
    ) },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading vulnerabilities…" style={{ marginTop: 80 }} />;

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap tokens={{ childrenGap: 8 }}>
        <Stack>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>Vulnerabilities</Text>
          <Text style={{ color: '#605e5c' }}>
            CVE findings from Microsoft Defender Vulnerability Management. Independent of STIG findings — both datasets are correlated by machine.
          </Text>
        </Stack>
        <PrimaryButton text={syncing ? 'Syncing…' : 'Sync from Defender'} disabled={syncing} onClick={sync} iconProps={{ iconName: 'CloudDownload' }} />
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError(null)}>{error}</MessageBar>}

      {summary && (
        <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
          <Kpi label="Open"          value={summary.open} />
          <Kpi label="Critical"      value={summary.critical}    color="#a4262c" onClick={() => setSevFilter('critical')} />
          <Kpi label="High"          value={summary.high}        color="#ca5010" onClick={() => setSevFilter('high')} />
          <Kpi label="Medium"        value={summary.medium}      color="#835b00" onClick={() => setSevFilter('medium')} />
          <Kpi label="Low"           value={summary.low}         color="#605e5c" onClick={() => setSevFilter('low')} />
          <Kpi label="Exploitable"   value={summary.exploitable} color="#a4262c" onClick={() => setExploitOnly(true)} />
          <Kpi label="Unique CVEs"   value={summary.uniqueCves} />
          <Kpi label="Affected hosts"value={summary.affectedHosts} />
        </Stack>
      )}

      <Stack horizontal tokens={{ childrenGap: 12 }} wrap verticalAlign="end">
        <SearchBox placeholder="Filter by CVE, title, product, machine…" value={filter} onChange={(_e, v) => setFilter(v || '')} onClear={() => setFilter('')} styles={{ root: { width: 320 } }} />
        <Dropdown label="Severity" selectedKey={sevFilter} placeholder="(any)"
          options={[{ key: '', text: '(any)' }, ...['critical','high','medium','low','informational'].map((k) => ({ key: k, text: k })) as IDropdownOption[]]}
          onChange={(_e, o) => setSevFilter(o?.key ? String(o.key) : undefined)}
          styles={{ root: { width: 140 } }}
        />
        <Dropdown label="Status" selectedKey={statusFilter} placeholder="(any)"
          options={[{ key: '', text: '(any)' }, ...['open','mitigated','risk_accepted','false_positive'].map((k) => ({ key: k, text: k })) as IDropdownOption[]]}
          onChange={(_e, o) => setStatusFilter(o?.key ? String(o.key) : undefined)}
          styles={{ root: { width: 160 } }}
        />
        <Toggle label="Exploit available only" checked={exploitOnly} onChange={(_e, c) => setExploitOnly(!!c)} />
        <DefaultButton text="Reset" onClick={() => { setFilter(''); setSevFilter(undefined); setStatusFilter('open'); setExploitOnly(false); }} />
      </Stack>

      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
        <DetailsList
          items={filtered}
          columns={columns}
          layoutMode={DetailsListLayoutMode.justified}
          selectionMode={SelectionMode.none}
          compact
        />
        {!filtered.length && <div style={{ padding: 24, color: '#605e5c' }}>No vulnerabilities match.</div>}
      </div>
    </Stack>
  );
}

function Kpi({ label, value, color, onClick }: { label: string; value: number; color?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} disabled={!onClick} style={{
      background: '#fff', border: '1px solid #edebe9', borderRadius: 8,
      padding: '12px 18px', minWidth: 120, textAlign: 'left',
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || '#0078d4' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#605e5c' }}>{label}</div>
    </button>
  );
}
