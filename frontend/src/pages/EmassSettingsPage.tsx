import { useCallback, useEffect, useState } from 'react';
import {
  DefaultButton, Dialog, DialogFooter, DialogType, MessageBar, MessageBarType,
  PrimaryButton, Spinner, SpinnerSize, Stack, Text, TextField,
} from '@fluentui/react';
import { useApi } from '../hooks/useApi';
import { usePermissions } from '../auth/AuthzProvider';

interface EmassConfigStatus {
  baseUrl: string;
  userUid: string;
  apiKeyConfigured: boolean;
  certPemConfigured: boolean;
  keyPemConfigured: boolean;
  caPemConfigured: boolean;
  configured: boolean;
  source: 'saved' | 'environment' | 'none';
  updatedAt: string | null;
}

interface SecretDraft {
  apiKey: string;
  certPem: string;
  keyPem: string;
  caPem: string;
}

const emptySecrets: SecretDraft = { apiKey: '', certPem: '', keyPem: '', caPem: '' };

export default function EmassSettingsPage() {
  const api = useApi();
  const { has } = usePermissions();
  const canManage = has('emass:configure');
  const [status, setStatus] = useState<EmassConfigStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [userUid, setUserUid] = useState('');
  const [secrets, setSecrets] = useState<SecretDraft>(emptySecrets);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get<EmassConfigStatus>('/api/emass/config');
      setStatus(response.data);
      setBaseUrl(response.data.baseUrl);
      setUserUid(response.data.userUid);
      setSecrets(emptySecrets);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not load eMASS configuration');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { if (canManage) void load(); else setLoading(false); }, [canManage, load]);

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await api.put<EmassConfigStatus>('/api/emass/config', {
        baseUrl,
        userUid,
        ...secrets,
      });
      setStatus(response.data);
      setSecrets(emptySecrets);
      setNotice(response.data.configured ? 'eMASS configuration saved.' : 'Configuration saved, but required credentials are still missing.');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save eMASS configuration');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await api.get<{ configured: boolean; ok?: boolean; error?: string }>('/api/emass/status');
      if (!response.data.configured) setError('Complete all required eMASS settings before testing.');
      else if (!response.data.ok) setError(response.data.error || 'eMASS connection failed.');
      else setNotice('eMASS connection succeeded.');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'eMASS connection test failed');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await api.delete<EmassConfigStatus>('/api/emass/config');
      setStatus(response.data);
      setBaseUrl(response.data.baseUrl);
      setUserUid(response.data.userUid);
      setSecrets(emptySecrets);
      setNotice(response.data.source === 'environment'
        ? 'Saved configuration cleared. Deployment environment values are still active.'
        : 'Saved eMASS configuration cleared.');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not clear eMASS configuration');
    } finally {
      setSaving(false);
      setConfirmClear(false);
    }
  };

  const secretLabel = (label: string, configured: boolean) =>
    `${label}${configured ? ' (configured; leave blank to keep)' : ''}`;

  if (loading) return <Spinner size={SpinnerSize.large} label="Loading eMASS configuration..." />;

  return (
    <Stack tokens={{ childrenGap: 18 }} styles={{ root: { maxWidth: 820 } }}>
      <Stack tokens={{ childrenGap: 4 }}>
        <Text variant="xxLarge" style={{ fontWeight: 700 }}>eMASS</Text>
        <Text style={{ color: '#605e5c' }}>Connection credentials for the eMASS v3 API and DoD PKI mutual TLS.</Text>
      </Stack>

      {!canManage && <MessageBar messageBarType={MessageBarType.warning}>Administrator permission is required to manage eMASS credentials.</MessageBar>}
      {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
      {notice && <MessageBar messageBarType={MessageBarType.success} onDismiss={() => setNotice('')}>{notice}</MessageBar>}

      {canManage && status && (
        <Stack tokens={{ childrenGap: 16 }} styles={{ root: { background: '#fff', border: '1px solid #edebe9', borderRadius: 8, padding: 20 } }}>
          <MessageBar messageBarType={status.configured ? MessageBarType.success : MessageBarType.info}>
            {status.configured ? 'Required settings are configured.' : 'Required settings are incomplete.'}
            {status.source === 'environment' ? ' Values are currently supplied by the deployment environment.' : ''}
          </MessageBar>

          <TextField label="Base URL" value={baseUrl} disabled={saving} required
            placeholder="https://mitigation.emass.apps.mil"
            onChange={(_event, value) => setBaseUrl(value || '')} />
          <TextField label="User UID" value={userUid} disabled={saving} required
            onChange={(_event, value) => setUserUid(value || '')} />
          <TextField label={secretLabel('API key', status.apiKeyConfigured)} value={secrets.apiKey}
            type="password" canRevealPassword disabled={saving} required={!status.apiKeyConfigured}
            onChange={(_event, value) => setSecrets((current) => ({ ...current, apiKey: value || '' }))} />
          <TextField label={secretLabel('Client certificate PEM', status.certPemConfigured)} value={secrets.certPem}
            multiline rows={6} disabled={saving} required={!status.certPemConfigured}
            onChange={(_event, value) => setSecrets((current) => ({ ...current, certPem: value || '' }))} />
          <TextField label={secretLabel('Private key PEM', status.keyPemConfigured)} value={secrets.keyPem}
            multiline rows={6} disabled={saving} required={!status.keyPemConfigured}
            onChange={(_event, value) => setSecrets((current) => ({ ...current, keyPem: value || '' }))} />
          <TextField label={secretLabel('CA bundle PEM (optional)', status.caPemConfigured)} value={secrets.caPem}
            multiline rows={4} disabled={saving}
            onChange={(_event, value) => setSecrets((current) => ({ ...current, caPem: value || '' }))} />

          <Stack horizontal wrap tokens={{ childrenGap: 10 }}>
            <PrimaryButton text="Save configuration" iconProps={{ iconName: 'Save' }} disabled={saving || !baseUrl.trim() || !userUid.trim()} onClick={save} />
            <DefaultButton text="Test connection" iconProps={{ iconName: 'PlugConnected' }} disabled={saving || !status.configured} onClick={testConnection} />
            <DefaultButton text="Clear saved values" iconProps={{ iconName: 'Delete' }} disabled={saving || status.source !== 'saved'} onClick={() => setConfirmClear(true)} />
          </Stack>
        </Stack>
      )}

      <Dialog hidden={!confirmClear} onDismiss={() => setConfirmClear(false)}
        dialogContentProps={{ type: DialogType.normal, title: 'Clear saved eMASS configuration?', subText: 'Environment or Key Vault values supplied by the deployment will remain active.' }}>
        <DialogFooter>
          <PrimaryButton text="Clear" onClick={clear} disabled={saving} />
          <DefaultButton text="Cancel" onClick={() => setConfirmClear(false)} disabled={saving} />
        </DialogFooter>
      </Dialog>
    </Stack>
  );
}