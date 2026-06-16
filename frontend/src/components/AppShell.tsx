/**
 * Azure-portal-style application shell:
 *   ┌────────────────────────────────────────────────┐
 *   │ TopBar  (brand, search, account)               │
 *   ├──────┬─────────────────────────────────────────┤
 *   │ Side │ <main>                                  │
 *   │ Nav  │                                         │
 *   │      │                                         │
 *   └──────┴─────────────────────────────────────────┘
 *
 * Visual cues borrowed from portal.azure.com: dark navy header,
 * collapsible icon-only rail on the left, breadcrumb-friendly main pane.
 */
import { useState, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Stack, IconButton, Persona, PersonaSize, ContextualMenu, SearchBox, Text,
} from '@fluentui/react';
import { useMsal } from '@azure/msal-react';

type NavGroup = {
  label: string;
  items: { key: string; label: string; icon: string; path: string }[];
};

const NAV: NavGroup[] = [
  {
    label: 'Compliance',
    items: [
      { key: 'overview',  label: 'Overview',         icon: 'ViewDashboard',    path: '/dashboard' },
      { key: 'explorer',  label: 'Cloud Explorer',   icon: 'AzureLogo',        path: '/explorer' },
      { key: 'inventory', label: 'Machine Inventory',icon: 'ServerEnviroment', path: '/inventory' },
      { key: 'groups',    label: 'Resource Groups',  icon: 'Group',            path: '/groups/all' },
      { key: 'pools',     label: 'Asset Pools',      icon: 'BranchMerge',      path: '/pools' },
    ],
  },
  {
    label: 'Reporting',
    items: [
      { key: 'trends',    label: 'Compliance Trends',icon: 'LineChart',        path: '/trends' },
      { key: 'poams',     label: 'POA&M',            icon: 'TaskSolid',        path: '/poams' },
      { key: 'vulns',     label: 'Vulnerabilities',  icon: 'Bug',              path: '/vulnerabilities' },
      { key: 'rmf',       label: 'RMF / NIST',       icon: 'Compliance',       path: '/rmf' },
      { key: 'stigs',     label: 'STIG Library',     icon: 'Shield',           path: '/stigs' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { key: 'remed',     label: 'Bulk Remediation', icon: 'Repair',           path: '/remediation' },
      { key: 'emass',     label: 'eMASS Sync',       icon: 'CloudUpload',      path: '/emass' },
      { key: 'audit',     label: 'Audit Log',        icon: 'History',          path: '/audit' },
      { key: 'users',     label: 'Users',            icon: 'People',           path: '/users' },
    ],
  },
];

const HEADER_HEIGHT = 48;
const RAIL_OPEN     = 240;
const RAIL_CLOSED   = 56;

export default function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { instance, accounts } = useMsal();
  const account = accounts[0];

  const [open, setOpen] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const personaRef = useRef<HTMLDivElement>(null);

  const isActive = (path: string) =>
    location.pathname === path ||
    (path !== '/dashboard' && location.pathname.startsWith(path.split('/').slice(0, 2).join('/')));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#f5f5f5' }}>
      {/* ─── Top header (Azure portal navy bar) ─────────────────────────── */}
      <header
        style={{
          height: HEADER_HEIGHT, background: '#0078d4', color: '#fff',
          display: 'flex', alignItems: 'center', padding: '0 12px',
          borderBottom: '1px solid #005a9e', position: 'sticky', top: 0, zIndex: 10,
        }}
      >
        <IconButton
          iconProps={{ iconName: 'GlobalNavButton' }}
          onClick={() => setOpen((o) => !o)}
          styles={{
            root: { color: '#fff', height: HEADER_HEIGHT, width: HEADER_HEIGHT },
            rootHovered: { background: '#106ebe', color: '#fff' },
            icon: { color: '#fff' },
          }}
          ariaLabel="Toggle navigation"
        />
        <Link
          to="/dashboard"
          style={{ color: '#fff', textDecoration: 'none', fontWeight: 600, fontSize: 15, marginLeft: 4 }}
        >
          🛡 Azure STIG Dashboard
        </Link>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <SearchBox
            placeholder="Search machines, findings, controls…"
            styles={{
              root: { width: 480, maxWidth: '60vw', background: '#106ebe', border: 'none' },
              field: { color: '#fff' },
              iconContainer: { color: '#fff' },
            }}
            onSearch={(v) => navigate(`/inventory?q=${encodeURIComponent(v)}`)}
          />
        </div>

        <div ref={personaRef}>
          <button
            onClick={() => setShowMenu(true)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8, color: '#fff',
              padding: '0 12px', height: HEADER_HEIGHT,
            }}
            aria-label="Account menu"
          >
            <Persona
              text={account?.name || account?.username || 'User'}
              size={PersonaSize.size28}
              hidePersonaDetails
              styles={{ root: { color: '#fff' } }}
            />
            <span style={{ fontSize: 13 }}>{account?.name?.split(' ')[0] || 'Account'}</span>
          </button>
          {showMenu && (
            <ContextualMenu
              target={personaRef.current}
              onDismiss={() => setShowMenu(false)}
              items={[
                { key: 'name', text: account?.name || 'User', disabled: true },
                { key: 'email', text: account?.username || '', disabled: true },
                { key: 'div', itemType: 1 as any },
                {
                  key: 'logout', text: 'Sign out', iconProps: { iconName: 'SignOut' },
                  onClick: () => { instance.logoutRedirect(); },
                },
              ]}
            />
          )}
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* ─── Left side rail (Azure portal style) ─────────────────────── */}
        <nav
          style={{
            width: open ? RAIL_OPEN : RAIL_CLOSED,
            transition: 'width 150ms ease',
            background: '#1b1b1b',
            color: '#e6e6e6',
            paddingTop: 8,
            overflowY: 'auto',
            overflowX: 'hidden',
            flexShrink: 0,
          }}
        >
          {NAV.map((group) => (
            <div key={group.label} style={{ marginBottom: 12 }}>
              {open && (
                <div
                  style={{
                    fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6,
                    color: '#9b9b9b', padding: '8px 16px 4px',
                  }}
                >
                  {group.label}
                </div>
              )}
              {group.items.map((it) => {
                const active = isActive(it.path);
                return (
                  <button
                    key={it.key}
                    onClick={() => navigate(it.path)}
                    title={open ? '' : it.label}
                    style={{
                      width: '100%', textAlign: 'left',
                      background: active ? '#0d4a73' : 'transparent',
                      color: active ? '#fff' : '#e6e6e6',
                      border: 'none', cursor: 'pointer',
                      padding: open ? '8px 16px' : '8px 0', height: 36,
                      display: 'flex', alignItems: 'center',
                      justifyContent: open ? 'flex-start' : 'center',
                      gap: 12, fontSize: 13,
                      borderLeft: active ? '3px solid #50e6ff' : '3px solid transparent',
                    }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#2b2b2b'; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <i className={`ms-Icon ms-Icon--${it.icon}`} aria-hidden="true" style={{ fontSize: 16, width: 20, textAlign: 'center' }} />
                    {open && <span>{it.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* ─── Main content pane ──────────────────────────────────────── */}
        <main style={{ flex: 1, padding: 24, overflow: 'auto', minWidth: 0 }}>
          {children}
        </main>
      </div>
    </div>
  );
}
