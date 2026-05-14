import { useEffect, useState, useCallback } from 'react';
import {
  Stack,
  Text,
  SearchBox,
  Spinner,
  SpinnerSize,
  MessageBar,
  MessageBarType,
  DetailsList,
  DetailsListLayoutMode,
  SelectionMode,
  IColumn,
  DefaultButton,
  PrimaryButton,
  Dialog,
  DialogType,
  DialogFooter,
  CommandBar,
  ICommandBarItemProps,
  Pivot,
  PivotItem,
  TooltipHost,
  Icon,
} from '@fluentui/react';
import { useNavigate } from 'react-router-dom';
import { api } from '../hooks/useApi';

interface StigBenchmark {
  benchmarkId: string;
  title: string;
  category: string;
  platform: string;
  latestInstalledVersion: string | null;
  latestAvailableVersion: string | null;
  updateAvailable: boolean;
  lastContentUpdate: string | null;
  active: boolean;
  versions?: StigVersionSummary[];
}

interface StigVersionSummary {
  version: string;
  benchmarkDate: string;
  ruleCount: number;
  catICount: number;
  catIICount: number;
  catIIICount: number;
  status: 'active' | 'superseded' | 'pending' | 'error';
}

interface UpdateCheckStatus {
  running: boolean;
  lastRun?: string;
  results?: Array<{
    benchmarkId: string;
    title: string;
    installedVersion: string | null;
    availableVersion: string | null;
    updateAvailable: boolean;
  }>;
  error?: string;
}

const categoryColor: Record<string, string> = {
  'Operating System': '#0078d4',
  'Browser':          '#107c10',
  'Application':      '#d83b01',
  'Network Device':   '#5c2d91',
  'Database':         '#ca5010',
};

export default function StigLibraryPage() {
  const navigate = useNavigate();

  const [benchmarks, setBenchmarks] = useState<StigBenchmark[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: StigBenchmark[]; total: number }>('/api/stigs');
      setBenchmarks(res.data.data);
      setTotal(res.data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const pollUpdateStatus = useCallback(async () => {
    try {
      const res = await api.get<UpdateCheckStatus>('/api/stigs/update-check/status');
      setUpdateStatus(res.data);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    load();
    pollUpdateStatus();
  }, [load, pollUpdateStatus]);

  const filtered = benchmarks.filter((b) => {
    if (!q) return true;
    const lower = q.toLowerCase();
    return (
      b.title.toLowerCase().includes(lower) ||
      b.benchmarkId.toLowerCase().includes(lower) ||
      b.category.toLowerCase().includes(lower)
    );
  });

  async function handleUpdateCheck() {
    setActionBusy(true);
    setActionMessage(null);
    try {
      await api.post('/api/stigs/update-check', {});
      setActionMessage('Update check started — results will appear below shortly.');
      setTimeout(pollUpdateStatus, 3000);
    } catch (e: any) {
      setActionMessage(`Error: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleImportAll() {
    setImportDialogOpen(false);
    setActionBusy(true);
    setActionMessage(null);
    try {
      await api.post('/api/stigs/import', {});
      setActionMessage('Import triggered — this runs in the background and may take several minutes.');
    } catch (e: any) {
      setActionMessage(`Error: ${e.message}`);
    } finally {
      setActionBusy(false);
    }
  }

  const commandItems: ICommandBarItemProps[] = [
    {
      key: 'updateCheck',
      text: 'Check for Updates',
      iconProps: { iconName: 'Refresh' },
      disabled: actionBusy,
      onClick: handleUpdateCheck,
    },
    {
      key: 'import',
      text: 'Import All STIGs',
      iconProps: { iconName: 'Download' },
      disabled: actionBusy,
      onClick: () => setImportDialogOpen(true),
    },
  ];

  const columns: IColumn[] = [
    {
      key: 'title',
      name: 'STIG Title',
      minWidth: 280,
      isResizable: true,
      onRender: (item: StigBenchmark) => (
        <a
          href="#"
          style={{ color: '#0078d4', fontWeight: 600 }}
          onClick={(e) => { e.preventDefault(); navigate(`/stigs/${item.benchmarkId}`); }}
        >
          {item.title}
        </a>
      ),
    },
    {
      key: 'category',
      name: 'Category',
      minWidth: 140,
      isResizable: true,
      onRender: (item: StigBenchmark) => (
        <span
          style={{
            background: categoryColor[item.category] ?? '#605e5c',
            color:       '#fff',
            padding:     '2px 8px',
            borderRadius: 4,
            fontSize:    12,
          }}
        >
          {item.category}
        </span>
      ),
    },
    {
      key: 'version',
      name: 'Installed Version',
      minWidth: 130,
      onRender: (item: StigBenchmark) => (
        <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 6 }}>
          <Text>{item.latestInstalledVersion ?? '—'}</Text>
          {item.updateAvailable && (
            <TooltipHost content={`Update available: ${item.latestAvailableVersion}`}>
              <Icon iconName="Warning" style={{ color: '#d83b01', fontSize: 14 }} />
            </TooltipHost>
          )}
        </Stack>
      ),
    },
    {
      key: 'available',
      name: 'Available',
      minWidth: 100,
      onRender: (item: StigBenchmark) => item.latestAvailableVersion ?? '—',
    },
    {
      key: 'updated',
      name: 'Last Updated',
      minWidth: 120,
      onRender: (item: StigBenchmark) =>
        item.lastContentUpdate ? new Date(item.lastContentUpdate).toLocaleDateString() : '—',
    },
    {
      key: 'actions',
      name: '',
      minWidth: 80,
      onRender: (item: StigBenchmark) => (
        <DefaultButton
          text="Detail"
          iconProps={{ iconName: 'OpenInNewWindow' }}
          styles={{ root: { height: 24, fontSize: 12 } }}
          onClick={() => navigate(`/stigs/${item.benchmarkId}`)}
        />
      ),
    },
  ];

  const updatesAvailable = benchmarks.filter((b) => b.updateAvailable);

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Text variant="xxLarge" style={{ fontWeight: 700 }}>STIG Library</Text>

      {/* Summary cards */}
      <Stack horizontal tokens={{ childrenGap: 16 }}>
        <SummaryCard label="Installed STIGs"   value={total}                        color="#0078d4" />
        <SummaryCard label="Updates Available" value={updatesAvailable.length}      color="#d83b01" />
        <SummaryCard label="Auto-Update"       value={import.meta.env.MODE === 'production' ? 'Quarterly' : 'Dev'} color="#107c10" />
      </Stack>

      {updatesAvailable.length > 0 && (
        <MessageBar messageBarType={MessageBarType.warning}>
          {updatesAvailable.length} STIG{updatesAvailable.length > 1 ? 's have' : ' has'} updates available.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); setImportDialogOpen(true); }}>
            Import now
          </a>
        </MessageBar>
      )}

      {actionMessage && (
        <MessageBar
          messageBarType={actionMessage.startsWith('Error') ? MessageBarType.error : MessageBarType.success}
          onDismiss={() => setActionMessage(null)}
        >
          {actionMessage}
        </MessageBar>
      )}

      <CommandBar items={commandItems} />

      <SearchBox
        placeholder="Search by title, ID, or category…"
        value={q}
        onChange={(_e, v) => setQ(v || '')}
        onClear={() => setQ('')}
        styles={{ root: { maxWidth: 400 } }}
      />

      {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}

      {loading ? (
        <Spinner size={SpinnerSize.large} label="Loading STIG library…" />
      ) : (
        <DetailsList
          items={filtered}
          columns={columns}
          layoutMode={DetailsListLayoutMode.justified}
          selectionMode={SelectionMode.none}
          isHeaderVisible
        />
      )}

      {/* Update check results panel */}
      {updateStatus?.results && (
        <Stack tokens={{ childrenGap: 8 }}>
          <Text variant="large" style={{ fontWeight: 600 }}>
            Update Check Results{' '}
            {updateStatus.lastRun && (
              <span style={{ fontWeight: 400, fontSize: 13, color: '#605e5c' }}>
                (as of {new Date(updateStatus.lastRun).toLocaleString()})
              </span>
            )}
          </Text>
          {updateStatus.results
            .filter((r) => r.updateAvailable)
            .map((r) => (
              <MessageBar key={r.benchmarkId} messageBarType={MessageBarType.warning}>
                <strong>{r.title}</strong>: {r.installedVersion ?? 'not installed'} → {r.availableVersion}
              </MessageBar>
            ))}
          {updateStatus.results.every((r) => !r.updateAvailable) && (
            <MessageBar messageBarType={MessageBarType.success}>All STIGs are up to date.</MessageBar>
          )}
        </Stack>
      )}

      {/* Import confirmation dialog */}
      <Dialog
        hidden={!importDialogOpen}
        onDismiss={() => setImportDialogOpen(false)}
        dialogContentProps={{
          type: DialogType.normal,
          title: 'Import All STIGs',
          subText:
            'This will download the latest STIG content from DISA public.cyber.mil and import it into the database. ' +
            'The process runs in the background and may take 5–15 minutes depending on network speed. Continue?',
        }}
      >
        <DialogFooter>
          <PrimaryButton text="Import" onClick={handleImportAll} disabled={actionBusy} />
          <DefaultButton text="Cancel" onClick={() => setImportDialogOpen(false)} />
        </DialogFooter>
      </Dialog>
    </Stack>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <Stack
      style={{
        background: '#fff',
        border:     '1px solid #edebe9',
        borderRadius: 8,
        padding:    '16px 24px',
        minWidth:   160,
        boxShadow:  '0 1px 3px rgba(0,0,0,.08)',
      }}
    >
      <Text style={{ fontSize: 28, fontWeight: 700, color }}>{value}</Text>
      <Text style={{ color: '#605e5c', fontSize: 13 }}>{label}</Text>
    </Stack>
  );
}
