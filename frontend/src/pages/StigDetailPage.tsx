import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Stack,
  Text,
  Spinner,
  SpinnerSize,
  MessageBar,
  MessageBarType,
  DetailsList,
  DetailsListLayoutMode,
  SelectionMode,
  IColumn,
  SearchBox,
  Dropdown,
  IDropdownOption,
  CommandBar,
  ICommandBarItemProps,
  Pivot,
  PivotItem,
  Panel,
  PanelType,
  Separator,
  DefaultButton,
  PrimaryButton,
  TooltipHost,
  Icon,
  ProgressIndicator,
  Breadcrumb,
  IBreadcrumbItem,
} from '@fluentui/react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { api } from '../hooks/useApi';

interface StigBenchmarkDetail {
  benchmarkId: string;
  title: string;
  category: string;
  platform: string;
  latestInstalledVersion: string | null;
  latestAvailableVersion: string | null;
  lastContentUpdate: string | null;
  versions: StigVersionSummary[];
}

interface StigVersionSummary {
  id: string;
  version: string;
  benchmarkDate: string;
  ruleCount: number;
  catICount: number;
  catIICount: number;
  catIIICount: number;
  status: 'active' | 'superseded' | 'pending' | 'error';
}

interface Control {
  id: string;
  vulnId: string;
  ruleId: string;
  title: string;
  severity: string;
  checkType: string;
  checkContent?: string;
  fixText?: string;
  checkParameters?: Record<string, unknown>;
  ccis?: string[];
  stigVersionId: string;
}

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#a4262c',
  high:     '#d83b01',
  medium:   '#ca5010',
  low:      '#107c10',
  info:     '#605e5c',
};

const CHECK_TYPE_COLOR: Record<string, string> = {
  Registry:            '#0078d4',
  AuditPolicy:         '#5c2d91',
  UserRightsAssignment:'#107c10',
  SecurityOption:      '#d83b01',
  AccountPolicy:       '#ca5010',
  Service:             '#0099bc',
  WinEventLog:         '#8764b8',
  Manual:              '#605e5c',
};

const severityOptions: IDropdownOption[] = [
  { key: '', text: 'All Severities' },
  { key: 'high', text: 'CAT I (High)' },
  { key: 'medium', text: 'CAT II (Medium)' },
  { key: 'low', text: 'CAT III (Low)' },
];

const checkTypeOptions: IDropdownOption[] = [
  { key: '', text: 'All Check Types' },
  { key: 'Registry', text: 'Registry' },
  { key: 'AuditPolicy', text: 'Audit Policy' },
  { key: 'UserRightsAssignment', text: 'User Rights' },
  { key: 'SecurityOption', text: 'Security Option' },
  { key: 'AccountPolicy', text: 'Account Policy' },
  { key: 'Service', text: 'Service' },
  { key: 'WinEventLog', text: 'Event Log' },
  { key: 'Manual', text: 'Manual' },
];

export default function StigDetailPage() {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const navigate = useNavigate();

  const [benchmark, setBenchmark] = useState<StigBenchmarkDetail | null>(null);
  const [controls, setControls] = useState<Control[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('');
  const [checkType, setCheckType] = useState('');
  const [loading, setLoading] = useState(false);
  const [controlsLoading, setControlsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedControl, setSelectedControl] = useState<Control | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const PAGE_SIZE = 100;

  useEffect(() => {
    if (!benchmarkId) return;
    setLoading(true);
    api
      .get<StigBenchmarkDetail>(`/api/stigs/${benchmarkId}`)
      .then((res) => setBenchmark(res.data))
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [benchmarkId]);

  const loadControls = useCallback(async () => {
    if (!benchmarkId) return;
    setControlsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (q)         params.set('q', q);
      if (severity)  params.set('severity', severity);
      if (checkType) params.set('checkType', checkType);

      const res = await api.get<PaginatedResponse<Control>>(
        `/api/stigs/${benchmarkId}/controls?${params}`,
      );
      setControls(res.data.data);
      setTotal(res.data.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setControlsLoading(false);
    }
  }, [benchmarkId, page, q, severity, checkType]);

  useEffect(() => { loadControls(); }, [loadControls]);

  async function handleScan() {
    setScanBusy(true);
    setScanMessage(null);
    try {
      await api.post(`/api/stigs/${benchmarkId}/scan`, {});
      setScanMessage('Scan triggered — results will appear in machine findings as checks complete.');
    } catch (e: any) {
      setScanMessage(`Error: ${e.message}`);
    } finally {
      setScanBusy(false);
    }
  }

  const breadcrumbs: IBreadcrumbItem[] = [
    { text: 'STIG Library', key: 'library', onClick: () => navigate('/stigs') },
    { text: benchmark?.title ?? benchmarkId ?? '', key: 'detail' },
  ];

  // Coverage donut data
  const catData = benchmark
    ? (() => {
        const active = benchmark.versions.find((v) => v.status === 'active') ?? benchmark.versions[0];
        if (!active) return [];
        return [
          { name: 'CAT I (High)',   value: active.catICount,   color: '#a4262c' },
          { name: 'CAT II (Med)',   value: active.catIICount,  color: '#ca5010' },
          { name: 'CAT III (Low)', value: active.catIIICount, color: '#107c10' },
        ];
      })()
    : [];

  // Check type distribution
  const checkTypeData = controls.reduce<Record<string, number>>((acc, c) => {
    acc[c.checkType] = (acc[c.checkType] ?? 0) + 1;
    return acc;
  }, {});
  const ctChartData = Object.entries(checkTypeData).map(([name, value]) => ({ name, value, color: CHECK_TYPE_COLOR[name] ?? '#605e5c' }));

  const commandItems: ICommandBarItemProps[] = [
    {
      key: 'scan',
      text: 'Run Scan',
      iconProps: { iconName: 'PlaySolid' },
      disabled: scanBusy,
      onClick: () => { void handleScan(); },
    },
    {
      key: 'import',
      text: 'Re-import',
      iconProps: { iconName: 'Download' },
      onClick: () => {
        void api.post('/api/stigs/import', { benchmarkTitles: [benchmark?.title], force: true }).catch(console.error);
      },
    },
  ];

  const columns: IColumn[] = [
    {
      key: 'vulnId',
      name: 'Vuln ID',
      minWidth: 90,
      maxWidth: 100,
      onRender: (item: Control) => (
        <a href="#" style={{ color: '#0078d4' }} onClick={(e) => { e.preventDefault(); setSelectedControl(item); }}>
          {item.vulnId}
        </a>
      ),
    },
    {
      key: 'severity',
      name: 'CAT',
      minWidth: 60,
      maxWidth: 70,
      onRender: (item: Control) => (
        <span
          style={{
            background: SEVERITY_COLOR[item.severity] ?? '#605e5c',
            color: '#fff',
            padding: '2px 6px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {item.severity?.toUpperCase()}
        </span>
      ),
    },
    {
      key: 'checkType',
      name: 'Check Type',
      minWidth: 140,
      maxWidth: 160,
      onRender: (item: Control) => (
        <span
          style={{
            background: CHECK_TYPE_COLOR[item.checkType] ?? '#605e5c',
            color: '#fff',
            padding: '2px 6px',
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          {item.checkType}
        </span>
      ),
    },
    {
      key: 'title',
      name: 'Title',
      minWidth: 300,
      isResizable: true,
      onRender: (item: Control) => (
        <Text
          style={{ cursor: 'pointer', color: '#201f1e' }}
          onClick={() => setSelectedControl(item)}
        >
          {item.title}
        </Text>
      ),
    },
    {
      key: 'ccis',
      name: 'CCIs',
      minWidth: 80,
      onRender: (item: Control) =>
        item.ccis?.length ? (
          <TooltipHost content={item.ccis.join(', ')}>
            <Text style={{ color: '#0078d4' }}>{item.ccis.length} CCI</Text>
          </TooltipHost>
        ) : (
          '—'
        ),
    },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading benchmark…" />;
  if (error) return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;
  if (!benchmark) return null;

  const activeVersion = benchmark.versions.find((v) => v.status === 'active') ?? benchmark.versions[0];

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Breadcrumb items={breadcrumbs} />

      <Stack horizontal horizontalAlign="space-between" verticalAlign="start">
        <Stack tokens={{ childrenGap: 4 }}>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>{benchmark.title}</Text>
          <Text style={{ color: '#605e5c' }}>
            {benchmark.benchmarkId} · {benchmark.category} · {benchmark.platform}
          </Text>
          {benchmark.latestInstalledVersion && (
            <Text style={{ color: '#605e5c', fontSize: 13 }}>
              Installed: <strong>{benchmark.latestInstalledVersion}</strong>
              {benchmark.latestAvailableVersion &&
                benchmark.latestAvailableVersion !== benchmark.latestInstalledVersion && (
                  <span style={{ color: '#d83b01', marginLeft: 8 }}>
                    ⚠ Update available: {benchmark.latestAvailableVersion}
                  </span>
                )}
            </Text>
          )}
        </Stack>
        <CommandBar items={commandItems} />
      </Stack>

      {scanMessage && (
        <MessageBar
          messageBarType={scanMessage.startsWith('Error') ? MessageBarType.error : MessageBarType.success}
          onDismiss={() => setScanMessage(null)}
        >
          {scanMessage}
        </MessageBar>
      )}

      <Pivot>
        {/* ── Controls Tab ───────────────────────────────────────────── */}
        <PivotItem headerText={`Controls (${total})`} itemIcon="CheckList">
          <Stack tokens={{ childrenGap: 12 }} style={{ marginTop: 12 }}>
            <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
              <SearchBox
                placeholder="Search title, Vuln ID…"
                value={q}
                onChange={(_e, v) => { setQ(v || ''); setPage(1); }}
                onClear={() => { setQ(''); setPage(1); }}
                styles={{ root: { width: 280 } }}
              />
              <Dropdown
                placeholder="Severity"
                options={severityOptions}
                selectedKey={severity}
                onChange={(_e, opt) => { setSeverity(String(opt?.key ?? '')); setPage(1); }}
                styles={{ root: { width: 160 } }}
              />
              <Dropdown
                placeholder="Check Type"
                options={checkTypeOptions}
                selectedKey={checkType}
                onChange={(_e, opt) => { setCheckType(String(opt?.key ?? '')); setPage(1); }}
                styles={{ root: { width: 180 } }}
              />
              <Text style={{ color: '#605e5c', alignSelf: 'center' }}>
                {total} control{total !== 1 ? 's' : ''}
              </Text>
            </Stack>

            {controlsLoading ? (
              <Spinner size={SpinnerSize.medium} label="Loading controls…" />
            ) : (
              <DetailsList
                items={controls}
                columns={columns}
                layoutMode={DetailsListLayoutMode.justified}
                selectionMode={SelectionMode.none}
                isHeaderVisible
              />
            )}

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <Stack horizontal tokens={{ childrenGap: 8 }}>
                <DefaultButton
                  text="← Prev"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                />
                <Text style={{ alignSelf: 'center' }}>
                  Page {page} of {Math.ceil(total / PAGE_SIZE)}
                </Text>
                <DefaultButton
                  text="Next →"
                  disabled={page >= Math.ceil(total / PAGE_SIZE)}
                  onClick={() => setPage((p) => p + 1)}
                />
              </Stack>
            )}
          </Stack>
        </PivotItem>

        {/* ── Overview Tab ───────────────────────────────────────────── */}
        <PivotItem headerText="Overview" itemIcon="BarChartVertical">
          <Stack tokens={{ childrenGap: 24 }} style={{ marginTop: 16 }}>
            <Stack horizontal tokens={{ childrenGap: 32 }} wrap>
              {/* CAT Distribution Donut */}
              {catData.length > 0 && (
                <Stack tokens={{ childrenGap: 8 }}>
                  <Text variant="mediumPlus" style={{ fontWeight: 600 }}>
                    CAT Distribution ({activeVersion?.ruleCount ?? 0} rules)
                  </Text>
                  <ResponsiveContainer width={280} height={220}>
                    <PieChart>
                      <Pie
                        data={catData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={90}
                        paddingAngle={2}
                      >
                        {catData.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </Stack>
              )}

              {/* Check Type Distribution */}
              {ctChartData.length > 0 && (
                <Stack tokens={{ childrenGap: 8 }}>
                  <Text variant="mediumPlus" style={{ fontWeight: 600 }}>
                    Check Types
                  </Text>
                  <ResponsiveContainer width={280} height={220}>
                    <PieChart>
                      <Pie
                        data={ctChartData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={90}
                        paddingAngle={2}
                      >
                        {ctChartData.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </Stack>
              )}
            </Stack>

            {/* Version history */}
            <Stack tokens={{ childrenGap: 8 }}>
              <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Version History</Text>
              {benchmark.versions.map((v) => (
                <Stack
                  key={v.version}
                  horizontal
                  tokens={{ childrenGap: 16 }}
                  style={{
                    padding: '8px 12px',
                    background: v.status === 'active' ? '#f3f2f1' : '#fff',
                    border: '1px solid #edebe9',
                    borderRadius: 4,
                  }}
                >
                  <Text style={{ fontWeight: v.status === 'active' ? 700 : 400, minWidth: 50 }}>
                    {v.version}
                  </Text>
                  <Text style={{ color: '#605e5c', minWidth: 100 }}>
                    {new Date(v.benchmarkDate).toLocaleDateString()}
                  </Text>
                  <Text style={{ minWidth: 80 }}>{v.ruleCount} rules</Text>
                  <span
                    style={{
                      background: v.status === 'active' ? '#107c10' : '#605e5c',
                      color: '#fff',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                  >
                    {v.status}
                  </span>
                  {v.catICount > 0 && (
                    <Text style={{ color: '#a4262c' }}>{v.catICount} CAT I</Text>
                  )}
                </Stack>
              ))}
            </Stack>
          </Stack>
        </PivotItem>
      </Pivot>

      {/* ── Control Detail Panel ─────────────────────────────────────────── */}
      <Panel
        isOpen={!!selectedControl}
        onDismiss={() => setSelectedControl(null)}
        type={PanelType.medium}
        headerText={selectedControl ? `${selectedControl.vulnId} — ${selectedControl.title}` : ''}
        isLightDismiss
      >
        {selectedControl && <ControlDetailPanel control={selectedControl} />}
      </Panel>
    </Stack>
  );
}

function ControlDetailPanel({ control }: { control: Control }) {
  return (
    <Stack tokens={{ childrenGap: 16 }} style={{ padding: '0 0 24px' }}>
      {/* Metadata */}
      <Stack tokens={{ childrenGap: 4 }}>
        <LabelValue label="Rule ID"    value={control.ruleId} />
        <LabelValue label="Severity"   value={control.severity?.toUpperCase()} />
        <LabelValue label="Check Type" value={control.checkType} />
        {control.ccis?.length && (
          <LabelValue label="CCIs" value={control.ccis.join(', ')} />
        )}
      </Stack>

      <Separator />

      {/* Check Parameters (structured) */}
      {control.checkParameters && Object.keys(control.checkParameters).length > 0 && (
        <Stack tokens={{ childrenGap: 8 }}>
          <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Check Parameters</Text>
          <Stack
            style={{
              background: '#1e1e1e',
              color: '#d4d4d4',
              padding: 12,
              borderRadius: 4,
              fontFamily: 'Consolas, monospace',
              fontSize: 12,
              overflowX: 'auto',
            }}
          >
            <pre style={{ margin: 0 }}>
              {JSON.stringify(control.checkParameters, null, 2)}
            </pre>
          </Stack>
        </Stack>
      )}

      {/* Check content */}
      {control.checkContent && (
        <Stack tokens={{ childrenGap: 4 }}>
          <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Check Procedure</Text>
          <Text
            style={{
              background: '#f3f2f1',
              padding: 12,
              borderRadius: 4,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {control.checkContent}
          </Text>
        </Stack>
      )}

      {/* Fix text */}
      {control.fixText && (
        <Stack tokens={{ childrenGap: 4 }}>
          <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Fix</Text>
          <Text
            style={{
              background: '#f3f2f1',
              padding: 12,
              borderRadius: 4,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {control.fixText}
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

function LabelValue({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <Stack horizontal tokens={{ childrenGap: 8 }}>
      <Text style={{ fontWeight: 600, minWidth: 90, color: '#605e5c' }}>{label}:</Text>
      <Text>{value}</Text>
    </Stack>
  );
}
