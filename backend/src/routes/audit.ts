/**
 * GET /api/audit  — paginated audit log timeline
 */

import { Router } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { AuditLogEntity } from '../models/AuditLog';
import { requireRole } from '../middleware/auth';
import { parsePage, parsePageSize } from '../utils/paging';

const router = Router();

router.get(
  '/',
  requireRole('admin', 'auditor'),
  async (req, res, next) => {
    const { page = 1, pageSize = 50, targetId, action } = req.query;
    const p = parsePage(page);
    const ps = parsePageSize(pageSize, 50, 200);

    const MOCK_MODE = process.env.MOCK_MODE === 'true';
    if (MOCK_MODE) {
      let logs = [...mockStore.auditLogs];
      if (targetId) logs = logs.filter((l: any) => l.targetId === targetId);
      if (action) logs = logs.filter((l: any) => l.action === action);
      logs.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return res.json({
        data: logs.slice((p - 1) * ps, p * ps),
        total: logs.length,
        page: p,
        pageSize: ps,
      });
    }

    try {
      const repo = AppDataSource.getRepository(AuditLogEntity);
      const qb = repo.createQueryBuilder('a').orderBy('a.timestamp', 'DESC');
      if (targetId) qb.andWhere('a.targetId = :tid', { tid: targetId });
      if (action) qb.andWhere('a.action = :act', { act: action });
      const [data, total] = await qb
        .skip((p - 1) * ps)
        .take(ps)
        .getManyAndCount();
      res.json({ data, total, page: p, pageSize: ps });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
