import { useEffect, useState } from 'react';
import {
  Stack, Text, SearchBox, Spinner, SpinnerSize, MessageBar, MessageBarType,
  DetailsList, DetailsListLayoutMode, SelectionMode, IColumn, Toggle,
} from '@fluentui/react';
import { useNavigate } from 'react-router-dom';
import { api } from '../hooks/useApi';
import ComplianceBadge from '../components/ComplianceBadge';
import type { Machine, PaginatedResponse } from '../types';

export default function InventoryPage() {
  const navigate = useNavigate();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOnlyOpen, setShowOnlyOpen] = useState(false);

  async function load(query = '') {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (query) params.set('q', query);
      const res = await api.get<PaginatedResponse<Machine>>(`/api/machines?${params}`);
      setMachines(res.data.data);
      setTotal(res.data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = showOnlyOpen ? machines.filter((m) => m.complianceScore < 80) : machines;

  const columns: IColumn[] = [
    {
      key: 'name', name: 'Machine Name', fieldName: 'name', minWidth: 180, isResizable: true,
      onRender: (item: Machine) => (
        <a href="#" style={{ color: '#0078d4' }} onClick={(e) => { e.preventDefault(); navigate(`/machines/${item.id}`); }}>
          {item.name}
        </a>
      ),
    },
    { key: 'rg', name: 'Resource Group', fieldName: 'resourceGroupName', minWidth: 120, isResizable: true },
    { key: 'location', name: 'Location', fieldName: 'location', minWidth: 80 },
    { key: 'os', name: 'OS', minWidth: 160, isResizable: true, onRender: (item: Machine) => `${item.osType} — ${item.osVersion || ''}` },
    { key: 'status', name: 'Status', fieldName: 'status', minWidth: 70 },
    { key: 'score', name: 'Compliance', minWidth: 100, onRender: (item: Machine) => <ComplianceBadge score={item.complianceScore} /> },
    { key: 'scan', name: 'Last Scan', minWidth: 140, onRender: (item: Machine) => item.lastScanDate ? new Date(item.lastScanDate).toLocaleString() : 'Never' },
  ];

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Text variant="xxLarge" style={{ fontWeight: 700 }}>Machine Inventory</Text>

      <Stack horizontal tokens={{ childrenGap: 16 }} verticalAlign="end">
        <SearchBox
          placeholder="Search name or resource group…"
          value={q}
          onChange={(_e, v) => setQ(v || '')}
          onSearch={(v) => load(v)}
          onClear={() => load('')}
          styles={{ root: { width: 320 } }}
        />
        <Toggle
          label="Only non-compliant"
          checked={showOnlyOpen}
          onChange={(_e, v) => setShowOnlyOpen(!!v)}
          inlineLabel
        />
        <Text style={{ color: '#605e5c' }}>{filtered.length} of {total} machines</Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}
      {loading ? (
        <Spinner size={SpinnerSize.large} label="Loading…" />
      ) : (
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
          <DetailsList
            items={filtered}
            columns={columns}
            layoutMode={DetailsListLayoutMode.justified}
            selectionMode={SelectionMode.none}
          />
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#605e5c' }}>No machines found.</div>
          )}
        </div>
      )}
    </Stack>
  );
}
