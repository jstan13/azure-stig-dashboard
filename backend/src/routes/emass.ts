/**
 * eMASS integration routes.
 *
 *   GET  /api/emass/status                   — connector health + mode
 *   GET  /api/emass/systems                  — list eMASS systems available to caller
 *   POST /api/emass/systems/:id/push-poams   — push selected (or all open) POA&Ms
 *   POST /api/emass/systems/:id/upload-cklb  — upload a generated CKLB for a machine
 *
 * All routes require the `operator` role or higher (eMASS pushes are write
 * operations against a sovereign system of record). Listing/status is open to
 * any authenticated user so the UI can render the configuration banner.
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { PoamEntity } from '../models/Poam';
import { MachineEntity } from '../models/Machine';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import * as emass from '../connectors/emassConnector';
import { generateCklb } from '../exporters/cklbExporter';
import { loadRiskAcceptances, withRiskAcceptance, riskAcceptanceNote, isRiskAccepted } from '../services/poamRiskAcceptance';
import { safeFilename } from './export';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import {
  clearSavedEmassConfig, getEmassConfigStatus, saveEmassConfig,
} from '../services/emassConfigService';
import { z } from 'zod';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optionalSecret = z.string().max(100_000).optional();
const configSchema = z.object({
  baseUrl: z.string().trim().url().refine((value) => value.startsWith('https://'), 'Base URL must use HTTPS'),
  userUid: z.string().trim().min(1).max(2_000),
  apiKey: optionalSecret,
  certPem: optionalSecret.refine((value) => !value?.trim() || value.includes('BEGIN CERTIFICATE'), 'Client certificate must be PEM encoded'),
  keyPem: optionalSecret.refine((value) => !value?.trim() || value.includes('PRIVATE KEY'), 'Private key must be PEM encoded'),
  caPem: z.string().max(200_000).nullable().optional()
    .refine((value) => value == null || !value.trim() || value.includes('BEGIN CERTIFICATE'), 'CA bundle must be PEM encoded'),
});

// ── GET/PUT/DELETE /api/emass/config ────────────────────────────────────────
router.get('/config', requirePermission('emass:configure'), async (_req: Request, res: Response) => {
  try {
    return res.json(await getEmassConfigStatus());
  } catch (err: any) {
    return sendServerError(res, '[GET /emass/config]', err);
  }
});

router.put('/config', requirePermission('emass:configure'), async (req: Request, res: Response) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const before = await getEmassConfigStatus();
    await saveEmassConfig(parsed.data);
    const after = await getEmassConfigStatus();
    await recordAudit(req as any, {
      action: 'emass.config_changed',
      entityType: 'emass_config',
      entityId: 'singleton',
      before,
      after,
      result: 'Success',
    });
    return res.json(after);
  } catch (err: any) {
    return sendServerError(res, '[PUT /emass/config]', err);
  }
});

router.delete('/config', requirePermission('emass:configure'), async (req: Request, res: Response) => {
  try {
    const before = await getEmassConfigStatus();
    await clearSavedEmassConfig();
    const after = await getEmassConfigStatus();
    await recordAudit(req as any, {
      action: 'emass.config_cleared',
      entityType: 'emass_config',
      entityId: 'singleton',
      before,
      after,
      result: 'Success',
    });
    return res.json(after);
  } catch (err: any) {
    return sendServerError(res, '[DELETE /emass/config]', err);
  }
});

// ── GET /api/emass/status ───────────────────────────────────────────────────
router.get('/status', requirePermission('dashboard:read'), async (_req: Request, res: Response) => {
  try {
    const configured = await emass.isConfigured() || emass.isMock();
    if (!configured) {
      return res.json({
        configured: false,
        mode: 'unconfigured',
        message: 'Configure eMASS in Settings to enable eMASS push.',
      });
    }
    const ping = await emass.ping();
    return res.json({ configured: true, ...ping });
  } catch (err: any) {
    return sendServerError(res, '[GET /emass/status]', err, 500, { configured: false });
  }
});

// ── GET /api/emass/systems ──────────────────────────────────────────────────
router.get('/systems', requirePermission('dashboard:read'), async (_req: Request, res: Response) => {
  try {
    if (!await emass.isConfigured() && !emass.isMock()) {
      return res.status(412).json({ error: 'eMASS not configured' });
    }
    const systems = await emass.listSystems();
    return res.json({ systems });
  } catch (err: any) {
    return sendServerError(res, '[GET /emass/systems]', err, 502);
  }
});

// ── POST /api/emass/systems/:id/push-poams ──────────────────────────────────
// Body: { poamIds?: string[]; onlyOpen?: boolean }
router.post('/systems/:id/push-poams', requirePermission('emass:push'), async (req: Request, res: Response) => {
  try {
    const systemId = Number(req.params.id);
    if (!Number.isFinite(systemId)) return res.status(400).json({ error: 'systemId must be numeric' });
    if (!await emass.isConfigured() && !emass.isMock()) return res.status(412).json({ error: 'eMASS not configured' });

    const { poamIds, onlyOpen = true } = req.body || {};
    let poams: any[];
    if (isMock()) {
      poams = mockStore.poams || [];
    } else {
      const repo = AppDataSource.getRepository(PoamEntity);
      poams = await repo.find();
    }
    if (Array.isArray(poamIds) && poamIds.length) {
      poams = poams.filter((p) => poamIds.includes(p.poamId));
    } else if (onlyOpen) {
      poams = poams.filter((p) => p.status !== 'completed' && p.status !== 'closed');
    }

    const payload: emass.EmassPoamPayload[] = poams.map(poamToEmass);
    const result = await emass.pushPoams(systemId, payload);

    await recordAudit(req as any, {
      action: 'emass.push_poams',
      entityType: 'emass_system',
      entityId: String(systemId),
      after: { systemId, count: result.submitted, emassIds: result.emassIds },
      result: 'Success',
    });

    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return sendServerError(res, '[POST /emass/.../push-poams]', err, 502);
  }
});

// ── POST /api/emass/systems/:id/upload-cklb ─────────────────────────────────
// Body: { machineId: string }
router.post('/systems/:id/upload-cklb', requirePermission('emass:push'), async (req: Request, res: Response) => {
  try {
    const systemId  = Number(req.params.id);
    const machineId = String(req.body?.machineId || '');
    if (!Number.isFinite(systemId)) return res.status(400).json({ error: 'systemId must be numeric' });
    if (!machineId)                  return res.status(400).json({ error: 'machineId is required' });
    if (!isMock() && !UUID_RE.test(machineId)) return res.status(404).json({ error: 'machine not found' });
    if (!await emass.isConfigured() && !emass.isMock()) return res.status(412).json({ error: 'eMASS not configured' });

    let machine: any;
    let findings: any[] = [];
    let controls: any[] = [];
    if (isMock()) {
      machine  = mockStore.machines.find((m: any) => m.id === machineId);
      findings = (mockStore.findings || []).filter((f: any) => f.machineId === machineId);
      controls = mockStore.controls || [];
    } else {
      machine  = await AppDataSource.getRepository(MachineEntity).findOne({ where: { id: machineId } });
      findings = await AppDataSource.getRepository(FindingEntity).find({ where: { machineId } });
      controls = await AppDataSource.getRepository(ControlEntity).find();
    }
    if (!machine) return res.status(404).json({ error: 'machine not found' });

    const accepted = await loadRiskAcceptances(findings.map((f: any) => f.id));
    findings = findings.map((f: any) => {
      const ra = accepted.get(f.id);
      return ra ? { ...f, comments: withRiskAcceptance(f.comments, ra) } : f;
    });

    const cklb = generateCklb(machine, findings, controls);
    const buf  = Buffer.from(JSON.stringify(cklb), 'utf-8');
    const result = await emass.uploadCklb(systemId, buf, `${safeFilename(machine.name)}.cklb`);

    await recordAudit(req as any, {
      action: 'emass.upload_cklb',
      entityType: 'emass_system',
      entityId: String(systemId),
      after: { systemId, machineId, cklbId: result.cklbId },
      result: 'Success',
    });

    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return sendServerError(res, '[POST /emass/.../upload-cklb]', err, 502);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

// eMASS caps POA&M free-text fields at 2000 characters.
const EMASS_TEXT_MAX = 2000;
const clip = (s?: string | null): string | undefined =>
  s ? (s.length > EMASS_TEXT_MAX ? `${s.slice(0, EMASS_TEXT_MAX - 1)}…` : s) : undefined;
const epochSeconds = (d: unknown): number | undefined => {
  if (!d) return undefined;
  const t = new Date(d as string).getTime();
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
};

/**
 * Maps a POA&M to the eMASS POA&M item. Per the eMASS API, Risk Accepted items
 * cannot carry a scheduled completion date or milestones and need comments;
 * Completed items need a completion date and comments.
 */
export function poamToEmass(p: any): emass.EmassPoamPayload {
  const status = mapStatus(p.status);
  const riskAccepted = status === 'Risk Accepted';
  const completed = status === 'Completed';
  const completedAt = completed ? epochSeconds(p.actualCompletion ?? p.updatedAt) : undefined;

  let comments: string | undefined;
  if (riskAccepted) {
    comments = clip(isRiskAccepted(p) ? riskAcceptanceNote(p) : p.riskAcceptanceRationale);
  } else if (completed) {
    const day = completedAt ? new Date(completedAt * 1000).toISOString().slice(0, 10) : undefined;
    comments = `Closed in Azure STIG Dashboard${day ? ` on ${day}` : ''}.`;
  }

  return {
    externalUid: p.poamId,
    controlAcronym: p.controlAcronym || p.controlId || 'CM-6',
    cci: p.cci,
    status,
    vulnerabilityDescription: clip(p.weakness || p.description) || '(no description)',
    sourceIdentifyingVulnerability: clip(
      p.sourceIdentifyingControl || (p.findingId ? 'DISA STIG compliance scan (Azure STIG Dashboard)' : undefined),
    ),
    pocOrganization: p.pocOrganization,
    pocFirstName:    p.assignedToName?.split(' ')?.[0],
    pocLastName:     p.assignedToName?.split(' ')?.slice(1).join(' '),
    pocEmail:        p.pocEmail,
    pocPhoneNumber:  p.pocPhoneNumber,
    resources:       p.resourcesRequired,
    scheduledCompletionDate: riskAccepted ? undefined : epochSeconds(p.scheduledCompletion),
    completionDate:  completedAt,
    comments,
    severity:        toEmassRiskLevel(p.severity),
    rawSeverity:     toEmassRiskLevel(p.severity),
    residualRiskLevel: toEmassRiskLevel(p.residualRisk),
    mitigation:      clip(p.countermeasures),
    recommendations: clip(p.delayReason),
    milestones: riskAccepted ? undefined : (p.milestones || []).map((m: any) => ({
      description: clip(m.description) ?? '',
      scheduledCompletionDate: epochSeconds(m.dueDate ?? m.scheduledCompletion) ?? Math.floor(Date.now() / 1000),
    })),
  };
}
function mapStatus(s: string): emass.EmassPoamPayload['status'] {
  switch ((s || '').toLowerCase()) {
    case 'completed': case 'closed':   return 'Completed';
    case 'risk_accepted': case 'risk-accepted': return 'Risk Accepted';
    case 'not_applicable': case 'na':  return 'Not Applicable';
    default: return 'Ongoing';
  }
}
/**
 * DISA CAT levels (stored as high/medium/low) and free-text risk ratings mapped
 * to the eMASS five-point scale. CAT I → High, CAT II → Moderate, CAT III → Low.
 */
export function toEmassRiskLevel(s?: string | null): emass.EmassRiskLevel | undefined {
  const v = (s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  switch (v) {
    case 'very high': case 'critical':                      return 'Very High';
    case 'high': case 'cat i': case 'i':                     return 'High';
    case 'moderate': case 'medium': case 'cat ii': case 'ii': return 'Moderate';
    case 'low': case 'cat iii': case 'iii':                  return 'Low';
    case 'very low': case 'informational': case 'info':      return 'Very Low';
    default:                                                  return undefined;
  }
}

export default router;
