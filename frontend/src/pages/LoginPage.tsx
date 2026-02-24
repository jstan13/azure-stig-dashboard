import { PrimaryButton, Text, Stack, Image } from '@fluentui/react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../auth/msalConfig';

export default function LoginPage() {
  const { instance } = useMsal();

  const handleLogin = () => {
    instance.loginRedirect(loginRequest).catch(console.error);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0078d4 0%, #005a9e 100%)',
      }}
    >
      <Stack
        horizontalAlign="center"
        tokens={{ childrenGap: 24 }}
        styles={{
          root: {
            background: '#ffffff',
            borderRadius: 8,
            padding: '48px 56px',
            boxShadow: '0 8px 32px rgba(0,0,0,.18)',
            maxWidth: 420,
            width: '100%',
          },
        }}
      >
        <Text variant="xxLarge" style={{ fontWeight: 700, color: '#0078d4' }}>
          🛡 Azure STIG Dashboard
        </Text>

        <Text variant="mediumPlus" style={{ textAlign: 'center', color: '#605e5c' }}>
          Automated STIG compliance tracking for Azure workloads.
          Sign in with your Azure AD account to continue.
        </Text>

        <Stack tokens={{ childrenGap: 8 }} styles={{ root: { width: '100%' } }}>
          <div style={{ background: '#f3f2f1', borderRadius: 4, padding: '12px 16px', fontSize: 13 }}>
            <strong>Roles:</strong>
            <ul style={{ margin: '4px 0 0 16px' }}>
              <li><strong>Admin</strong> — full access, trigger scans, manage exceptions</li>
              <li><strong>Operator</strong> — trigger scans, update findings</li>
              <li><strong>Auditor</strong> — read-only, export checklists</li>
            </ul>
          </div>
        </Stack>

        <PrimaryButton
          text="Sign in with Azure AD"
          iconProps={{ iconName: 'AADLogo' }}
          onClick={handleLogin}
          styles={{ root: { width: '100%', height: 44, fontSize: 15 } }}
        />

        <Text variant="small" style={{ color: '#a19f9d', textAlign: 'center' }}>
          By signing in you agree to your organization's security policies.
          {import.meta.env.VITE_MOCK_MODE === 'true' && (
            <span style={{ display: 'block', color: '#c7a200', marginTop: 8 }}>
              ⚠ MOCK_MODE is enabled — no real Azure AD required.
            </span>
          )}
        </Text>
      </Stack>
    </div>
  );
}
