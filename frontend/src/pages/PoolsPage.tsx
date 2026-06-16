/**
 * Asset Pools page.
 *
 * Pools are role-based groups of machines (Domain Controllers, Web Servers,
 * Build Servers…) that let a manual STIG answer be authored once and inherited
 * by every member. This page manages pools and their membership; pool answers
 * themselves are authored from a machine's finding editor ("Apply to all
 * machines in a pool"). Platform-wide scopes are shown for reference.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  DetailsList, DetailsListLayoutMode, SelectionMode, IColumn,
  PrimaryButton, DefaultButton, Panel, PanelType, TextField, Dropdown,
  IDropdownOption, Label,
} from '@fluentui/react';
import { api } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';
import ComplianceBadge from '../components/ComplianceBadge';
import type { Machine, PaginatedResponse } from '../types';

interface PoolRollup {
  total: number; open: number;
  catIOpen: number; catIIOpen: number; catIIIOpen: number;
  notAFinding: number; notApplicable: number; notReviewed: number;
}

interface Pool {
  id: string;
  name: string;
  description?: string | null;
  role?: string | null;
  selectionMode: 'explicit' | 'tag';
  status: string;
  memberCount: number;
  explicitMemberCount: number;
  answerCount: number;
  avgScore: number;
  rollup: PoolRollup;
}

interface PoolMember {
  id: string;
  name: string;
  osType: string;
  osVersion?: string;
  resourceGroupName: string;
  isArcConnected: boolean;
  complianceScore: number;
  membership: 'explicit' | 'tag';
}

function CatPills({ rollup }: { rollup: PoolRollup }) {
  const Pill = (label: string, count: number, color: string) =>
    count > 0 ? (
      <span key={label} title={`${label}: ${count} open`} style={{
        background: color, color: '#fff', borderRadius: 10,
        padding: '1px 8px', fontSize: 11, fontWeight: 600, marginRight: 4, whiteSpace: 'nowrap',
      }}>{label} {count}</span>
    ) : null;
  return (
    <span>
      {Pill('CAT I', rollup.catIOpen, '#a4262c')}
      {Pill('CAT II', rollup.catIIOpen, '#ca5010')}
      {Pill('CAT III', rollup.catIIIOpen, '#605e5c')}
      {rollup.catIOpen + rollup.catIIOpen + rollup.catIIIOpen === 0 && (
        <span style={{ color: '#107c10', fontSize: 12 }}>No open findings</span>
      )}
    </span>
  );
}

interface PoolDetail extends Pool {
  members: PoolMember[];
  tagRule?: Record<string, string> | null;
}

interface PlatformRow {
  key: string;
  label: string;
  machineCount: number;
  answerCount: number;
}

export default function PoolsPage() {
  const navigate = useNavigate();
  const { has } = usePermissions();
  const canManage = has('collection:manage');
  const [pools, setPools] = useState<Pool[]>([]);
  const [platforms, setPlatforms] = useState<PlatformRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-pool panel
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Detail panel
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [addMachineId, setAddMachineId] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [poolsRes, platformsRes] = await Promise.all([
        api.get<{ data: Pool[] }>('/api/pools'),
        api.get<{ data: PlatformRow[] }>('/api/pools/platforms'),
      ]);
      setPools(poolsRes.data.data);
      setPlatforms(platformsRes.data.data);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function createPool() {
    if (!newName.trim()) { alert('Name is required'); return; }
    setSaving(true);
    try {
      await api.post('/api/pools', {
        name: newName.trim(),
        role: newRole.trim() || undefined,
        description: newDescription.trim() || undefined,
        selectionMode: 'explicit',
      });
      setCreating(false);
      setNewName(''); setNewRole(''); setNewDescription('');
      await load();
    } catch (e: any) {
      alert(`Create failed: ${e?.response?.data?.error || e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(poolId: string) {
    try {
      const [d, machinesRes] = await Promise.all([
        api.get<PoolDetail>(`/api/pools/${poolId}`),
        allMachines.length ? Promise.resolve(null) : api.get<PaginatedResponse<Machine>>('/api/machines?pageSize=500'),
      ]);
      if (machinesRes) setAllMachines(machinesRes.data.data);
      setDetail(d.data);
      setAddMachineId('');
    } catch (e: any) {
      alert(`Failed to load pool: ${e?.response?.data?.error || e.message}`);
    }
  }

  async function addMember() {
    if (!detail || !addMachineId) return;
    try {
      await api.post(`/api/pools/${detail.id}/members`, { machineIds: [addMachineId] });
      await openDetail(detail.id);
      await load();
    } catch (e: any) {
      alert(`Add failed: ${e?.response?.data?.error || e.message}`);
    }
  }

  async function removeMember(machineId: string) {
    if (!detail) return;
    try {
      await api.delete(`/api/pools/${detail.id}/members/${machineId}`);
      await openDetail(detail.id);
      await load();
    } catch (e: any) {
      alert(`Remove failed: ${e?.response?.data?.error || e.message}`);
    }
  }

  async function archivePool(poolId: string) {
    if (!confirm('Archive this pool? Membership is kept but the pool is hidden.')) return;
    try {
      await api.delete(`/api/pools/${poolId}`);
      setDetail(null);
      await load();
    } catch (e: any) {
      alert(`Archive failed: ${e?.response?.data?.error || e.message}`);
    }
  }

  const poolColumns: IColumn[] = [
    {
      key: 'name', name: 'Pool', minWidth: 200, isResizable: true,
      onRender: (p: Pool) => (
        <a href="#" style={{ color: '#0078d4' }} onClick={(e) => { e.preventDefault(); openDetail(p.id); }}>{p.name}</a>
      ),
    },
    { key: 'role', name: 'Role', minWidth: 140, onRender: (p: Pool) => p.role || '—' },
    { key: 'members', name: 'Machines', minWidth: 80, onRender: (p: Pool) => p.memberCount },
    {
      key: 'score', name: 'Avg Score', minWidth: 90,
      onRender: (p: Pool) => (p.memberCount ? <ComplianceBadge score={p.avgScore} size="small" /> : <span style={{ color: '#8a8886' }}>—</span>),
    },
    { key: 'findings', name: 'Open Findings', minWidth: 180, onRender: (p: Pool) => (p.memberCount ? <CatPills rollup={p.rollup} /> : <span style={{ color: '#8a8886' }}>—</span>) },
    { key: 'answers', name: 'Shared Answers', minWidth: 110, onRender: (p: Pool) => p.answerCount },
  ];

  const machineOptions: IDropdownOption[] = allMachines
    .filter((m) => !detail?.members.some((mem) => mem.id === m.id))
    .map((m) => ({ key: m.id, text: `${m.name} — ${m.resourceGroupName}` }));

  const memberColumns: IColumn[] = [
    {
      key: 'name', name: 'Machine', minWidth: 180, isResizable: true,
      onRender: (m: PoolMember) => (
        <a href="#" style={{ color: '#0078d4' }} onClick={(e) => { e.preventDefault(); navigate(`/machines/${m.id}`); }}>{m.name}</a>
      ),
    },
    {
      key: 'score', name: 'Score', minWidth: 80,
      onRender: (m: PoolMember) => <ComplianceBadge score={m.complianceScore ?? 0} size="small" />,
    },
    { key: 'os', name: 'OS', minWidth: 140, onRender: (m: PoolMember) => `${m.osType} — ${m.osVersion || ''}` },
    { key: 'rg', name: 'Resource Group', fieldName: 'resourceGroupName', minWidth: 140 },
    { key: 'arc', name: 'Platform', minWidth: 80, onRender: (m: PoolMember) => (m.isArcConnected ? 'Arc' : 'Azure') },
    { key: 'src', name: 'Via', minWidth: 70, onRender: (m: PoolMember) => m.membership },
    {
      key: 'remove', name: '', minWidth: 80,
      onRender: (m: PoolMember) => (
        canManage && m.membership === 'explicit'
          ? <DefaultButton text="Remove" styles={{ root: { height: 24, fontSize: 11 } }} onClick={() => removeMember(m.id)} />
          : null
      ),
    },
  ];

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading pools…" style={{ marginTop: 80 }} />;

  return (
    <Stack tokens={{ childrenGap: 20 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center">
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>Asset Pools</Text>
        {canManage && <PrimaryButton iconProps={{ iconName: 'Add' }} text="New Pool" onClick={() => setCreating(true)} />}
      </Stack>

      <Text style={{ color: '#605e5c' }}>
        Group machines by role so a manual STIG answer can be authored once and inherited by every
        member. Author answers from a machine's finding editor using “Apply to all machines in a pool”.
      </Text>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError(null)}>{error}</MessageBar>}

      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8 }}>
        <div style={{ padding: '16px 20px 0' }}>
          <Text variant="large" style={{ fontWeight: 600 }}>Pools ({pools.length})</Text>
        </div>
        {pools.length === 0
          ? <div style={{ padding: 20, color: '#605e5c' }}>No pools yet.{canManage ? ' Create one to get started.' : ''}</div>
          : <DetailsList items={pools} columns={poolColumns} layoutMode={DetailsListLayoutMode.justified} selectionMode={SelectionMode.none} />}
      </div>

      {/* Platforms summary */}
      <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: '16px 20px' }}>
        <Text variant="large" style={{ fontWeight: 600 }}>Platforms</Text>
        <Text style={{ display: 'block', color: '#605e5c', margin: '4px 0 12px' }}>
          Platform-wide answers apply to every machine on a platform. Author them from a finding editor using
          “Apply to all machines on platform”.
        </Text>
        <Stack horizontal wrap tokens={{ childrenGap: 12 }}>
          {platforms.map((p) => (
            <div key={p.key} style={{ border: '1px solid #edebe9', borderRadius: 6, padding: '10px 16px', minWidth: 160 }}>
              <Text style={{ fontWeight: 600 }}>{p.label}</Text>
              <Text style={{ display: 'block', color: '#605e5c', fontSize: 12 }}>{p.machineCount} machines · {p.answerCount} shared answers</Text>
            </div>
          ))}
          {platforms.length === 0 && <Text style={{ color: '#605e5c' }}>No machines discovered yet.</Text>}
        </Stack>
      </div>

      {/* Create panel */}
      <Panel
        isOpen={creating}
        onDismiss={() => setCreating(false)}
        type={PanelType.medium}
        headerText="New Asset Pool"
        isFooterAtBottom
        onRenderFooterContent={() => (
          <Stack horizontal tokens={{ childrenGap: 8 }}>
            <PrimaryButton text={saving ? 'Creating…' : 'Create'} disabled={saving} onClick={createPool} />
            <DefaultButton text="Cancel" onClick={() => setCreating(false)} />
          </Stack>
        )}
      >
        <Stack tokens={{ childrenGap: 14 }} style={{ padding: '16px 0' }}>
          <TextField label="Name" required value={newName} onChange={(_e, v) => setNewName(v || '')} placeholder="e.g. Domain Controllers" />
          <TextField label="Role" value={newRole} onChange={(_e, v) => setNewRole(v || '')} placeholder="e.g. Domain Controller" />
          <TextField label="Description" multiline rows={3} value={newDescription} onChange={(_e, v) => setNewDescription(v || '')} />
          <Text style={{ color: '#605e5c', fontSize: 12 }}>
            Machines are added explicitly after creation. Open the pool to add members.
          </Text>
        </Stack>
      </Panel>

      {/* Detail panel */}
      <Panel
        isOpen={!!detail}
        onDismiss={() => setDetail(null)}
        type={PanelType.large}
        headerText={detail?.name || 'Pool'}
      >
        {detail && (
          <Stack tokens={{ childrenGap: 16 }} style={{ padding: '16px 0' }}>
            <Stack horizontal horizontalAlign="space-between" verticalAlign="center">
              <Stack tokens={{ childrenGap: 2 }}>
                {detail.role && <Text style={{ color: '#605e5c' }}>Role: {detail.role}</Text>}
                <Text style={{ color: '#605e5c' }}>{detail.memberCount} machines · {detail.answerCount} shared answers · {detail.selectionMode} membership</Text>
              </Stack>
              {canManage && <DefaultButton text="Archive Pool" iconProps={{ iconName: 'Archive' }} onClick={() => archivePool(detail.id)} />}
            </Stack>
            {detail.description && <Text>{detail.description}</Text>}

            {detail.memberCount > 0 && (
              <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 12 }} style={{
                background: '#faf9f8', border: '1px solid #edebe9', borderRadius: 6, padding: '10px 16px',
              }}>
                <Text style={{ fontWeight: 600 }}>Pool posture</Text>
                <ComplianceBadge score={detail.avgScore} size="medium" />
                <CatPills rollup={detail.rollup} />
              </Stack>
            )}

            {canManage && (
              <Stack horizontal tokens={{ childrenGap: 8 }} verticalAlign="end">
                <Dropdown
                  label="Add a machine"
                  styles={{ root: { minWidth: 320 } }}
                  selectedKey={addMachineId}
                  options={machineOptions}
                  onChange={(_e, o) => setAddMachineId(o?.key as string)}
                  placeholder="Select a machine"
                />
                <PrimaryButton text="Add" disabled={!addMachineId} onClick={addMember} />
              </Stack>
            )}

            <div>
              <Label>Members ({detail.members.length})</Label>
              <DetailsList items={detail.members} columns={memberColumns} layoutMode={DetailsListLayoutMode.justified} selectionMode={SelectionMode.none} />
            </div>
          </Stack>
        )}
      </Panel>
    </Stack>
  );
}
