/**
 * POA&M API Routes
 *
 * GET    /api/poams                 — list all POA&Ms (filterable)
 * GET    /api/poams/:id             — single POA&M detail
 * POST   /api/poams                 — create a POA&M, linked to a finding or entered by hand
 * PATCH  /api/poams/:id             — update POA&M fields / status
 * POST   /api/poams/:id/milestones  — add milestone
 * PATCH  /api/poams/:id/milestones/:mid — update milestone
 * DELETE /api/poams/:id/milestones/:mid — delete milestone
 * POST   /api/poams/:id/approve     — risk acceptance approval (admin/isso only)
 * POST   /api/poams/bulk-create     — create POA&Ms from all open findings
 * GET    /api/poams/export          — export all open POA&Ms as DISA-format XLSX/CSV
 */

import { Router } from 'express';
import { ILike } from 'typeorm';
import { AppDataSource, mockStore } from '../database/dataSource';
import { PoamEntity, PoamMilestoneEntity } from '../models/Poam';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { MachineEntity } from '../models/Machine';
import { requirePermission, requireDifferentActor } from '../middleware/authz';
import { recordAudit } from '../auth';
import { createError } from '../middleware/errorHandler';
import { parsePage, parsePageSize } from '../utils/paging';
import { logger } from '../utils/logger';
import { randomUUID as uuidv4 } from 'crypto';
import { generatePoamCsv } from '../exporters/poamExporter';
import { z } from 'zod';

const router = Router();

/**
 * Resolves the ISSO who owns a POA&M, for the separation-of-duties check on
 * approval. Skipped in mock mode (no DB).
 */
async function poamRequesterOid(req: import('express').Request): Promise<string | undefined> {
  if (process.env.MOCK_MODE === 'true') return undefined;
  const { id } = req.params;
  const repo = AppDataSource.getRepository(PoamEntity);
  const poam = await repo.findOne({ where: [{ id }, { poamId: id }] });
  // Use the immutable, server-recorded creator OID for the separation-of-duties
  // check. Fall back to issoOid only for legacy rows created before createdByOid
  // existed. Never trust a client-supplied owner field for this check.
  return poam?.createdByOid ?? poam?.issoOid ?? undefined;
}

// ── sequential POA&M counter (in-memory for mock; derived from the DB otherwise) ──
let mockPoamCounter = 100;
function nextPoamId() {
  return `POA-${new Date().getFullYear()}-${String(++mockPoamCounter).padStart(4, '0')}`;
}

/**
 * Next id for the current year, derived from the highest one stored so it
 * survives restarts and multiple instances. Concurrent creates can still pick
 * the same number; the unique index rejects the loser and the caller retries.
 */
async function nextPoamIdFromDb(): Promise<string> {
  const year = new Date().getFullYear();
  const [row]: Array<{ max: number }> = await AppDataSource.query(
    `SELECT COALESCE(MAX(CAST(split_part("poamId", '-', 3) AS integer)), 0)::int AS max
       FROM "poams" WHERE "poamId" ~ $1`,
    [`^POA-${year}-[0-9]+$`],
  );
  return `POA-${year}-${String(Number(row?.max ?? 0) + 1).padStart(4, '0')}`;
}

const isUniqueViolation = (err: any) => (err?.driverError?.code ?? err?.code) === '23505';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => v || undefined);

const createPoamSchema = z.object({
  findingId: optionalText(128),
  weakness: z.string().trim().min(1, 'weakness is required').max(2000),
  severity: z.enum(['high', 'medium', 'low']).optional(),
  controlAcronym: optionalText(32)
    .transform((v) => v?.toUpperCase().replace(/\s+/g, ''))
    .refine((v) => v === undefined || /^[A-Z]{2}-\d{1,2}(\(\d{1,2}\))?$/.test(v), {
      message: 'controlAcronym must be a NIST SP 800-53 control such as AC-2 or AC-2(1)',
    }),
  sourceIdentifyingControl: optionalText(500),
  description: optionalText(8000),
  impact: optionalText(4000),
  countermeasures: optionalText(8000),
  resourcesRequired: optionalText(4000),
  scheduledCompletion: optionalText(40).refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
    message: 'scheduledCompletion must be a valid date',
  }),
  assignedToOid: optionalText(128),
  assignedToName: optionalText(200),
  issoOid: optionalText(128),
}).refine((v) => v.findingId || v.severity, {
  message: 'findingId or severity is required',
  path: ['severity'],
});

function dueDateBySeverity(severity: string): Date {
  const d = new Date();
  switch (severity?.toLowerCase()) {
    case 'high':
    case 'critical': d.setDate(d.getDate() + 30);   break;
    case 'medium':   d.setDate(d.getDate() + 90);   break;
    default:         d.setDate(d.getDate() + 180);  break;
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/poams
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requirePermission('dashboard:read'), async (req, res, next) => {
  try {
    const {
      status, severity, assignedToOid, q,
      page = '1', pageSize = '50',
      overdue,
    } = req.query as Record<string, string>;

    const p = parsePage(page);
    const ps = parsePageSize(pageSize, 50, 200);
    const MOCK = process.env.MOCK_MODE === 'true';

    if (MOCK) {
      let items = [...mockStore.poams ?? []];
      if (status) items = items.filter((x: any) => x.status === status);
      if (severity) items = items.filter((x: any) => x.severity === severity);
      if (overdue === 'true') {
        const now = new Date();
        items = items.filter((x: any) => x.scheduledCompletion && new Date(x.scheduledCompletion) < now && x.status !== 'closed' && x.status !== 'resolved');
      }
      const total = items.length;
      return res.json({ data: items.slice((p - 1) * ps, p * ps), total, page: p, pageSize: ps });
    }

    const repo = AppDataSource.getRepository(PoamEntity);
    const qb = repo.createQueryBuilder('p')
      .leftJoinAndSelect('p.milestones', 'milestones')
      .orderBy('p.scheduledCompletion', 'ASC');

    if (status)       qb.andWhere('p.status = :status', { status });
    if (assignedToOid) qb.andWhere('p.assignedToOid = :oid', { oid: assignedToOid });
    if (q)            qb.andWhere('(p.weakness ILIKE :q OR p.poamId ILIKE :q)', { q: `%${q}%` });
    if (overdue === 'true') {
      qb.andWhere('p.scheduledCompletion < :now', { now: new Date() })
        .andWhere('p.status NOT IN (:...done)', { done: ['closed', 'resolved'] });
    }

    const [data, total] = await qb.skip((p - 1) * ps).take(ps).getManyAndCount();
    return res.json({ data, total, page: p, pageSize: ps });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/poams/export  (before /:id to avoid conflict)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/export', requirePermission('export:generate'), async (req, res, next) => {
  try {
    const { format = 'csv', status = 'open' } = req.query as Record<string, string>;
    const MOCK = process.env.MOCK_MODE === 'true';

    const items: any[] = MOCK
      ? (mockStore.poams ?? []).filter((x: any) => !status || x.status === status)
      : await AppDataSource.getRepository(PoamEntity).find({ where: status ? { status: status as any } : {} });

    const csv = generatePoamCsv(items);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="poams-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/poams/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requirePermission('dashboard:read'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const MOCK = process.env.MOCK_MODE === 'true';

    if (MOCK) {
      const item = (mockStore.poams ?? []).find((x: any) => x.id === id || x.poamId === id);
      if (!item) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
      return res.json(item);
    }

    const poam = await AppDataSource.getRepository(PoamEntity).findOne({
      where: [{ id }, { poamId: id }],
      relations: ['milestones'],
    });
    if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
    return res.json(poam);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/poams
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requirePermission('poam:write'), async (req, res, next) => {
  try {
    const parsed = createPoamSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return next(createError(issue?.message ?? 'Invalid POA&M payload', 400, 'VALIDATION_ERROR'));
    }
    const {
      findingId, weakness, severity: requestedSeverity, controlAcronym, sourceIdentifyingControl,
      description, impact, scheduledCompletion, assignedToOid, assignedToName, issoOid,
      countermeasures, resourcesRequired,
    } = parsed.data;

    // Immutable creator identity taken from the verified token (never the body),
    // used for the separation-of-duties check on approval.
    const actor = (req as any).auth;
    const createdByOid: string | undefined = actor?.oid ?? actor?.sub;

    const MOCK = process.env.MOCK_MODE === 'true';
    mockStore.poams = mockStore.poams ?? [];

    let finding: any = null;
    if (findingId) {
      if (MOCK) {
        finding = mockStore.findings.find((f: any) => f.id === findingId) ?? null;
      } else if (UUID_RE.test(findingId)) {
        finding = await AppDataSource.getRepository(FindingEntity).findOne({ where: { id: findingId } });
      }
      if (!finding) return next(createError('Finding not found', 404, 'NOT_FOUND'));
    }

    // A linked finding is the authority on severity; a manual entry states its own.
    const severity: string = finding?.severity ?? requestedSeverity!;
    const fields = {
      findingId: finding ? findingId! : null,
      weakness,
      severity,
      controlAcronym: controlAcronym ?? null,
      sourceIdentifyingControl: sourceIdentifyingControl ?? null,
      description,
      impact,
      status: 'open' as const,
      scheduledCompletion: scheduledCompletion ? new Date(scheduledCompletion) : dueDateBySeverity(severity),
      assignedToOid,
      assignedToName,
      issoOid,
      createdByOid,
      countermeasures,
      resourcesRequired,
    };
    const auditAfter = {
      findingId: fields.findingId, weakness, severity, controlAcronym: fields.controlAcronym, status: 'open',
    };

    if (MOCK) {
      const poam = {
        ...fields,
        id: uuidv4(),
        poamId: nextPoamId(),
        finding,
        scheduledCompletion: fields.scheduledCompletion.toISOString(),
        milestones: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStore.poams.push(poam);
      await recordAudit(req, {
        action: 'poam.created',
        entityType: 'poam',
        entityId: poam.id,
        after: { ...auditAfter, poamId: poam.poamId },
        result: 'Success',
      });
      return res.status(201).json(poam);
    }

    const repo = AppDataSource.getRepository(PoamEntity);
    let poam: PoamEntity | undefined;
    for (let attempt = 1; !poam; attempt++) {
      const candidate = repo.create({ ...fields, poamId: await nextPoamIdFromDb() });
      try {
        poam = await repo.save(candidate);
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 5) throw err;
      }
    }

    await recordAudit(req, {
      action: 'poam.created',
      entityType: 'poam',
      entityId: poam.id,
      after: { ...auditAfter, poamId: poam.poamId },
      result: 'Success',
    });
    return res.status(201).json(poam);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/poams/:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', requirePermission('poam:write'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const MOCK = process.env.MOCK_MODE === 'true';

    const updatable = [
      'weakness', 'description', 'impact', 'status', 'scheduledCompletion',
      'assignedToOid', 'assignedToName', 'issoOid', 'delayReason',
      'resourcesRequired', 'countermeasures', 'riskAcceptanceRationale', 'residualRisk',
    ];

    if (MOCK) {
      const idx = (mockStore.poams ?? []).findIndex((x: any) => x.id === id);
      if (idx === -1) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
      const before = { ...mockStore.poams[idx] };
      for (const k of updatable) {
        if (req.body[k] !== undefined) mockStore.poams[idx][k] = req.body[k];
      }
      if (req.body.status === 'resolved' || req.body.status === 'closed') {
        mockStore.poams[idx].actualCompletion = new Date().toISOString();
      }
      mockStore.poams[idx].updatedAt = new Date().toISOString();
      await recordAudit(req, {
        action: 'poam.updated',
        entityType: 'poam',
        entityId: id,
        before: { status: before.status },
        after: { status: mockStore.poams[idx].status },
        result: 'Success',
      });
      return res.json(mockStore.poams[idx]);
    }

    const repo = AppDataSource.getRepository(PoamEntity);
    const poam = await repo.findOne({ where: [{ id }, { poamId: id }] });
    if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));

    for (const k of updatable) {
      if (req.body[k] !== undefined) (poam as any)[k] = req.body[k];
    }
    if ((poam.status === 'resolved' || poam.status === 'closed') && !poam.actualCompletion) {
      poam.actualCompletion = new Date();
    }
    await repo.save(poam);
    return res.json(poam);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/poams/:id/milestones
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/milestones', requirePermission('poam:write'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { description, dueDate } = req.body;
    if (!description) return next(createError('description is required', 400, 'VALIDATION_ERROR'));

    const MOCK = process.env.MOCK_MODE === 'true';

    if (MOCK) {
      const poam = (mockStore.poams ?? []).find((x: any) => x.id === id);
      if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
      const milestone = { id: uuidv4(), poamId: id, description, dueDate, status: 'planned', createdAt: new Date().toISOString() };
      poam.milestones = poam.milestones ?? [];
      poam.milestones.push(milestone);
      return res.status(201).json(milestone);
    }

    const poam = await AppDataSource.getRepository(PoamEntity).findOne({ where: [{ id }, { poamId: id }] });
    if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));

    const ms = AppDataSource.getRepository(PoamMilestoneEntity).create({
      poamId: poam.id,
      description,
      dueDate,
      status: 'planned',
    });
    await AppDataSource.getRepository(PoamMilestoneEntity).save(ms);
    return res.status(201).json(ms);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/poams/:id/milestones/:mid
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/milestones/:mid', requirePermission('poam:write'), async (req, res, next) => {
  try {
    const { id, mid } = req.params;
    const MOCK = process.env.MOCK_MODE === 'true';
    if (MOCK) {
      const poam = (mockStore.poams ?? []).find((x: any) => x.id === id);
      if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
      const ms = (poam.milestones ?? []).find((m: any) => m.id === mid);
      if (!ms) return next(createError('Milestone not found', 404, 'NOT_FOUND'));
      Object.assign(ms, req.body);
      return res.json(ms);
    }
    const repo = AppDataSource.getRepository(PoamMilestoneEntity);
    const ms = await repo.findOne({ where: { id: mid, poamId: id } });
    if (!ms) return next(createError('Milestone not found', 404, 'NOT_FOUND'));
    Object.assign(ms, req.body);
    if (ms.status === 'completed' && !ms.completedAt) ms.completedAt = new Date();
    await repo.save(ms);
    return res.json(ms);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/poams/:id/milestones/:mid
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id/milestones/:mid', requirePermission('poam:write'), async (req, res, next) => {
  try {
    const { id, mid } = req.params;
    const MOCK = process.env.MOCK_MODE === 'true';
    if (MOCK) {
      const poam = (mockStore.poams ?? []).find((x: any) => x.id === id);
      if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
      poam.milestones = (poam.milestones ?? []).filter((m: any) => m.id !== mid);
      return res.status(204).send();
    }
    await AppDataSource.getRepository(PoamMilestoneEntity).delete({ id: mid, poamId: id });
    return res.status(204).send();
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/poams/:id/approve  — risk acceptance sign-off
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/approve', requirePermission('poam:approve'), requireDifferentActor(poamRequesterOid), async (req, res, next) => {
  try {
    const { id } = req.params;
    const actor = (req as any).auth;
    const MOCK = process.env.MOCK_MODE === 'true';
    if (MOCK) {
      const poam = (mockStore.poams ?? []).find((x: any) => x.id === id);
      if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
      poam.status = 'risk_accepted';
      poam.approvedByOid = actor?.oid ?? actor?.sub;
      poam.approvedAt = new Date().toISOString();
      poam.riskAcceptanceRationale = req.body.rationale ?? poam.riskAcceptanceRationale;
      await recordAudit(req, {
        action: 'poam.approved',
        entityType: 'poam',
        entityId: id,
        after: { status: 'risk_accepted', approvedByOid: poam.approvedByOid, rationale: poam.riskAcceptanceRationale },
        result: 'Success',
      });
      return res.json(poam);
    }
    const repo = AppDataSource.getRepository(PoamEntity);
    const poam = await repo.findOne({ where: [{ id }, { poamId: id }] });
    if (!poam) return next(createError('POA&M not found', 404, 'NOT_FOUND'));
    poam.status = 'risk_accepted';
    poam.approvedByOid = actor?.oid ?? actor?.sub;
    poam.approvedAt = new Date();
    if (req.body.rationale) poam.riskAcceptanceRationale = req.body.rationale;
    await repo.save(poam);
    await recordAudit(req, {
      action: 'poam.approved',
      entityType: 'poam',
      entityId: poam.id,
      after: { status: 'risk_accepted', approvedByOid: poam.approvedByOid, rationale: poam.riskAcceptanceRationale },
      result: 'Success',
    });
    return res.json(poam);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/poams/bulk-create — generate POA&Ms for all open findings
// ─────────────────────────────────────────────────────────────────────────────
router.post('/bulk-create', requirePermission('poam:write'), async (req, res, next) => {
  try {
    const { machineIds, severity, assignedToOid, assignedToName } = req.body;
    const MOCK = process.env.MOCK_MODE === 'true';

    mockStore.poams = mockStore.poams ?? [];

    const openFindings = MOCK
      ? mockStore.findings.filter((f: any) => {
          if (f.status !== 'open') return false;
          if (machineIds?.length && !machineIds.includes(f.machineId)) return false;
          if (severity && f.severity !== severity) return false;
          // Skip if POA&M already exists
          return !(mockStore.poams ?? []).some((p: any) => p.findingId === f.id);
        })
      : [];

    const created: any[] = [];
    for (const f of openFindings) {
      const ctl = mockStore.controls.find((c: any) => c.id === f.controlId);
      const mac = mockStore.machines.find((m: any) => m.id === f.machineId);
      const poam = {
        id: uuidv4(),
        poamId: nextPoamId(),
        findingId: f.id,
        weakness: ctl?.title ?? f.controlId,
        description: ctl?.description ?? '',
        impact: `CAT ${f.severity === 'high' ? 'I' : f.severity === 'medium' ? 'II' : 'III'} finding on ${mac?.name ?? f.machineId}`,
        status: 'open',
        severity: f.severity,
        scheduledCompletion: dueDateBySeverity(f.severity),
        assignedToOid: assignedToOid ?? null,
        assignedToName: assignedToName ?? null,
        milestones: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStore.poams.push(poam);
      created.push(poam);
    }

    logger.info(`[POAMs] Bulk-created ${created.length} POA&Ms`);
    await recordAudit(req, {
      action: 'poam.bulk_created',
      entityType: 'poam',
      entityId: 'bulk',
      after: { count: created.length, machineIds, severity },
      result: 'Success',
    });
    return res.status(201).json({ created: created.length, poams: created });
  } catch (err) { next(err); }
});

export default router;
