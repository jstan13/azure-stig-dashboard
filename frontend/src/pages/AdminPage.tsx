/**
 * Admin Page — manage authorization boundaries (Collections) and role
 * assignments (direct role bindings + Entra group→role mappings).
 *
 * Gated by `collection:manage` / `roles:assign`; the server re-checks every
 * call. These endpoints require a real database, so they are unavailable in
 * MOCK_MODE (the page surfaces that clearly).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Stack, Text, Pivot, PivotItem, DetailsList, IColumn, SelectionMode,
  MessageBar, MessageBarType, Spinner, SpinnerSize, PrimaryButton, DefaultButton,
  TextField, Dropdown, IDropdownOption, Toggle,
} from '@fluentui/react';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';
import { ROLES, ROLE_LABELS, type Role } from '../auth/permissions';

interface Collection { id: string; name: string; description: string | null; selectionMode: 'tag' | 'explicit'; status: string; tagRule: Record<string, string> | null; }
interface RoleBinding { id: string; subjectOid: string; collectionId: string | null; role: Role; grantedAt: string; }
interface GroupMapping { id: string; groupObjectId: string; groupDisplayName: string | null; role: Role; collectionId: string | null; }

const roleOptions: IDropdownOption[] = ROLES.map((r) => ({ key: r, text: ROLE_LABELS[r] }));

export default function AdminPage() {
  const api = useApi();
  const { has } = usePermissions();
  const canManageCollections = has('collection:manage');
  const canAssignRoles = has('roles:assign');

  const [collections, setCollections] = useState<Collection[]>([]);
  const [bindings, setBindings] = useState<RoleBinding[]>([]);
  const [mappings, setMappings] = useState<GroupMapping[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // ── collection create form ──
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [tagMode, setTagMode] = useState(false);
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

  // ── role binding form ──
  const [bSubject, setBSubject] = useState('');
  const [bRole, setBRole] = useState<Role>('auditor');
  const [bCollection, setBCollection] = useState<string>('');

  // ── group mapping form ──
  const [gId, setGId] = useState('');
  const [gName, setGName] = useState('');
  const [gRole, setGRole] = useState<Role>('auditor');
  const [gCollection, setGCollection] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const reqs: Promise<unknown>[] = [];
      if (canManageCollections) reqs.push(api.get<{ data: Collection[] }>('/api/collections').then((r) => setCollections(r.data.data)));
      if (canAssignRoles) {
        reqs.push(api.get<{ data: RoleBinding[] }>('/api/collections/role-bindings').then((r) => setBindings(r.data.data)));
        reqs.push(api.get<{ data: GroupMapping[] }>('/api/collections/group-mappings').then((r) => setMappings(r.data.data)));
      }
      await Promise.all(reqs);
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string });
      setError(msg.response?.data?.error ?? msg.message ?? 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, [api, canManageCollections, canAssignRoles]);

  useEffect(() => { void load(); }, [load]);

  const createCollection = async () => {
    try {
      const body: Record<string, unknown> = { name: newName, description: newDesc || undefined };
      if (tagMode) { body.selectionMode = 'tag'; body.tagRule = { [tagKey]: tagValue }; }
      await api.post('/api/collections', body);
      setNewName(''); setNewDesc(''); setTagKey(''); setTagValue(''); setTagMode(false);
      await load();
    } catch (e) { setError((e as { message?: string }).message ?? 'Create failed'); }
  };

  const archiveCollection = async (id: string) => {
    try { await api.delete(`/api/collections/${id}`); await load(); }
    catch (e) { setError((e as { message?: string }).message ?? 'Archive failed'); }
  };

  const createBinding = async () => {
    try {
      await api.post('/api/collections/role-bindings', {
        subjectOid: bSubject, role: bRole, collectionId: bCollection || null,
      });
      setBSubject(''); setBCollection('');
      await load();
    } catch (e) { setError((e as { message?: string }).message ?? 'Grant failed'); }
  };

  const revokeBinding = async (id: string) => {
    try { await api.delete(`/api/collections/role-bindings/${id}`); await load(); }
    catch (e) { setError((e as { message?: string }).message ?? 'Revoke failed'); }
  };

  const createMapping = async () => {
    try {
      await api.post('/api/collections/group-mappings', {
        groupObjectId: gId, groupDisplayName: gName || undefined, role: gRole, collectionId: gCollection || null,
      });
      setGId(''); setGName(''); setGCollection('');
      await load();
    } catch (e) { setError((e as { message?: string }).message ?? 'Map failed'); }
  };

  const deleteMapping = async (id: string) => {
    try { await api.delete(`/api/collections/group-mappings/${id}`); await load(); }
    catch (e) { setError((e as { message?: string }).message ?? 'Delete failed'); }
  };

  const collectionOptions: IDropdownOption[] = [
    { key: '', text: 'Global (all boundaries)' },
    ...collections.filter((c) => c.status === 'active').map((c) => ({ key: c.id, text: c.name })),
  ];
  const collectionName = (id: string | null) =>
    id ? (collections.find((c) => c.id === id)?.name ?? id) : 'Global';

  const collectionCols: IColumn[] = [
    { key: 'name', name: 'Name', minWidth: 160, onRender: (c: Collection) => <Text variant="small" style={{ fontWeight: 600 }}>{c.name}</Text> },
    { key: 'mode', name: 'Membership', minWidth: 120, onRender: (c: Collection) => <Text variant="small">{c.selectionMode === 'tag' ? `tag: ${Object.entries(c.tagRule ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'explicit'}</Text> },
    { key: 'status', name: 'Status', minWidth: 80, onRender: (c: Collection) => <Text variant="small">{c.status}</Text> },
    { key: 'actions', name: '', minWidth: 90, onRender: (c: Collection) => c.status === 'active' ? <DefaultButton text="Archive" onClick={() => archiveCollection(c.id)} /> : null },
  ];

  const bindingCols: IColumn[] = [
    { key: 'subject', name: 'User (oid)', minWidth: 220, onRender: (b: RoleBinding) => <Text variant="small" style={{ fontFamily: 'monospace' }}>{b.subjectOid}</Text> },
    { key: 'role', name: 'Role', minWidth: 90, onRender: (b: RoleBinding) => <Text variant="small">{b.role}</Text> },
    { key: 'scope', name: 'Scope', minWidth: 140, onRender: (b: RoleBinding) => <Text variant="small">{collectionName(b.collectionId)}</Text> },
    { key: 'actions', name: '', minWidth: 90, onRender: (b: RoleBinding) => <DefaultButton text="Revoke" onClick={() => revokeBinding(b.id)} /> },
  ];

  const mappingCols: IColumn[] = [
    { key: 'group', name: 'Group', minWidth: 220, onRender: (m: GroupMapping) => <Text variant="small">{m.groupDisplayName || m.groupObjectId}</Text> },
    { key: 'role', name: 'Role', minWidth: 90, onRender: (m: GroupMapping) => <Text variant="small">{m.role}</Text> },
    { key: 'scope', name: 'Scope', minWidth: 140, onRender: (m: GroupMapping) => <Text variant="small">{collectionName(m.collectionId)}</Text> },
    { key: 'actions', name: '', minWidth: 90, onRender: (m: GroupMapping) => <DefaultButton text="Remove" onClick={() => deleteMapping(m.id)} /> },
  ];

  if (!canManageCollections && !canAssignRoles) {
    return (
      <Stack tokens={{ childrenGap: 16 }} styles={{ root: { padding: 24 } }}>
        <Text variant="xLarge" style={{ fontWeight: 700 }}>Administration</Text>
        <MessageBar messageBarType={MessageBarType.blocked}>
          You do not have permission to manage collections or role assignments.
        </MessageBar>
      </Stack>
    );
  }

  return (
    <Stack tokens={{ childrenGap: 16 }} styles={{ root: { padding: 24 } }}>
      <Text variant="xLarge" style={{ fontWeight: 700 }}>Administration</Text>
      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {loading && <Spinner size={SpinnerSize.large} label="Loading…" />}

      <Pivot>
        {canManageCollections && (
          <PivotItem headerText="Collections (boundaries)">
            <Stack tokens={{ childrenGap: 12 }} styles={{ root: { paddingTop: 12 } }}>
              <Text variant="medium" style={{ fontWeight: 600 }}>Create a boundary</Text>
              <Stack horizontal tokens={{ childrenGap: 12 }} verticalAlign="end" wrap>
                <TextField label="Name" value={newName} onChange={(_, v) => setNewName(v ?? '')} styles={{ root: { minWidth: 200 } }} />
                <TextField label="Description" value={newDesc} onChange={(_, v) => setNewDesc(v ?? '')} styles={{ root: { minWidth: 220 } }} />
                <Toggle label="Tag-based membership" checked={tagMode} onChange={(_, v) => setTagMode(!!v)} />
                {tagMode && <TextField label="Tag key" value={tagKey} onChange={(_, v) => setTagKey(v ?? '')} styles={{ root: { width: 140 } }} />}
                {tagMode && <TextField label="Tag value" value={tagValue} onChange={(_, v) => setTagValue(v ?? '')} styles={{ root: { width: 140 } }} />}
                <PrimaryButton text="Create" disabled={!newName || (tagMode && (!tagKey || !tagValue))} onClick={createCollection} />
              </Stack>
              <DetailsList items={collections} columns={collectionCols} selectionMode={SelectionMode.none} />
            </Stack>
          </PivotItem>
        )}

        {canAssignRoles && (
          <PivotItem headerText="Role assignments">
            <Stack tokens={{ childrenGap: 12 }} styles={{ root: { paddingTop: 12 } }}>
              <Text variant="medium" style={{ fontWeight: 600 }}>Grant a role to a user</Text>
              <Stack horizontal tokens={{ childrenGap: 12 }} verticalAlign="end" wrap>
                <TextField label="User object id (oid)" value={bSubject} onChange={(_, v) => setBSubject(v ?? '')} styles={{ root: { minWidth: 260 } }} />
                <Dropdown label="Role" options={roleOptions} selectedKey={bRole} onChange={(_, o) => setBRole(o?.key as Role)} styles={{ root: { minWidth: 220 } }} />
                <Dropdown label="Scope" options={collectionOptions} selectedKey={bCollection} onChange={(_, o) => setBCollection(String(o?.key ?? ''))} styles={{ root: { minWidth: 200 } }} />
                <PrimaryButton text="Grant" disabled={!bSubject} onClick={createBinding} />
              </Stack>
              <DetailsList items={bindings} columns={bindingCols} selectionMode={SelectionMode.none} />
            </Stack>
          </PivotItem>
        )}

        {canAssignRoles && (
          <PivotItem headerText="Entra group mappings">
            <Stack tokens={{ childrenGap: 12 }} styles={{ root: { paddingTop: 12 } }}>
              <Text variant="medium" style={{ fontWeight: 600 }}>Map an Entra security group to a role</Text>
              <Stack horizontal tokens={{ childrenGap: 12 }} verticalAlign="end" wrap>
                <TextField label="Group object id" value={gId} onChange={(_, v) => setGId(v ?? '')} styles={{ root: { minWidth: 260 } }} />
                <TextField label="Display name" value={gName} onChange={(_, v) => setGName(v ?? '')} styles={{ root: { minWidth: 180 } }} />
                <Dropdown label="Role" options={roleOptions} selectedKey={gRole} onChange={(_, o) => setGRole(o?.key as Role)} styles={{ root: { minWidth: 220 } }} />
                <Dropdown label="Scope" options={collectionOptions} selectedKey={gCollection} onChange={(_, o) => setGCollection(String(o?.key ?? ''))} styles={{ root: { minWidth: 200 } }} />
                <PrimaryButton text="Map" disabled={!gId} onClick={createMapping} />
              </Stack>
              <DetailsList items={mappings} columns={mappingCols} selectionMode={SelectionMode.none} />
            </Stack>
          </PivotItem>
        )}
      </Pivot>
    </Stack>
  );
}
