/**
 * Risk acceptance sign-off for a POA&M.
 *
 * Only shown to users with poam:approve who did not create the POA&M (the
 * server enforces both). The rationale is required and pre-filled with any
 * draft the POA&M author wrote. Once accepted, the rationale and residual risk
 * are locked and are carried into the POA&M CSV, the linked finding's CKL/CKLB
 * comments, and eMASS POA&M comments.
 */

import { useEffect, useState } from 'react';
import {
  Dialog, DialogType, DialogFooter, PrimaryButton, DefaultButton, TextField,
  Dropdown, MessageBar, MessageBarType, Stack, Text,
} from '@fluentui/react';
import { api } from '../hooks/useApi';
import { RESIDUAL_RISK_OPTIONS } from './poamOptions';

const MAX_RATIONALE = 8000;

export interface RiskAcceptanceDialogProps {
  poam: any | null;
  onDismiss: () => void;
  onAccepted: (poam: any) => void;
}

export default function RiskAcceptanceDialog({ poam, onDismiss, onAccepted }: RiskAcceptanceDialogProps) {
  const [rationale, setRationale] = useState('');
  const [residualRisk, setResidualRisk] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!poam) return;
    setRationale(poam.riskAcceptanceRationale ?? '');
    const drafted = String(poam.residualRisk ?? '').trim().toLowerCase();
    setResidualRisk(String(RESIDUAL_RISK_OPTIONS.find((o) => String(o.key).toLowerCase() === drafted)?.key ?? ''));
    setError('');
  }, [poam]);

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.post<any>(`/api/poams/${encodeURIComponent(poam.id)}/approve`, {
        rationale: rationale.trim(),
        residualRisk: residualRisk || null,
      });
      onAccepted(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Could not accept the risk');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      hidden={!poam}
      onDismiss={saving ? undefined : onDismiss}
      minWidth={560}
      dialogContentProps={{
        type: DialogType.largeHeader,
        title: `Accept risk — ${poam?.poamId ?? ''}`,
        subText: poam?.weakness,
      }}
      modalProps={{ isBlocking: true }}
    >
      <Stack tokens={{ childrenGap: 12 }}>
        {error && <MessageBar messageBarType={MessageBarType.error} onDismiss={() => setError('')}>{error}</MessageBar>}
        <TextField
          label="Risk acceptance rationale"
          required
          multiline
          rows={6}
          value={rationale}
          maxLength={MAX_RATIONALE}
          placeholder="Why the risk is acceptable: compensating controls, mission need, residual exposure, review date…"
          onChange={(_, v) => setRationale(v ?? '')}
          description={`${rationale.length} / ${MAX_RATIONALE}`}
        />
        <Dropdown
          label="Residual risk"
          options={[{ key: '', text: 'Not assessed' }, ...RESIDUAL_RISK_OPTIONS]}
          selectedKey={residualRisk}
          onChange={(_, o) => setResidualRisk(String(o?.key ?? ''))}
        />
        <Text variant="small" style={{ color: '#605e5c' }}>
          The status becomes Risk Accepted and the rationale is locked. It is included in the POA&M CSV,
          in the comments of the linked finding in CKL/CKLB exports, and in eMASS POA&M comments
          (eMASS keeps the first 2,000 characters).
        </Text>
      </Stack>
      <DialogFooter>
        <PrimaryButton
          text={saving ? 'Accepting…' : 'Accept risk'}
          disabled={saving || !rationale.trim()}
          onClick={() => { void submit(); }}
        />
        <DefaultButton text="Cancel" onClick={onDismiss} disabled={saving} />
      </DialogFooter>
    </Dialog>
  );
}
