/**
 * GET  /api/machines          — list machines (paginated, filterable)
 * GET  /api/machines/:id      — machine details + control findings
 */

import { Router } from 'express';
import { ILike } from 'typeorm';
import { AppDataSource, mockStore } from '../database/dataSource';
import { MachineEntity } from '../models/Machine';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { createError } from '../middleware/errorHandler';
import { recordAudit } from '../auth';
import { requireRole } from '../middleware/auth';
import { parsePage, parsePageSize } from '../utils/paging';

const router = Router();
const MOCK_MODE = () => process.env.MOCK_MODE === 'true';

// GET /api/machines
router.get('/', async (req, res, next) => {
  const { page = 1, pageSize = 20, q, status, subscriptionId, resourceGroup } = req.query;
  const p = parsePage(page);
  const ps = parsePageSize(pageSize, 20, 100);

  if (MOCK_MODE()) {
    let machines = [...mockStore.machines];

    // Filtering
    if (q) {
      const lower = String(q).toLowerCase();
      machines = machines.filter((m: any) =>
        m.name.toLowerCase().includes(lower) ||
        m.resourceGroupName.toLowerCase().includes(lower),
      );
    }
    if (status) machines = machines.filter((m: any) => m.status === status);
    if (subscriptionId) machines = machines.filter((m: any) => m.subscriptionId === subscriptionId);
    if (resourceGroup) machines = machines.filter((m: any) => m.resourceGroupName === resourceGroup);

    const total = machines.length;
    const data = machines.slice((p - 1) * ps, p * ps);
    return res.json({ data, total, page: p, pageSize: ps });
  }

  // ── Real DB-backed path ─────────────────────────────────────────────
  try {
    const repo = AppDataSource.getRepository(MachineEntity);
    const qb = repo.createQueryBuilder('m').orderBy('m.name', 'ASC');
    if (q) {
      qb.andWhere('(m.name ILIKE :q OR m.resourceGroupName ILIKE :q)', {
        q: `%${String(q)}%`,
      });
    }
    if (status) qb.andWhere('m.status = :status', { status });
    if (subscriptionId)
      qb.andWhere('m.subscriptionId = :sub', { sub: subscriptionId });
    if (resourceGroup)
      qb.andWhere('m.resourceGroupName = :rg', { rg: resourceGroup });
    const [data, total] = await qb
      .skip((p - 1) * ps)
      .take(ps)
      .getManyAndCount();
    res.json({ data, total, page: p, pageSize: ps });
  } catch (err) {
    next(err);
  }
});

// GET /api/machines/:id
router.get('/:id', async (req, res, next) => {
  if (MOCK_MODE()) {
    const machine = mockStore.machines.find((m: any) => m.id === req.params.id);
    if (!machine) return next(createError('Machine not found', 404, 'NOT_FOUND'));

    const findings = mockStore.findings
      .filter((f: any) => f.machineId === machine.id)
      .map((f: any) => {
        const control = mockStore.controls.find((c: any) => c.id === f.controlId);
        return { ...f, control };
      });

    const open = findings.filter((f: any) => f.status === 'open').length;
    const notAFinding = findings.filter((f: any) => f.status === 'not_a_finding').length;
    const notApplicable = findings.filter((f: any) => f.status === 'not_applicable').length;
    const notReviewed = findings.filter((f: any) => f.status === 'not_reviewed').length;
    const denom = findings.length - notApplicable;

    return res.json({
      ...machine,
      findings,
      summary: {
        total: findings.length,
        open,
        notAFinding,
        notApplicable,
        notReviewed,
        complianceScore: denom > 0 ? Math.round((notAFinding / denom) * 100) : 0,
      },
    });
  }

  // ── Real DB-backed path ─────────────────────────────────────────────
  try {
    const machineRepo = AppDataSource.getRepository(MachineEntity);
    const findingRepo = AppDataSource.getRepository(FindingEntity);
    const controlRepo = AppDataSource.getRepository(ControlEntity);
    const machine = await machineRepo.findOne({ where: { id: req.params.id } });
    if (!machine) return next(createError('Machine not found', 404, 'NOT_FOUND'));
    const rawFindings = await findingRepo.find({ where: { machineId: machine.id } });
    const controlIds = Array.from(new Set(rawFindings.map((f) => f.controlId)));
    const controls = controlIds.length
      ? await controlRepo.findByIds(controlIds)
      : [];
    const controlById = new Map(controls.map((c) => [c.id, c]));
    const findings = rawFindings.map((f) => ({
      ...f,
      control: controlById.get(f.controlId) ?? null,
    }));
    const open = findings.filter((f) => f.status === 'open').length;
    const notAFinding = findings.filter((f) => f.status === 'not_a_finding').length;
    const notApplicable = findings.filter((f) => f.status === 'not_applicable').length;
    const notReviewed = findings.filter((f) => f.status === 'not_reviewed').length;
    const denom = findings.length - notApplicable;
    return res.json({
      ...machine,
      findings,
      summary: {
        total: findings.length,
        open,
        notAFinding,
        notApplicable,
        notReviewed,
        complianceScore: denom > 0 ? Math.round((notAFinding / denom) * 100) : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/machines/:machineId/findings/:findingId
router.patch('/:machineId/findings/:findingId', requireRole('admin', 'operator'), async (req, res, next) => {
  const { status, comments, findingDetails } = req.body;

  if (MOCK_MODE()) {
    const finding = mockStore.findings.find(
      (f: any) => f.id === req.params.findingId && f.machineId === req.params.machineId,
    );
    if (!finding) return next(createError('Finding not found', 404, 'NOT_FOUND'));

    const before = {
      status: finding.status,
      comments: finding.comments,
      findingDetails: finding.findingDetails,
    };

    if (status) finding.status = status;
    if (comments !== undefined) finding.comments = comments;
    if (findingDetails !== undefined) finding.findingDetails = findingDetails;
    finding.lastUpdated = new Date().toISOString();

    // Update machine compliance score
    const machine = mockStore.machines.find((m: any) => m.id === req.params.machineId);
    if (machine) {
      const machineFIndings = mockStore.findings.filter((f: any) => f.machineId === machine.id);
      const applicable = machineFIndings.filter((f: any) => f.status !== 'not_applicable');
      const passing = machineFIndings.filter((f: any) => f.status === 'not_a_finding');
      machine.complianceScore = applicable.length
        ? Math.round((passing.length / applicable.length) * 100)
        : 0;
    }

    await recordAudit(req, {
      action: 'finding.updated',
      entityType: 'finding',
      entityId: finding.id,
      before,
      after: {
        status: finding.status,
        comments: finding.comments,
        findingDetails: finding.findingDetails,
      },
      result: 'Success',
    });

    return res.json(finding);
  }

  // ── Real DB-backed path ─────────────────────────────────────────────
  try {
    const findingRepo = AppDataSource.getRepository(FindingEntity);
    const machineRepo = AppDataSource.getRepository(MachineEntity);
    const finding = await findingRepo.findOne({
      where: { id: req.params.findingId, machineId: req.params.machineId },
    });
    if (!finding) return next(createError('Finding not found', 404, 'NOT_FOUND'));

    const before = {
      status: finding.status,
      comments: finding.comments,
      findingDetails: finding.findingDetails,
    };

    if (status !== undefined) finding.status = status;
    if (comments !== undefined) finding.comments = comments;
    if (findingDetails !== undefined) finding.findingDetails = findingDetails;
    await findingRepo.save(finding);

    // Recompute machine compliance score
    const machine = await machineRepo.findOne({ where: { id: req.params.machineId } });
    if (machine) {
      const all = await findingRepo.find({ where: { machineId: machine.id } });
      const applicable = all.filter((f) => f.status !== 'not_applicable');
      const passing = all.filter((f) => f.status === 'not_a_finding');
      machine.complianceScore = applicable.length
        ? Math.round((passing.length / applicable.length) * 100)
        : 0;
      await machineRepo.save(machine);
    }

    await recordAudit(req, {
      action: 'finding.updated',
      entityType: 'finding',
      entityId: finding.id,
      before,
      after: {
        status: finding.status,
        comments: finding.comments,
        findingDetails: finding.findingDetails,
      },
      result: 'Success',
    });

    return res.json(finding);
  } catch (err) {
    next(err);
  }
});

export default router;
