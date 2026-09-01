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
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import {
  clearSavedEmassConfig, getEmassConfigStatus, saveEmassConfig,
} from '../services/emassConfigService';
import { z } from 'zod';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';
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
router.get('/status', async (_req: Request, res: Response) => {
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
router.get('/systems', async (_req: Request, res: Response) => {
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

    const cklb = generateCklb(machine, findings, controls);
    const buf  = Buffer.from(JSON.stringify(cklb), 'utf-8');
    const result = await emass.uploadCklb(systemId, buf, `${machine.name}.cklb`);

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

function poamToEmass(p: any): emass.EmassPoamPayload {
  return {
    externalUid: p.poamId,
    controlAcronym: p.controlAcronym || p.controlId || 'CM-6',
    cci: p.cci,
    status: mapStatus(p.status),
    vulnerabilityDescription: p.weakness || p.description || '(no description)',
    sourceIdentifyingControl: p.sourceIdentifyingControl,
    pocOrganization: p.pocOrganization,
    pocFirstName:    p.assignedToName?.split(' ')?.[0],
    pocLastName:     p.assignedToName?.split(' ')?.slice(1).join(' '),
    pocEmail:        p.pocEmail,
    pocPhoneNumber:  p.pocPhoneNumber,
    resources:       p.resourcesRequired,
    scheduledCompletionDate: p.scheduledCompletion ? Math.floor(new Date(p.scheduledCompletion).getTime() / 1000) : undefined,
    severity:        mapSeverity(p.severity || p.residualRisk),
    rawSeverity:     mapRawSeverity(p.severity),
    mitigation:      p.countermeasures,
    recommendations: p.delayReason,
    milestones: (p.milestones || []).map((m: any) => ({
      description: m.description,
      scheduledCompletionDate: m.scheduledCompletion ? Math.floor(new Date(m.scheduledCompletion).getTime() / 1000) : Math.floor(Date.now() / 1000),
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
function mapSeverity(s?: string): emass.EmassPoamPayload['severity'] | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v.includes('high') || v === 'i')   return 'CAT I';
  if (v.includes('mod') || v === 'ii')   return 'CAT II';
  if (v.includes('low') || v === 'iii')  return 'CAT III';
  return undefined;
}
function mapRawSeverity(s?: string): emass.EmassPoamPayload['rawSeverity'] | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v.includes('high'))   return 'I';
  if (v.includes('medium')) return 'II';
  if (v.includes('low'))    return 'III';
  return undefined;
}

export default router;
