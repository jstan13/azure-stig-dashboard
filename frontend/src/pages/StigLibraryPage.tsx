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
  ComboBox,
  IComboBoxOption,
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

interface ImportStatus {
  running: boolean;
  jobId?: string;
  results?: Array<{ skipped: boolean; error?: string }>;
  error?: string;
}

interface CatalogResponse {
  data: Array<{ title: string; version: string; releaseDate: string }>;
  total: number;
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
  const [catalogOptions, setCatalogOptions] = useState<IComboBoxOption[]>([]);
  const [selectedCatalogTitles, setSelectedCatalogTitles] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [activeImportJobId, setActiveImportJobId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!activeImportJobId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await api.get<ImportStatus>('/api/stigs/import/status');
        if (cancelled || res.data.jobId !== activeImportJobId || res.data.running) return;

        setActiveImportJobId(null);
        setActionBusy(false);
        if (res.data.error) {
          setActionMessage(`Error: ${res.data.error}`);
        } else {
          const imported = res.data.results?.filter((result) => !result.skipped && !result.error).length ?? 0;
          setActionMessage(`Import complete. ${imported} STIG benchmark(s) updated.`);
          await load();
        }
      } catch (e: any) {
        if (!cancelled) {
          setActiveImportJobId(null);
          setActionBusy(false);
          setActionMessage(`Error: Unable to read import status: ${e.message}`);
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeImportJobId, load]);

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

  async function openImportDialog() {
    setImportDialogOpen(true);
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await api.get<CatalogResponse>('/api/stigs/catalog');
      setCatalogOptions(res.data.data.map((entry) => ({
        key: entry.title,
        text: entry.version && entry.version !== entry.title
          ? `${entry.title} (${entry.version})`
          : entry.title,
      })));
    } catch (e: any) {
      setCatalogError(e.message);
    } finally {
      setCatalogLoading(false);
    }
  }

  async function handleImport(benchmarkTitles?: string[]) {
    setImportDialogOpen(false);
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await api.post<{ jobId: string }>('/api/stigs/import', {
        benchmarkTitles: benchmarkTitles?.length ? benchmarkTitles : undefined,
      });
      setActiveImportJobId(res.data.jobId);
      setSelectedCatalogTitles([]);
      setActionMessage('Import started. Progress is being monitored in the background.');
    } catch (e: any) {
      setActionBusy(false);
      setActionMessage(`Error: ${e.message}`);
    }
  }

  const commandItems: ICommandBarItemProps[] = [
    {
      key: 'updateCheck',
      text: 'Check for Updates',
      iconProps: { iconName: 'Refresh' },
      disabled: actionBusy,
      onClick: () => void handleUpdateCheck(),
    },
    {
      key: 'import',
      text: 'Import STIGs',
      iconProps: { iconName: 'Download' },
      disabled: actionBusy,
      onClick: () => void openImportDialog(),
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
          title: 'Import STIGs',
          subText:
            'This will discover and download the latest manual STIG packages from the Cyber.mil document library and import them into the database. ' +
            'The process runs in the background and may take a while depending on the number of releases and network speed. Continue?',
        }}
      >
        {catalogLoading && <Spinner label="Loading current Cyber.mil catalog..." />}
        {catalogError && <MessageBar messageBarType={MessageBarType.error}>{catalogError}</MessageBar>}
        {!catalogLoading && !catalogError && (
          <ComboBox
            label="STIGs to import"
            placeholder="Type to find and select one or more STIGs"
            options={catalogOptions}
            selectedKey={selectedCatalogTitles}
            multiSelect
            autoComplete="on"
            useComboBoxAsMenuWidth
            onChange={(_event, option) => {
              if (!option) return;
              const title = String(option.key);
              setSelectedCatalogTitles((current) => option.selected
                ? [...current, title]
                : current.filter((value) => value !== title));
            }}
          />
        )}
        <DialogFooter>
          <PrimaryButton
            text={`Import Selected (${selectedCatalogTitles.length})`}
            onClick={() => void handleImport(selectedCatalogTitles)}
            disabled={actionBusy || catalogLoading || selectedCatalogTitles.length === 0}
          />
          <DefaultButton
            text={`Import All (${catalogOptions.length})`}
            onClick={() => void handleImport()}
            disabled={actionBusy || catalogLoading || catalogOptions.length === 0}
          />
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
