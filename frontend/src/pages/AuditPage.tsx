import { useEffect, useState } from 'react';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  DetailsList, DetailsListLayoutMode, SelectionMode, IColumn, SearchBox,
} from '@fluentui/react';
import { api } from '../hooks/useApi';
import type { AuditLog, PaginatedResponse } from '../types';

const ACTION_ICONS: Record<string, string> = {
  'scan.triggered':    '▶',
  'scan.completed':    '✓',
  'checklist.exported':'📥',
  'finding.updated':   '✏',
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState('');

  async function load(action = '') {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (action) params.set('action', action);
      const res = await api.get<PaginatedResponse<AuditLog>>(`/api/audit?${params}`);
      setLogs(res.data.data);
      setTotal(res.data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const columns: IColumn[] = [
    {
      key: 'timestamp', name: 'Time', minWidth: 150,
      onRender: (l: AuditLog) => new Date(l.timestamp).toLocaleString(),
    },
    {
      key: 'action', name: 'Action', minWidth: 160,
      onRender: (l: AuditLog) => (
        <span>
          {ACTION_ICONS[l.action] || '•'} <strong>{l.action}</strong>
        </span>
      ),
    },
    { key: 'actor', name: 'Actor', fieldName: 'actor', minWidth: 160 },
    { key: 'target', name: 'Target', minWidth: 200, onRender: (l: AuditLog) => `${l.targetType || ''} ${l.targetId || ''}` },
    {
      key: 'details', name: 'Details', minWidth: 220, isResizable: true,
      onRender: (l: AuditLog) => l.details ? (
        <span style={{ fontSize: 12, color: '#605e5c' }}>{JSON.stringify(l.details)}</span>
      ) : null,
    },
  ];

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Text variant="xxLarge" style={{ fontWeight: 700 }}>Audit & History</Text>

      <Stack horizontal tokens={{ childrenGap: 16 }} verticalAlign="end">
        <SearchBox
          placeholder="Filter by action (e.g. scan.triggered)…"
          value={filterAction}
          onChange={(_e, v) => setFilterAction(v || '')}
          onSearch={(v) => load(v)}
          onClear={() => load('')}
          styles={{ root: { width: 320 } }}
        />
        <Text style={{ color: '#605e5c' }}>{total} events</Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}

      {loading ? (
        <Spinner size={SpinnerSize.large} label="Loading…" />
      ) : (
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
          <DetailsList
            items={logs}
            columns={columns}
            layoutMode={DetailsListLayoutMode.justified}
            selectionMode={SelectionMode.none}
          />
          {logs.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#605e5c' }}>No audit events found.</div>
          )}
        </div>
      )}
    </Stack>
  );
}
