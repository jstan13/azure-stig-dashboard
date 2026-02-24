import { useNavigate, useLocation } from 'react-router-dom';
import {
  CommandBar, ICommandBarItemProps,
  Text, Stack, Persona, PersonaSize,
  ContextualMenu,
} from '@fluentui/react';
import { useMsal } from '@azure/msal-react';
import { useState, useRef } from 'react';

export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { instance, accounts } = useMsal();
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
    },
  ];

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
            items={items}
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
                onClick: () => instance.logoutRedirect(),
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
