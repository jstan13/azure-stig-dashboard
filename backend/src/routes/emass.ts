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
import { requireRole } from '../middleware/auth';
import { recordAudit } from '../auth';
import { logger } from '../utils/logger';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// ── GET /api/emass/status ───────────────────────────────────────────────────
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const configured = emass.isConfigured() || emass.isMock();
    if (!configured) {
      return res.json({
        configured: false,
        mode: 'unconfigured',
        message: 'Set EMASS_BASE_URL, EMASS_API_KEY, EMASS_USER_UID, EMASS_CERT_PEM, EMASS_KEY_PEM in app settings to enable eMASS push.',
      });
    }
    const ping = await emass.ping();
    return res.json({ configured: true, ...ping });
  } catch (err: any) {
    logger.error('[GET /emass/status]', err);
    return res.status(500).json({ configured: false, error: err.message });
  }
});

// ── GET /api/emass/systems ──────────────────────────────────────────────────
router.get('/systems', async (_req: Request, res: Response) => {
  try {
    if (!emass.isConfigured() && !emass.isMock()) {
      return res.status(412).json({ error: 'eMASS not configured' });
    }
    const systems = await emass.listSystems();
    return res.json({ systems });
  } catch (err: any) {
    logger.error('[GET /emass/systems]', err);
    return res.status(502).json({ error: err.message });
  }
});

// ── POST /api/emass/systems/:id/push-poams ──────────────────────────────────
// Body: { poamIds?: string[]; onlyOpen?: boolean }
router.post('/systems/:id/push-poams', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    const systemId = Number(req.params.id);
    if (!Number.isFinite(systemId)) return res.status(400).json({ error: 'systemId must be numeric' });
    if (!emass.isConfigured() && !emass.isMock()) return res.status(412).json({ error: 'eMASS not configured' });

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

    await recordAudit(req as any, 'emass.push_poams', {
      systemId, count: result.submitted, emassIds: result.emassIds,
    });

    return res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error('[POST /emass/.../push-poams]', err);
    return res.status(502).json({ error: err.message });
  }
});

// ── POST /api/emass/systems/:id/upload-cklb ─────────────────────────────────
// Body: { machineId: string }
router.post('/systems/:id/upload-cklb', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    const systemId  = Number(req.params.id);
    const machineId = String(req.body?.machineId || '');
    if (!Number.isFinite(systemId)) return res.status(400).json({ error: 'systemId must be numeric' });
    if (!machineId)                  return res.status(400).json({ error: 'machineId is required' });
    if (!emass.isConfigured() && !emass.isMock()) return res.status(412).json({ error: 'eMASS not configured' });

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

    await recordAudit(req as any, 'emass.upload_cklb', {
      systemId, machineId, cklbId: result.cklbId,
    });

    return res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error('[POST /emass/.../upload-cklb]', err);
    return res.status(502).json({ error: err.message });
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
