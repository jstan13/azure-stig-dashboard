/**
 * POA&M API Routes
 *
 * GET    /api/poams                 — list all POA&Ms (filterable)
 * GET    /api/poams/:id             — single POA&M detail
 * POST   /api/poams                 — create new POA&M (from existing finding)
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
import { requireRole } from '../middleware/auth';
import { createError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { generatePoamCsv } from '../exporters/poamExporter';

const router = Router();

// ── sequential POA&M counter (in-memory for mock; DB sequence in production) ──
let mockPoamCounter = 100;
function nextPoamId() {
  return `POA-${new Date().getFullYear()}-${String(++mockPoamCounter).padStart(4, '0')}`;
}

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
router.get('/', async (req, res, next) => {
  try {
    const {
      status, severity, assignedToOid, q,
      page = '1', pageSize = '50',
      overdue,
    } = req.query as Record<string, string>;

    const p = Math.max(1, parseInt(page));
    const ps = Math.min(200, parseInt(pageSize));
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
router.get('/export', requireRole('admin', 'operator', 'auditor'), async (req, res, next) => {
  try {
    const { format = 'csv', status = 'open' } = req.query as Record<string, string>;
    const MOCK = process.env.MOCK_MODE === 'true';

    let items: any[] = MOCK
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
router.get('/:id', async (req, res, next) => {
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
router.post('/', requireRole('admin', 'operator'), async (req, res, next) => {
  try {
    const {
      findingId, weakness, description, impact, scheduledCompletion,
      assignedToOid, assignedToName, issoOid, countermeasures, resourcesRequired,
    } = req.body;

    if (!findingId || !weakness) {
      return next(createError('findingId and weakness are required', 400, 'VALIDATION_ERROR'));
    }

    const MOCK = process.env.MOCK_MODE === 'true';
    mockStore.poams = mockStore.poams ?? [];

    if (MOCK) {
      const finding = mockStore.findings.find((f: any) => f.id === findingId);
      if (!finding) return next(createError('Finding not found', 404, 'NOT_FOUND'));

      const poam = {
        id: uuidv4(),
        poamId: nextPoamId(),
        findingId,
        finding,
        weakness,
        description,
        impact,
        status: 'open',
        severity: finding.severity,
        scheduledCompletion: scheduledCompletion ?? dueDateBySeverity(finding.severity),
        assignedToOid, assignedToName, issoOid,
        countermeasures, resourcesRequired,
        milestones: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStore.poams.push(poam);
      return res.status(201).json(poam);
    }

    const findingRepo = AppDataSource.getRepository(FindingEntity);
    const finding = await findingRepo.findOne({ where: { id: findingId } });
    if (!finding) return next(createError('Finding not found', 404, 'NOT_FOUND'));

    const poam = AppDataSource.getRepository(PoamEntity).create({
      findingId,
      poamId: nextPoamId(),
      weakness,
      description,
      impact,
      status: 'open',
      scheduledCompletion: scheduledCompletion ?? dueDateBySeverity(finding.severity),
      assignedToOid,
      assignedToName,
      issoOid,
      countermeasures,
      resourcesRequired,
    });

    await AppDataSource.getRepository(PoamEntity).save(poam);
    return res.status(201).json(poam);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/poams/:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', requireRole('admin', 'operator'), async (req, res, next) => {
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
      for (const k of updatable) {
        if (req.body[k] !== undefined) mockStore.poams[idx][k] = req.body[k];
      }
      if (req.body.status === 'resolved' || req.body.status === 'closed') {
        mockStore.poams[idx].actualCompletion = new Date().toISOString();
      }
      mockStore.poams[idx].updatedAt = new Date().toISOString();
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
router.post('/:id/milestones', requireRole('admin', 'operator'), async (req, res, next) => {
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
router.patch('/:id/milestones/:mid', requireRole('admin', 'operator'), async (req, res, next) => {
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
router.delete('/:id/milestones/:mid', requireRole('admin', 'operator'), async (req, res, next) => {
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
router.post('/:id/approve', requireRole('admin'), async (req, res, next) => {
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
    return res.json(poam);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/poams/bulk-create — generate POA&Ms for all open findings
// ─────────────────────────────────────────────────────────────────────────────
router.post('/bulk-create', requireRole('admin', 'operator'), async (req, res, next) => {
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
    return res.status(201).json({ created: created.length, poams: created });
  } catch (err) { next(err); }
});

export default router;
