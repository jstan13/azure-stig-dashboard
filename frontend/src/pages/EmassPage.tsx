/**
 * eMASS Integration page — connector status, system selector, push POA&Ms,
 * upload CKLB. Designed so an ISSO can do a full eMASS push in three clicks.
 */
import { useEffect, useState } from 'react';
import {
  Stack, Text, Spinner, SpinnerSize, MessageBar, MessageBarType,
  PrimaryButton, DefaultButton, Dropdown, IDropdownOption, TextField,
} from '@fluentui/react';
import { api } from '../hooks/useApi';

interface Status { configured: boolean; mode?: string; ok?: boolean; serverVersion?: string; error?: string; message?: string; }
interface System { systemId: number; name: string; acronym: string; policy?: string; registrationType?: string; }

export default function EmassPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [systems, setSystems] = useState<System[]>([]);
  const [systemId, setSystemId] = useState<number | null>(null);
  const [machineId, setMachineId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => { (async () => {
    try {
      const s = await api.get<Status>('/api/emass/status');
      setStatus(s.data);
      if (s.data.configured) {
        const sys = await api.get<{ systems: System[] }>('/api/emass/systems');
        setSystems(sys.data.systems);
        if (sys.data.systems.length === 1) setSystemId(sys.data.systems[0].systemId);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load eMASS status');
    } finally { setLoading(false); }
  })(); }, []);

  async function pushPoams() {
    if (!systemId) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await api.post(`/api/emass/systems/${systemId}/push-poams`, { onlyOpen: true });
      setSuccess(`Pushed ${res.data.submitted} POA&M(s). eMASS IDs: ${(res.data.emassIds || []).join(', ') || 'n/a'}`);
    } catch (e: any) {
      setError(e?.message || 'Push failed');
    } finally { setBusy(false); }
  }

  async function uploadCklb() {
    if (!systemId || !machineId) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await api.post(`/api/emass/systems/${systemId}/upload-cklb`, { machineId });
      setSuccess(`Uploaded CKLB (eMASS ID ${res.data.cklbId ?? 'n/a'})`);
    } catch (e: any) {
      setError(e?.message || 'Upload failed');
    } finally { setBusy(false); }
  }

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading eMASS status…" style={{ marginTop: 80 }} />;

  return (
    <Stack tokens={{ childrenGap: 16 }} styles={{ root: { maxWidth: 800 } }}>
      <Stack>
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>eMASS Integration</Text>
        <Text style={{ color: '#605e5c' }}>
          Push POA&amp;Ms and CKLB checklists from this dashboard directly into eMASS using the v3 REST API + DoD PKI mTLS.
        </Text>
      </Stack>

      {error && <MessageBar messageBarType={MessageBarType.error}    onDismiss={() => setError(null)}>{error}</MessageBar>}
      {success && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setSuccess(null)}>{success}</MessageBar>}

      {!status?.configured && (
        <MessageBar messageBarType={MessageBarType.warning}>
          eMASS is not configured. Set the following App Settings (typically via Key Vault references):
          <ul style={{ marginTop: 6 }}>
            <li><code>EMASS_BASE_URL</code></li>
            <li><code>EMASS_API_KEY</code></li>
            <li><code>EMASS_USER_UID</code></li>
            <li><code>EMASS_CERT_PEM</code> &amp; <code>EMASS_KEY_PEM</code> (DoD PKI)</li>
            <li><code>EMASS_CA_PEM</code> (optional, DoD root bundle)</li>
          </ul>
        </MessageBar>
      )}

      {status?.configured && (
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 16 }}>
          <Stack horizontal tokens={{ childrenGap: 16 }} verticalAlign="center">
            <span style={{ fontSize: 28 }}>{status.ok ? '✓' : '!'}</span>
            <Stack>
              <Text variant="large" style={{ fontWeight: 600 }}>
                Connection {status.ok ? 'healthy' : 'failing'}{status.mode === 'mock' ? ' (mock)' : ''}
              </Text>
              <Text style={{ color: '#605e5c', fontSize: 12 }}>
                {status.serverVersion ? `eMASS API ${status.serverVersion}` : status.error || 'no version reported'}
              </Text>
            </Stack>
          </Stack>
        </div>
      )}

      {status?.configured && (
        <div style={{ background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 }}>
          <Text variant="large" style={{ fontWeight: 600, display: 'block', marginBottom: 12 }}>Push to eMASS</Text>

          <Dropdown
            label="eMASS system"
            selectedKey={systemId ?? undefined}
            options={systems.map<IDropdownOption>((s) => ({ key: s.systemId, text: `${s.acronym} — ${s.name}` }))}
            onChange={(_e, o) => setSystemId(o ? Number(o.key) : null)}
            placeholder={systems.length ? 'Select an eMASS system…' : '(no systems available)'}
          />

          <Stack horizontal tokens={{ childrenGap: 12 }} style={{ marginTop: 16 }}>
            <PrimaryButton
              iconProps={{ iconName: 'Upload' }}
              text="Push all open POA&Ms"
              disabled={!systemId || busy}
              onClick={pushPoams}
            />
          </Stack>

          <Text variant="medium" style={{ fontWeight: 600, display: 'block', marginTop: 24 }}>Upload CKLB for a machine</Text>
          <Stack horizontal tokens={{ childrenGap: 12 }} verticalAlign="end">
            <TextField label="Machine ID" value={machineId} onChange={(_e, v) => setMachineId(v || '')} styles={{ root: { minWidth: 280 } }} />
            <DefaultButton iconProps={{ iconName: 'Upload' }} text="Upload CKLB" disabled={!systemId || !machineId || busy} onClick={uploadCklb} />
          </Stack>
        </div>
      )}
    </Stack>
  );
}
