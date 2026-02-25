/**
 * RMF / NIST SP 800-53 Crosswalk Page
 *
 * - NIST family heat map (open findings per family)
 * - Table: NIST control → finding count → drill-down
 * - CCI detail lookup panel
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Stack, Text, DetailsList, DetailsListLayoutMode, IColumn,
  SelectionMode, Spinner, SpinnerSize, MessageBar, MessageBarType,
  CommandBar, ICommandBarItemProps, Panel, PanelType, SearchBox,
  Icon, Pivot, PivotItem, mergeStyleSets, TooltipHost,
} from '@fluentui/react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { api } from '../hooks/useApi';

const classes = mergeStyleSets({
  familyCard: {
    background: '#f3f2f1',
    borderRadius: 8,
    padding: '10px 14px',
    minWidth: 130,
    cursor: 'pointer',
    borderBottom: '3px solid #0078d4',
    transition: 'box-shadow .15s',
    selectors: { ':hover': { boxShadow: '0 2px 8px rgba(0,0,0,.15)' } },
  },
  controlRow: { selectors: { ':hover': { background: '#f3f2f1 !important' } } },
});

const SEVERITY_COLOR = (n: number) => {
  if (n === 0) return '#107c10';
  if (n < 5)   return '#ca5010';
  return '#a4262c';
};

export default function RmfPage() {
  const [families, setFamilies]       = useState<any[]>([]);
  const [crosswalk, setCrosswalk]     = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [search, setSearch]           = useState('');
  const [selected, setSelected]       = useState<any | null>(null);
  const [panelOpen, setPanelOpen]     = useState(false);
  const [familyFilter, setFamilyFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [famRes, cwRes] = await Promise.all([
        api.get<any[]>('/api/rmf/families'),
        api.get<any[]>('/api/rmf/nist-crosswalk?status=open'),
      ]);
      setFamilies(famRes.data);
      setCrosswalk(cwRes.data);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const filtered = crosswalk.filter((c) => {
    const matchSearch = !search ||
      c.control.toLowerCase().includes(search.toLowerCase()) ||
      c.title.toLowerCase().includes(search.toLowerCase());
    const matchFamily = !familyFilter || c.control.startsWith(familyFilter);
    return matchSearch && matchFamily;
  });

  const columns: IColumn[] = [
    {
      key: 'control', name: 'NIST Control', minWidth: 100, maxWidth: 120,
      onRender: (c) => (
        <Text variant="small" style={{ fontWeight: 700, fontFamily: 'monospace' }}>{c.control}</Text>
      ),
    },
    {
      key: 'family', name: 'Family', minWidth: 80, maxWidth: 100,
      onRender: (c) => <Text variant="small">{c.control.split('-')[0]}</Text>,
    },
    {
      key: 'title', name: 'Control Title', minWidth: 220, isMultiline: false,
      onRender: (c) => (
        <TooltipHost content={c.title}>
          <Text variant="small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.title}
          </Text>
        </TooltipHost>
      ),
    },
    {
      key: 'findings', name: 'Open Findings', minWidth: 100, maxWidth: 120,
      onRender: (c) => {
        const n = c.findings?.length ?? 0;
        return (
          <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 6 }}>
            <Text variant="small" style={{ color: SEVERITY_COLOR(n), fontWeight: 600 }}>{n}</Text>
            <div style={{ height: 8, width: `${Math.min(n * 10, 80)}px`, background: SEVERITY_COLOR(n), borderRadius: 4 }} />
          </Stack>
        );
      },
    },
    {
      key: 'action', name: '', minWidth: 60, maxWidth: 70,
      onRender: (c) => (
        <Text
          variant="small"
          style={{ color: '#0078d4', cursor: 'pointer', textDecoration: 'underline' }}
          onClick={() => { setSelected(c); setPanelOpen(true); }}
        >
          Details
        </Text>
      ),
    },
  ];

  const commandItems: ICommandBarItemProps[] = [
    { key: 'refresh', text: 'Refresh', iconProps: { iconName: 'Refresh' }, onClick: load },
    { key: 'clearFilter', text: 'Clear Filter', iconProps: { iconName: 'ClearFilter' }, onClick: () => { setSearch(''); setFamilyFilter(''); } },
  ];

  // Sort families for chart
  const chartFamilies = [...families].sort((a, b) => b.open - a.open).slice(0, 15);

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Text variant="xLarge" style={{ fontWeight: 700 }}>RMF / NIST SP 800-53 Crosswalk</Text>
      <Text variant="small" style={{ color: '#605e5c' }}>
        Maps STIG controls to NIST SP 800-53 Rev 5 controls via DISA CCI identifiers.
      </Text>

      {error && <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>}

      {loading
        ? <Spinner size={SpinnerSize.large} label="Loading RMF data..." />
        : (
          <Pivot>
            {/* Heat map */}
            <PivotItem headerText="Family Heat Map">
              <Stack tokens={{ childrenGap: 16 }} style={{ paddingTop: 16 }}>
                <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Open Findings by NIST Control Family</Text>
                <Stack horizontal wrap tokens={{ childrenGap: 10 }}>
                  {families.map((f) => (
                    <div
                      key={f.family}
                      className={classes.familyCard}
                      style={{ borderBottomColor: SEVERITY_COLOR(f.open) }}
                      onClick={() => setFamilyFilter(f.family === familyFilter ? '' : f.family)}
                    >
                      <Text variant="large" style={{ fontWeight: 700, color: SEVERITY_COLOR(f.open) }}>{f.open}</Text>
                      <Text variant="xSmall" style={{ display: 'block', fontWeight: 700 }}>{f.family}</Text>
                      <Text variant="xSmall" style={{ color: '#605e5c' }}>{f.familyName}</Text>
                    </div>
                  ))}
                </Stack>

                <Text variant="mediumPlus" style={{ fontWeight: 600, marginTop: 8 }}>Top 15 Families by Open Findings</Text>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={chartFamilies} margin={{ left: 0, right: 16, top: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="family" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => [`${v} open findings`]} />
                    <Bar dataKey="open" name="Open Findings" radius={[3, 3, 0, 0]}>
                      {chartFamilies.map((f, i) => (
                        <Cell key={i} fill={SEVERITY_COLOR(f.open)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Stack>
            </PivotItem>

            {/* Control crosswalk table */}
            <PivotItem headerText="Control Crosswalk">
              <Stack tokens={{ childrenGap: 12 }} style={{ paddingTop: 12 }}>
                <Stack horizontal tokens={{ childrenGap: 12 }}>
                  <SearchBox
                    placeholder="Search control or title…"
                    value={search}
                    onChange={(_, v) => setSearch(v ?? '')}
                    styles={{ root: { width: 260 } }}
                  />
                  {familyFilter && (
                    <Text variant="small" style={{ background: '#0078d4', color: '#fff', padding: '4px 10px', borderRadius: 12, margin: 'auto 0' }}>
                      {familyFilter} <span style={{ cursor: 'pointer' }} onClick={() => setFamilyFilter('')}>✕</span>
                    </Text>
                  )}
                </Stack>
                <CommandBar items={commandItems} styles={{ root: { padding: 0 } }} />
                <DetailsList
                  items={filtered}
                  columns={columns}
                  layoutMode={DetailsListLayoutMode.justified}
                  selectionMode={SelectionMode.none}
                />
                {filtered.length === 0 && (
                  <Stack horizontalAlign="center" tokens={{ padding: 32 }}>
                    <Icon iconName="Compliance" style={{ fontSize: 48, color: '#c8c6c4' }} />
                    <Text variant="large" style={{ color: '#605e5c', marginTop: 8 }}>No matching controls</Text>
                  </Stack>
                )}
              </Stack>
            </PivotItem>
          </Pivot>
        )
      }

      {/* Detail Panel */}
      <Panel
        isOpen={panelOpen}
        onDismiss={() => setPanelOpen(false)}
        type={PanelType.medium}
        headerText={selected ? `${selected.control} — ${selected.title}` : ''}
        isLightDismiss
      >
        {selected && (
          <Stack tokens={{ childrenGap: 12 }} style={{ padding: '16px 0' }}>
            <Text variant="mediumPlus" style={{ fontWeight: 600 }}>Open Findings ({selected.findings?.length ?? 0})</Text>
            {(selected.findings ?? []).map((f: any, i: number) => (
              <Stack
                key={i}
                tokens={{ childrenGap: 4 }}
                style={{ background: '#f3f2f1', borderRadius: 6, padding: '8px 12px' }}
              >
                <Stack horizontal horizontalAlign="space-between">
                  <Text variant="small" style={{ fontWeight: 600 }}>{f.vulnId}</Text>
                  <Text variant="small" style={{ color: f.severity === 'high' ? '#a4262c' : f.severity === 'medium' ? '#ca5010' : '#107c10', fontWeight: 600 }}>
                    {f.severity === 'high' ? 'CAT I' : f.severity === 'medium' ? 'CAT II' : 'CAT III'}
                  </Text>
                </Stack>
                <Text variant="xSmall" style={{ color: '#605e5c' }}>{f.ruleTitle}</Text>
                <Text variant="xSmall" style={{ fontFamily: 'monospace', color: '#999' }}>Machine: {f.machineId}</Text>
              </Stack>
            ))}
          </Stack>
        )}
      </Panel>
    </Stack>
  );
}
