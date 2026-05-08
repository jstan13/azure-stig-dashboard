/**
 * Cloud Explorer — Azure-portal-style tenant > subscription > resource group >
 * machine drill-down tree, with rolled-up compliance scores at every level
 * and a CAT I/II/III badge stack.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Stack, Text, SearchBox, Spinner, SpinnerSize, MessageBar, MessageBarType,
  IconButton,
} from '@fluentui/react';
import { api } from '../hooks/useApi';
import ComplianceBadge from '../components/ComplianceBadge';

// ── types from /api/hierarchy ────────────────────────────────────────────────
interface Rollup {
  total: number; open: number;
  catIOpen: number; catIIOpen: number; catIIIOpen: number;
  notAFinding: number; notApplicable: number; notReviewed: number;
}
interface MachineNode {
  id: string; name: string; osType: string; osVersion?: string;
  location: string; status: string; complianceScore: number;
  lastScanDate?: string; resourceId: string; rollup: Rollup;
}
interface RGNode {
  name: string; machineCount: number; avgScore: number;
  rollup: Rollup; machines: MachineNode[];
}
interface SubNode {
  id: string; name: string; machineCount: number; avgScore: number;
  rollup: Rollup; resourceGroups: RGNode[];
}
interface TenantNode {
  id: string; name: string; subscriptionCount: number; machineCount: number;
  avgScore: number; rollup: Rollup; subscriptions: SubNode[];
}

// ── small reusable severity-pill cluster ─────────────────────────────────────
function CatPills({ rollup, compact = false }: { rollup: Rollup; compact?: boolean }) {
  const Pill = (label: string, count: number, color: string) =>
    count > 0 ? (
      <span
        key={label}
        style={{
          background: color, color: '#fff', borderRadius: 10,
          padding: compact ? '1px 7px' : '2px 10px',
          fontSize: compact ? 10 : 11, fontWeight: 600,
          marginLeft: 4, whiteSpace: 'nowrap',
        }}
        title={`${label}: ${count} open`}
      >
        {label} {count}
      </span>
    ) : null;
  return (
    <span>
      {Pill('CAT I',   rollup.catIOpen,   '#a4262c')}
      {Pill('CAT II',  rollup.catIIOpen,  '#ca5010')}
      {Pill('CAT III', rollup.catIIIOpen, '#605e5c')}
    </span>
  );
}

// ── icon helpers (Fluent icon font) ──────────────────────────────────────────
const Icon = ({ name, size = 14, color = '#605e5c', mr = 6 }: any) => (
  <i className={`ms-Icon ms-Icon--${name}`} style={{ fontSize: size, color, marginRight: mr }} aria-hidden="true" />
);

export default function CloudExplorerPage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [filter,  setFilter]  = useState('');
  const [expandedTenants, setExpandedTenants] = useState<Set<string>>(new Set());
  const [expandedSubs,    setExpandedSubs]    = useState<Set<string>>(new Set());
  const [expandedRGs,     setExpandedRGs]     = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ tenants: TenantNode[] }>('/api/hierarchy');
        setTenants(res.data.tenants);
        // expand all tenants by default — execs see everything at a glance
        setExpandedTenants(new Set(res.data.tenants.map((t) => t.id)));
        // expand single-subscription tenants automatically
        const subAuto = new Set<string>();
        res.data.tenants.forEach((t) => {
          if (t.subscriptions.length === 1) subAuto.add(`${t.id}/${t.subscriptions[0].id}`);
        });
        setExpandedSubs(subAuto);
      } catch (e: any) {
        setError(e?.message || 'Failed to load hierarchy');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  const expandAll = () => {
    const t = new Set<string>(); const s = new Set<string>(); const r = new Set<string>();
    tenants.forEach((tn) => {
      t.add(tn.id);
      tn.subscriptions.forEach((sb) => {
        s.add(`${tn.id}/${sb.id}`);
        sb.resourceGroups.forEach((rg) => r.add(`${tn.id}/${sb.id}/${rg.name}`));
      });
    });
    setExpandedTenants(t); setExpandedSubs(s); setExpandedRGs(r);
  };
  const collapseAll = () => {
    setExpandedTenants(new Set()); setExpandedSubs(new Set()); setExpandedRGs(new Set());
  };

  // simple substring filter — show any branch that contains a match
  const matches = (s?: string) => !filter || (s || '').toLowerCase().includes(filter.toLowerCase());
  const filteredTenants = useMemo(() => {
    if (!filter) return tenants;
    return tenants
      .map((t) => {
        const subs = t.subscriptions.map((s) => {
          const rgs = s.resourceGroups.map((rg) => {
            const ms = rg.machines.filter((m) =>
              matches(m.name) || matches(m.osVersion) || matches(m.location) || matches(rg.name) ||
              matches(s.name) || matches(t.name),
            );
            return { ...rg, machines: ms };
          }).filter((rg) => rg.machines.length > 0 || matches(rg.name));
          return { ...s, resourceGroups: rgs };
        }).filter((s) => s.resourceGroups.length > 0 || matches(s.name));
        return { ...t, subscriptions: subs };
      })
      .filter((t) => t.subscriptions.length > 0 || matches(t.name));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants, filter]);

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading cloud hierarchy…" style={{ marginTop: 60 }} />;
  if (error)   return <MessageBar messageBarType={MessageBarType.error}>{error}</MessageBar>;

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" wrap tokens={{ childrenGap: 8 }}>
        <Stack>
          <Text variant="xxLarge" style={{ fontWeight: 700 }}>Cloud Explorer</Text>
          <Text style={{ color: '#605e5c' }}>
            Tenant → Subscription → Resource Group → Machine. Expand to drill in; click a machine for full STIG findings.
          </Text>
        </Stack>
        <Stack horizontal tokens={{ childrenGap: 8 }} verticalAlign="center">
          <SearchBox
            placeholder="Filter by name, OS, region…"
            value={filter}
            onChange={(_e, v) => setFilter(v || '')}
            onClear={() => setFilter('')}
            styles={{ root: { width: 280 } }}
          />
          <IconButton iconProps={{ iconName: 'ExploreContent' }} title="Expand all"   onClick={expandAll}   />
          <IconButton iconProps={{ iconName: 'CollapseContent' }} title="Collapse all" onClick={collapseAll} />
        </Stack>
      </Stack>

      {filteredTenants.length === 0 && (
        <MessageBar messageBarType={MessageBarType.info}>No tenants match this filter.</MessageBar>
      )}

      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
        {filteredTenants.map((t) => {
          const tOpen = expandedTenants.has(t.id);
          return (
            <div key={t.id}>
              {/* ── Tenant row ───────────────────────────────────────────── */}
              <Row
                indent={0}
                onClick={() => toggle(expandedTenants, t.id, setExpandedTenants)}
                expanded={tOpen}
                icon={<Icon name="AzureLogo" size={18} color="#0078d4" />}
                title={t.name}
                subtitle={`Tenant ID: ${t.id}`}
                rightCells={[
                  <span key="subs">{t.subscriptionCount} subs</span>,
                  <span key="m">{t.machineCount} machines</span>,
                  <ComplianceBadge key="b" score={t.avgScore} />,
                  <CatPills key="p" rollup={t.rollup} />,
                ]}
              />
              {tOpen && t.subscriptions.map((s) => {
                const sKey = `${t.id}/${s.id}`;
                const sOpen = expandedSubs.has(sKey);
                return (
                  <div key={sKey}>
                    <Row
                      indent={1}
                      onClick={() => toggle(expandedSubs, sKey, setExpandedSubs)}
                      expanded={sOpen}
                      icon={<Icon name="Database" size={16} color="#0078d4" />}
                      title={s.name}
                      subtitle={s.id}
                      rightCells={[
                        <span key="m">{s.machineCount} machines</span>,
                        <ComplianceBadge key="b" score={s.avgScore} />,
                        <CatPills key="p" rollup={s.rollup} />,
                      ]}
                    />
                    {sOpen && s.resourceGroups.map((rg) => {
                      const rKey = `${t.id}/${s.id}/${rg.name}`;
                      const rOpen = expandedRGs.has(rKey);
                      return (
                        <div key={rKey}>
                          <Row
                            indent={2}
                            onClick={() => toggle(expandedRGs, rKey, setExpandedRGs)}
                            expanded={rOpen}
                            icon={<Icon name="ResourceGroup" size={16} color="#605e5c" />}
                            title={rg.name}
                            subtitle={`${rg.machineCount} machine${rg.machineCount === 1 ? '' : 's'}`}
                            rightCells={[
                              <ComplianceBadge key="b" score={rg.avgScore} />,
                              <CatPills key="p" rollup={rg.rollup} compact />,
                            ]}
                            onTitleClick={() => navigate(`/groups/${encodeURIComponent(rg.name)}`)}
                          />
                          {rOpen && rg.machines.map((m) => (
                            <Row
                              key={m.id}
                              indent={3}
                              icon={<Icon name={m.osType === 'Linux' ? 'PenWorkspace' : 'Server'} size={14} color="#0078d4" />}
                              title={m.name}
                              subtitle={`${m.osType} • ${m.osVersion || ''} • ${m.location}`}
                              onTitleClick={() => navigate(`/machines/${m.id}`)}
                              rightCells={[
                                <span key="s" style={{ color: m.status === 'online' ? '#107c10' : '#a4262c' }}>● {m.status}</span>,
                                <ComplianceBadge key="b" score={m.complianceScore} />,
                                <CatPills key="p" rollup={m.rollup} compact />,
                              ]}
                              isLeaf
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Stack>
  );
}

// ── Row component (used for every level so styling stays consistent) ─────────
function Row({
  indent, icon, title, subtitle, rightCells,
  expanded, onClick, onTitleClick, isLeaf,
}: {
  indent: number;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  rightCells: React.ReactNode[];
  expanded?: boolean;
  onClick?: () => void;
  onTitleClick?: () => void;
  isLeaf?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center',
        padding: '8px 12px',
        paddingLeft: 12 + indent * 24,
        borderTop: indent === 0 ? '1px solid #edebe9' : '1px solid #f3f2f1',
        cursor: onClick ? 'pointer' : 'default',
        background: indent === 0 ? '#faf9f8' : '#fff',
      }}
      onClick={onClick}
      onMouseEnter={(e) => { e.currentTarget.style.background = indent === 0 ? '#f3f2f1' : '#fafafa'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = indent === 0 ? '#faf9f8' : '#fff'; }}
    >
      <span style={{ width: 18, textAlign: 'center' }}>
        {!isLeaf && (
          <i className={`ms-Icon ms-Icon--${expanded ? 'ChevronDown' : 'ChevronRight'}`} style={{ fontSize: 10, color: '#605e5c' }} />
        )}
      </span>
      {icon}
      <div
        style={{ flex: 1, minWidth: 0 }}
        onClick={(e) => { if (onTitleClick) { e.stopPropagation(); onTitleClick(); } }}
      >
        <div
          style={{
            fontWeight: indent <= 1 ? 600 : 500, fontSize: 13,
            color: onTitleClick ? '#0078d4' : '#201f1e',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            cursor: onTitleClick ? 'pointer' : 'inherit',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11, color: '#8a8886', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        )}
      </div>
      <Stack horizontal tokens={{ childrenGap: 12 }} verticalAlign="center" styles={{ root: { fontSize: 12 } }}>
        {rightCells.map((c, i) => <span key={i}>{c}</span>)}
      </Stack>
    </div>
  );
}
