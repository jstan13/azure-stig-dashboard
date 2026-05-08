/**
 * POST /api/scan/trigger  — trigger a scan
 * GET  /api/scan          — list recent scans
 * GET  /api/scan/:id      — get scan details
 */

import { Router } from 'express';
import { ScanOrchestrator } from '../connectors/scanOrchestrator';
import { requireRole } from '../middleware/auth';
import { recordAudit } from '../auth';
import { mockStore } from '../database/dataSource';
import { createError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const router = Router();
const orchestrator = new ScanOrchestrator();

// POST /api/scan/trigger
router.post(
  '/trigger',
  requireRole('admin', 'operator'),
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
          result: 'Failure',
        });
      } catch (auditErr) {
        logger.error('[Scan] failure-audit write failed', auditErr);
      }
      next(err);
    }
  },
);

// GET /api/scan
router.get('/', async (_req, res) => {
  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  if (MOCK_MODE) {
    return res.json({
      data: mockStore.scans,
      total: mockStore.scans.length,
      page: 1,
      pageSize: 20,
    });
  }
  // TODO: query DB
  res.json({ data: [], total: 0, page: 1, pageSize: 20 });
});

// GET /api/scan/:id
router.get('/:id', async (req, res, next) => {
  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  if (MOCK_MODE) {
    const scan = mockStore.scans.find((s: any) => s.id === req.params.id);
    if (!scan) return next(createError('Scan not found', 404, 'NOT_FOUND'));
    return res.json(scan);
  }
  // TODO: query DB
  next(createError('Scan not found', 404, 'NOT_FOUND'));
});

export default router;
