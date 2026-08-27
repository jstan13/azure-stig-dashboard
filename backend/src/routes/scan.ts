/**
 * POST /api/scan/trigger  — trigger a scan
 * GET  /api/scan          — list recent scans
 * GET  /api/scan/:id      — get scan details
 */

import { Router } from 'express';
import { ScanOrchestrator } from '../connectors/scanOrchestrator';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { AppDataSource, mockStore } from '../database/dataSource';
import { ScanEntity } from '../models/Scan';
import { createError } from '../middleware/errorHandler';
import { parsePage, parsePageSize } from '../utils/paging';
import { logger } from '../utils/logger';
import { z } from 'zod';
import {
  getScanPolicy, saveScanPolicy, scanPolicyResponse,
} from '../services/scanPolicyService';

const router = Router();
const orchestrator = new ScanOrchestrator();

const scheduleSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['hourly', 'daily', 'weekly']),
  minute: z.number().int().min(0).max(59),
  hour: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6),
  timeZone: z.string().trim().min(1).max(64),
});

router.get('/schedule', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    res.json(scanPolicyResponse(await getScanPolicy()));
  } catch (err) {
    next(err);
  }
});

router.put('/schedule', requirePermission('scan:schedule'), async (req, res, next) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  try {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timeZone });
    } catch {
      return res.status(400).json({ error: `Unknown time zone: ${parsed.data.timeZone}` });
    }
    const policy = await getScanPolicy();
    const before = scanPolicyResponse(policy);
    Object.assign(policy, parsed.data);
    const saved = await saveScanPolicy(policy);
    const after = scanPolicyResponse(saved);
    await recordAudit(req, {
      action: 'scan_schedule.changed',
      entityType: 'scan_policy',
      entityId: 'singleton',
      before,
      after,
      result: 'Success',
    });
    return res.json(after);
  } catch (err) {
    return next(err);
  }
});

// POST /api/scan/trigger
router.post(
  '/trigger',
  requirePermission('scan:trigger'),
  async (req, res, next) => {
    const { subscriptionIds, resourceGroupNames, resourceIds, since } = req.body;
    const actor = (req as any).auth?.email || (req as any).auth?.sub || 'api';
    const targetId = resourceIds?.[0] || subscriptionIds?.[0] || 'all';
    const targetType = resourceIds ? 'machine' : 'subscription';

    try {
      const result = await orchestrator.runScan({
        subscriptionIds,
        resourceGroupNames,
        resourceIds,
        since: since ? new Date(since) : undefined,
      });

      await recordAudit(req, {
        action: 'scan.triggered',
        entityType: targetType,
        entityId: targetId,
        after: { subscriptionIds, resourceGroupNames, resourceIds, scanId: result.scanId },
        result: 'Success',
      });

      logger.info(`[Scan] Triggered by ${actor}: scanId=${result.scanId}`);
      res.status(202).json({ message: 'Scan initiated', ...result });
    } catch (err: any) {
      // Audit #11 / Constitution Principle II \u2014 record failure rows.
      try {
        await recordAudit(req, {
          action: 'scan.triggered',
          entityType: targetType,
          entityId: targetId,
          after: { subscriptionIds, resourceGroupNames, resourceIds, error: err?.message },
          result: 'Error',
        });
      } catch (auditErr) {
        logger.error('[Scan] failure-audit write failed', auditErr);
      }
      next(err);
    }
  },
);

// GET /api/scan
router.get('/', async (req, res, next) => {
  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  const { page = '1', pageSize = '20', machineId } = req.query as Record<string, string>;
  const p = parsePage(page);
  const ps = parsePageSize(pageSize, 20, 200);

  if (MOCK_MODE) {
    let scans = [...mockStore.scans];
    if (machineId) scans = scans.filter((s: any) => s.machineId === machineId);
    return res.json({
      data: scans.slice((p - 1) * ps, p * ps),
      total: scans.length,
      page: p,
      pageSize: ps,
    });
  }
  try {
    const repo = AppDataSource.getRepository(ScanEntity);
    const qb = repo.createQueryBuilder('s').orderBy('s.startedAt', 'DESC');
    if (machineId) qb.andWhere('s.machineId = :mid', { mid: machineId });
    const [data, total] = await qb.skip((p - 1) * ps).take(ps).getManyAndCount();
    res.json({ data, total, page: p, pageSize: ps });
  } catch (err) {
    next(err);
  }
});

// GET /api/scan/:id
router.get('/:id', async (req, res, next) => {
  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  if (MOCK_MODE) {
    const scan = mockStore.scans.find((s: any) => s.id === req.params.id);
    if (!scan) return next(createError('Scan not found', 404, 'NOT_FOUND'));
    return res.json(scan);
  }
  try {
    const repo = AppDataSource.getRepository(ScanEntity);
    const scan = await repo.findOne({ where: { id: req.params.id } });
    if (!scan) return next(createError('Scan not found', 404, 'NOT_FOUND'));
    res.json(scan);
  } catch (err) {
    next(err);
  }
});

export default router;
