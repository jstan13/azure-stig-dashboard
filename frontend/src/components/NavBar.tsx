import { useNavigate, useLocation } from 'react-router-dom';
import {
  CommandBar, ICommandBarItemProps,
  Text, Stack, Persona, PersonaSize,
  ContextualMenu,
} from '@fluentui/react';
import { useMsal } from '@azure/msal-react';
import { useState, useRef } from 'react';
import { usePermissions } from '../auth/AuthzProvider';

export default function NavBar() {
  const rrNavigate = useNavigate();
  // React Router v7's navigate() returns `void | Promise<void>`; wrap it so the
  // Fluent UI onClick handlers below stay strictly void-returning.
  const navigate = (path: string): void => { void rrNavigate(path); };
  const location = useLocation();
  const { instance, accounts } = useMsal();
  const { has } = usePermissions();
  const [showMenu, setShowMenu] = useState(false);
  const personaRef = useRef<HTMLDivElement>(null);

  const account = accounts[0];

  const items: ICommandBarItemProps[] = [
    {
      key: 'brand',
      text: '🛡 Azure STIG Dashboard',
      buttonStyles: { root: { fontWeight: 700, fontSize: 16 } },
      onClick: () => navigate('/dashboard'),
    },
    {
      key: 'dashboard',
      text: 'Overview',
      iconProps: { iconName: 'ViewDashboard' },
      checked: location.pathname === '/dashboard',
      onClick: () => navigate('/dashboard'),
    },
    {
      key: 'inventory',
      text: 'Inventory',
      iconProps: { iconName: 'ServerEnviroment' },
      checked: location.pathname === '/inventory',
      onClick: () => navigate('/inventory'),
    },
    {
      key: 'groups',
      text: 'Groups',
      iconProps: { iconName: 'Group' },
      checked: location.pathname.startsWith('/groups'),
      onClick: () => navigate('/groups/all'),
    },
    {
      key: 'audit',
      text: 'Audit',
      iconProps: { iconName: 'History' },
      checked: location.pathname === '/audit',
      onClick: () => navigate('/audit'),
      data: { perm: 'audit:read' },
    },
    {
      key: 'stigs',
      text: 'STIG Library',
      iconProps: { iconName: 'Shield' },
      checked: location.pathname.startsWith('/stigs'),
      onClick: () => navigate('/stigs'),
    },
    {
      key: 'poams',
      text: 'POA&M',
      iconProps: { iconName: 'TaskSolid' },
      checked: location.pathname === '/poams',
      onClick: () => navigate('/poams'),
    },
    {
      key: 'trends',
      text: 'Trends',
      iconProps: { iconName: 'LineChart' },
      checked: location.pathname === '/trends',
      onClick: () => navigate('/trends'),
    },
    {
      key: 'rmf',
      text: 'RMF / NIST',
      iconProps: { iconName: 'Compliance' },
      checked: location.pathname === '/rmf',
      onClick: () => navigate('/rmf'),
    },
    {
      key: 'users',
      text: 'Users',
      iconProps: { iconName: 'People' },
      checked: location.pathname === '/users',
      onClick: () => navigate('/users'),
      data: { perm: 'users:manage' },
    },
    {
      key: 'admin',
      text: 'Admin',
      iconProps: { iconName: 'Settings' },
      checked: location.pathname === '/admin',
      onClick: () => navigate('/admin'),
      data: { perm: 'collection:manage' },
    },
  ];

  // Hide nav entries the caller lacks the permission for (server still enforces).
  const visibleItems = items.filter((it) => {
    const perm = (it.data as { perm?: string } | undefined)?.perm;
    return !perm || has(perm as never);
  });

  const farItems: ICommandBarItemProps[] = [
    {
      key: 'docs',
      text: 'API Docs',
      iconProps: { iconName: 'Documentation' },
      href: '/api/docs',
      target: '_blank',
    },
  ];

  return (
    <div style={{ background: '#0078d4', boxShadow: '0 2px 4px rgba(0,0,0,.2)' }}>
      <Stack horizontal verticalAlign="center" styles={{ root: { padding: '0 16px' } }}>
        <Stack.Item grow>
          <CommandBar
            items={visibleItems}
            farItems={farItems}
            styles={{
              root: { background: 'transparent', padding: 0 },
            }}
          />
        </Stack.Item>
        <Stack.Item>
          <div ref={personaRef} style={{ cursor: 'pointer' }} onClick={() => setShowMenu(true)}>
            <Persona
              text={account?.name || account?.username || 'User'}
              secondaryText={account?.username}
              size={PersonaSize.size32}
              styles={{ root: { color: '#fff' }, primaryText: { color: '#fff' }, secondaryText: { color: '#ddd' } }}
            />
          </div>
          <ContextualMenu
            items={[
              {
                key: 'logout',
                text: 'Sign out',
                iconProps: { iconName: 'SignOut' },
                onClick: () => { void instance.logoutRedirect(); },
              },
            ]}
            hidden={!showMenu}
            target={personaRef}
            onDismiss={() => setShowMenu(false)}
          />
        </Stack.Item>
      </Stack>
    </div>
  );
}
