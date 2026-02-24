/**
 * GET /api/audit  — paginated audit log timeline
 */

import { Router } from 'express';
import { mockStore } from '../database/dataSource';
import { requireRole } from '../middleware/auth';

const router = Router();

router.get(
  '/',
  requireRole('admin', 'auditor'),
  (req, res) => {
    const { page = 1, pageSize = 50, targetId, action } = req.query;
    const p = Number(page);
    const ps = Math.min(Number(pageSize), 200);

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

    res.json({ data: [], total: 0, page: p, pageSize: ps });
  },
);

export default router;
