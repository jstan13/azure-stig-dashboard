import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  // Audit #14: do NOT leak mockMode to unauthenticated probes.
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

export default router;
