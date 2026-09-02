/**
 * User Management Page (Admin)
 *
 * - Table of all users with role badges
 * - Inline role assignment dropdown
 * - Enable / disable user toggle
 * - Basic search + filter
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Stack, Text, DetailsList, DetailsListLayoutMode, IColumn,
  SelectionMode, MessageBar, MessageBarType, Spinner, SpinnerSize,
  CommandBar, ICommandBarItemProps, SearchBox, Dropdown,
  IDropdownOption, Toggle, Dialog, DialogType, DialogFooter,
  PrimaryButton, DefaultButton, TextField, mergeStyleSets,
} from '@fluentui/react';
import { api } from '../hooks/useApi';

const ROLE_OPTIONS: IDropdownOption[] = [
  { key: 'auditor', text: 'Auditor' },
  { key: 'operator', text: 'Operator' },
  { key: 'isso', text: 'ISSO' },
  { key: 'issm', text: 'ISSM' },
  { key: 'admin',   text: 'Admin' },
];

const ROLE_COLORS: Record<string, string> = {
  admin:   '#a4262c',
  issm:    '#5c2d91',
  isso:    '#8764b8',
  operator:'#0078d4',
  auditor: '#ca5010',
};

const classes = mergeStyleSets({
  roleBadge: { display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, color: '#fff' },
});

export default function UserManagementPage() {
  const [users, setUsers]       = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [total, setTotal]       = useState(0);
  const [editUser, setEditUser] = useState<any | null>(null);
  const [saving, setSaving]     = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search)     params.set('search', search);
      if (roleFilter) params.set('role', roleFilter);
      const res = await api.get<any>(`/api/users?${params}`);
      const nextUsers = Array.isArray(res.data?.users)
        ? res.data.users
        : Array.isArray(res.data) ? res.data : [];
      setUsers(nextUsers);
      setTotal(typeof res.data?.total === 'number' ? res.data.total : nextUsers.length);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [api, search, roleFilter]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const updateRole = async (userId: string, role: string) => {
    try {
      await api.patch(`/api/users/${userId}`, { role });
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role } : u));
    } catch (e: any) { setError('Failed to update role: ' + e.message); }
  };

  const toggleEnabled = async (userId: string, enabled: boolean) => {
    try {
      await api.patch(`/api/users/${userId}`, { enabled });
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, enabled } : u));
    } catch (e: any) { setError('Failed to update user: ' + e.message); }
  };

  const columns: IColumn[] = [
    {
      key: 'name', name: 'Display Name', minWidth: 160, isRowHeader: true,
      onRender: (u) => <Text variant="small" style={{ fontWeight: 600 }}>{u.displayName}</Text>,
    },
    {
      key: 'email', name: 'Email', minWidth: 200,
      onRender: (u) => <Text variant="small" style={{ color: '#605e5c' }}>{u.email}</Text>,
    },
    {
      key: 'role', name: 'Role', minWidth: 140, maxWidth: 160,
      onRender: (u) => (
        <Dropdown
          options={ROLE_OPTIONS}
          selectedKey={u.role}
          onChange={(_, o) => updateRole(u.id, String(o?.key))}
          styles={{ root: { minWidth: 120 } }}
        />
      ),
    },
    {
      key: 'badge', name: '', minWidth: 80, maxWidth: 90,
      onRender: (u) => (
        <span className={classes.roleBadge} style={{ background: ROLE_COLORS[u.role] ?? '#605e5c' }}>
          {u.role}
        </span>
      ),
    },
    {
      key: 'enabled', name: 'Active', minWidth: 70, maxWidth: 80,
      onRender: (u) => (
        <Toggle
          checked={u.enabled !== false}
          onChange={(_, v) => toggleEnabled(u.id, v ?? false)}
          styles={{ root: { margin: 0 } }}
        />
      ),
    },
    {
      key: 'oid', name: 'Object ID', minWidth: 200,
      onRender: (u) => <Text variant="small" style={{ fontFamily: 'monospace', color: '#999' }}>{u.oid}</Text>,
    },
  ];

  const commandItems: ICommandBarItemProps[] = [
    { key: 'refresh', text: 'Refresh', iconProps: { iconName: 'Refresh' }, onClick: () => { void loadUsers(); } },
  ];

  const filterOptions: IDropdownOption[] = [
    { key: '', text: 'All Roles' },
    ...ROLE_OPTIONS,
  ];

  return (
    <Stack tokens={{ childrenGap: 16 }}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center">
        <Text variant="xLarge" style={{ fontWeight: 700 }}>User Management</Text>
        <Text variant="small" style={{ color: '#605e5c' }}>{total} user(s)</Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}

      <Stack horizontal tokens={{ childrenGap: 12 }} wrap>
        <SearchBox
          placeholder="Search by name or email…"
          value={search}
          onChange={(_, v) => setSearch(v ?? '')}
          styles={{ root: { width: 280 } }}
        />
        <Dropdown
          options={filterOptions}
          selectedKey={roleFilter}
          onChange={(_, o) => setRoleFilter(String(o?.key ?? ''))}
          placeholder="Filter by role"
          styles={{ root: { width: 150 } }}
        />
      </Stack>

      <CommandBar items={commandItems} styles={{ root: { padding: 0 } }} />

      {loading
        ? <Spinner size={SpinnerSize.large} label="Loading users…" />
        : (
          <DetailsList
            items={users}
            columns={columns}
            layoutMode={DetailsListLayoutMode.justified}
            selectionMode={SelectionMode.none}
          />
        )
      }
      {!loading && users.length === 0 && (
        <Stack horizontalAlign="center" tokens={{ padding: 40 }}>
          <Text variant="large" style={{ color: '#605e5c' }}>No users found</Text>
        </Stack>
      )}

      <MessageBar messageBarType={MessageBarType.info}>
        Role changes take effect immediately. Users must re-authenticate to receive updated role claims.
      </MessageBar>
    </Stack>
  );
}
