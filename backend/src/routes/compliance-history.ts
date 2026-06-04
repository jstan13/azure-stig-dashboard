/**
 * Compliance History API — time-series trend data for dashboards
 *
 * GET /api/compliance-history/:machineId?days=90   — per-machine trend
 * GET /api/compliance-history/rollup?days=30       — fleet-wide daily aggregate
 * POST /api/compliance-history/snapshot            — record snapshot (internal, called by scan orchestrator)
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { ComplianceHistoryEntity } from '../models/ComplianceHistory';
import { Between } from 'typeorm';
import { sendServerError } from '../middleware/errorHandler';
import { requirePermission } from '../middleware/authz';
import { parseDays } from '../utils/paging';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// GET /api/compliance-history/rollup?days=30
router.get('/rollup', async (req: Request, res: Response) => {
  try {
    const days = parseDays(req.query.days, 30);
    const since = new Date();
    since.setDate(since.getDate() - days);

    if (isMock()) {
      // Return generated mock trend data for all machines
      const data = generateMockRollup(days);
      return res.json(data);
    }

    const repo = AppDataSource.getRepository(ComplianceHistoryEntity);
    const rows = await repo
      .createQueryBuilder('h')
      .select([
        'h.snapshotDate AS "date"',
        'AVG(h.score) AS "avgScore"',
        'SUM(h.totalControls) AS "totalControls"',
        'SUM(h.openFindings) AS "openFindings"',
        'SUM("catIOpen") AS "catIOpen"',
        'SUM("catIIOpen") AS "catIIOpen"',
        'SUM("catIIIOpen") AS "catIIIOpen"',
        'SUM(h.resolved) AS "resolved"',
        'COUNT(DISTINCT h.machineId) AS "machineCount"',
      ])
      .where('h.snapshotDate >= :since', { since })
      .groupBy('h.snapshotDate')
      .orderBy('h.snapshotDate', 'ASC')
      .getRawMany();
    return res.json(rows);
  } catch (err: any) {
    return sendServerError(res, '[GET /compliance-history/rollup]', err);
  }
});

// GET /api/compliance-history/:machineId?days=90
router.get('/:machineId', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const days = parseDays(req.query.days, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    if (isMock()) {
      const history = generateMockHistory(machineId, days);
      return res.json(history);
    }

    const repo = AppDataSource.getRepository(ComplianceHistoryEntity);
    const history = await repo.find({
      where: {
        machineId,
        snapshotDate: Between(since, new Date()) as any,
      },
      order: { snapshotDate: 'ASC' },
    });
    return res.json(history);
  } catch (err: any) {
    return sendServerError(res, '[GET /compliance-history/:machineId]', err);
  }
});

// POST /api/compliance-history/snapshot — admin/operator only (Audit #2)
router.post('/snapshot', requirePermission('scan:trigger'), async (req: Request, res: Response) => {
  try {
    const { machineId, score, totalControls, openFindings,
            catIOpen, catIIOpen, catIIIOpen, resolved,
            notApplicable, notReviewed, scanId } = req.body;

    if (!machineId) return res.status(400).json({ error: 'machineId required' });

    const snapshotDate = new Date().toISOString().slice(0, 10);

    if (isMock()) {
      const snap = {
        id: `snap-${Date.now()}`,
        machineId, snapshotDate, score, totalControls,
        openFindings, catIOpen, catIIOpen, catIIIOpen,
        resolved, notApplicable, notReviewed, scanId,
        createdAt: new Date().toISOString(),
      };
      mockStore.complianceHistory.push(snap);
      return res.status(201).json(snap);
    }

    const repo = AppDataSource.getRepository(ComplianceHistoryEntity);
    // Upsert by (machineId, snapshotDate) — one snapshot per machine per day
    const existing = await repo.findOne({ where: { machineId, snapshotDate: snapshotDate as any } });
    const entity = existing
      ? Object.assign(existing, { score, totalControls, openFindings, catIOpen, catIIOpen, catIIIOpen, resolved, notApplicable, notReviewed, scanId })
      : repo.create({ machineId, snapshotDate: snapshotDate as any, score, totalControls, openFindings, catIOpen, catIIOpen, catIIIOpen, resolved, notApplicable, notReviewed, scanId });
    const saved = await repo.save(entity);
    return res.status(201).json(saved);
  } catch (err: any) {
    return sendServerError(res, '[POST /compliance-history/snapshot]', err);
  }
});

// ─── Mock data generators ────────────────────────────────────────────────────

function generateMockHistory(machineId: string, days: number): any[] {
  const data: any[] = [];
  const seed = machineId.charCodeAt(0) % 10;
  let score = 65 + seed;

  for (let i = days; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    score = Math.min(100, Math.max(30, score + (Math.random() - 0.45) * 3));
    const total = 180;
    const open = Math.round(total * (1 - score / 100));
    data.push({
      id: `${machineId}-${i}`,
      machineId,
      snapshotDate: d.toISOString().slice(0, 10),
      score: Math.round(score * 10) / 10,
      totalControls: total,
      openFindings: open,
      catIOpen:   Math.round(open * 0.05),
      catIIOpen:  Math.round(open * 0.45),
      catIIIOpen: Math.round(open * 0.50),
      resolved:   total - open,
      notApplicable: 12,
      notReviewed: 3,
    });
  }
  return data;
}

function generateMockRollup(days: number): any[] {
  const machineCount = 4;
  const data: any[] = [];
  let avgScore = 68;

  for (let i = days; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    avgScore = Math.min(100, Math.max(40, avgScore + (Math.random() - 0.45) * 2));
    data.push({
      date: d.toISOString().slice(0, 10),
      avgScore: Math.round(avgScore * 10) / 10,
      totalControls: 180 * machineCount,
      openFindings: Math.round(180 * machineCount * (1 - avgScore / 100)),
      catIOpen: Math.round(5 * machineCount * (1 - avgScore / 100)),
      resolved: Math.round(180 * machineCount * (avgScore / 100)),
      machineCount,
    });
  }
  return data;
}

export default router;
