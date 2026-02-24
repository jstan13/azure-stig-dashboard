/**
 * GET /api/controls      — list STIG controls with optional filtering
 * GET /api/controls/:id  — control details + mapping info
 */

import { Router } from 'express';
import { mockStore } from '../database/dataSource';
import { createError } from '../middleware/errorHandler';

const router = Router();

router.get('/', (req, res) => {
  const { severity, q, page = 1, pageSize = 50 } = req.query;
  const p = Number(page);
  const ps = Math.min(Number(pageSize), 200);

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

  res.json({ data: [], total: 0, page: p, pageSize: ps });
});

router.get('/:id', (req, res, next) => {
  const MOCK_MODE = process.env.MOCK_MODE === 'true';
  if (MOCK_MODE) {
    const control = mockStore.controls.find((c: any) => c.id === req.params.id);
    if (!control) return next(createError('Control not found', 404, 'NOT_FOUND'));
    return res.json(control);
  }
  next(createError('Control not found', 404, 'NOT_FOUND'));
});

export default router;
