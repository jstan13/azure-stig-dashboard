/**
 * GET /api/controls      — list STIG controls with optional filtering
 * GET /api/controls/:id  — control details + mapping info
 */

import { Router } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { ControlEntity } from '../models/Control';
import { ControlMappingEntity } from '../models/ControlMapping';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { rebuildControlMappings } from '../data/controlMappingSeeder';
import { createError } from '../middleware/errorHandler';
import { parsePage, parsePageSize } from '../utils/paging';

const router = Router();

router.get('/', async (req, res, next) => {
  const { severity, q, page = 1, pageSize = 50 } = req.query;
  const p = parsePage(page);
  const ps = parsePageSize(pageSize, 50, 200);

  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  if (MOCK_MODE) {
    let controls = [...mockStore.controls];
    if (severity) controls = controls.filter((c: any) => c.severity === severity);
    if (q) {
      const lower = String(q).toLowerCase();
      controls = controls.filter(
        (c: any) =>
          c.id.toLowerCase().includes(lower) ||
          c.stigId?.toLowerCase().includes(lower) ||
          c.title?.toLowerCase().includes(lower),
      );
    }
    const total = controls.length;
    return res.json({ data: controls.slice((p - 1) * ps, p * ps), total, page: p, pageSize: ps });
  }

  try {
    const repo = AppDataSource.getRepository(ControlEntity);
    const qb = repo.createQueryBuilder('c').orderBy('c.stigId', 'ASC');
    if (severity) qb.andWhere('c.severity = :sev', { sev: severity });
    if (q) {
      qb.andWhere(
        '(c.id ILIKE :q OR c.stigId ILIKE :q OR c.title ILIKE :q OR c.vulnId ILIKE :q)',
        { q: `%${String(q)}%` },
      );
    }
    const [data, total] = await qb.skip((p - 1) * ps).take(ps).getManyAndCount();
    res.json({ data, total, page: p, pageSize: ps });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/controls/mappings/rebuild
 * Rebuild Azure Policy / Defender → STIG control mappings (direct + transitive).
 * Optional body: { stigVersionId?: string } to limit to one version.
 */
router.post(
  '/mappings/rebuild',
  requirePermission('stig:import'),
  async (req, res, next) => {
    if (process.env.MOCK_MODE === 'true') {
      return res.status(400).json({
        message: 'Mapping rebuild is unavailable in MOCK_MODE (no database).',
      });
    }
    try {
      const { stigVersionId } = req.body ?? {};
      const report = await rebuildControlMappings(AppDataSource, stigVersionId);
      await recordAudit(req, {
        action: 'controls.mappings.rebuilt',
        entityType: 'stig_version',
        entityId: stigVersionId || 'all',
        after: report,
        result: 'Success',
      });
      res.json({ message: 'Control mappings rebuilt', ...report });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/controls/mappings/coverage
 * Report how many controls have at least one Azure source mapping.
 */
router.get('/mappings/coverage', async (_req, res, next) => {
  if (process.env.MOCK_MODE === 'true') {
    return res.json({
      controlsTotal: mockStore.controls.length,
      controlsMapped: mockStore.controls.filter((c: any) => c.azurePolicyId || c.defenderRuleId).length,
      bySource: {},
      mock: true,
    });
  }
  try {
    const controlRepo = AppDataSource.getRepository(ControlEntity);
    const mappingRepo = AppDataSource.getRepository(ControlMappingEntity);

    const controlsTotal = await controlRepo.count();
    const mappings = await mappingRepo.find();
    const mappedControlIds = new Set(mappings.map((m) => m.controlId));

    const bySource: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    for (const m of mappings) {
      bySource[m.sourceType] = (bySource[m.sourceType] ?? 0) + 1;
      const key = `confidence_${m.confidence}`;
      byConfidence[key] = (byConfidence[key] ?? 0) + 1;
    }

    res.json({
      controlsTotal,
      controlsMapped: mappedControlIds.size,
      coveragePercent: controlsTotal
        ? Math.round((mappedControlIds.size / controlsTotal) * 1000) / 10
        : 0,
      mappingsTotal: mappings.length,
      bySource,
      byConfidence,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  if (MOCK_MODE) {
    const control = mockStore.controls.find((c: any) => c.id === req.params.id);
    if (!control) return next(createError('Control not found', 404, 'NOT_FOUND'));
    return res.json(control);
  }
  try {
    const repo = AppDataSource.getRepository(ControlEntity);
    const control = await repo.findOne({ where: { id: req.params.id } });
    if (!control) return next(createError('Control not found', 404, 'NOT_FOUND'));
    res.json(control);
  } catch (err) {
    next(err);
  }
});

export default router;
