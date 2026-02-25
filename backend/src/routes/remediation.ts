/**
 * Bulk Remediation API
 *
 * POST   /api/remediation/jobs           — create & enqueue remediation job
 * GET    /api/remediation/jobs           — list jobs (paginated)
 * GET    /api/remediation/jobs/:id       — get single job + result log
 * POST   /api/remediation/jobs/:id/cancel — cancel running job
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { RemediationJobEntity } from '../models/RemediationJob';
import { requireRole } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// GET /api/remediation/jobs
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const safeLimit = Math.min(Number(limit), 200);
    const skip = (Number(page) - 1) * safeLimit;

    if (isMock()) {
      let jobs = [...mockStore.remediationJobs];
      if (status) jobs = jobs.filter((j: any) => j.status === status);
      return res.json({ jobs: jobs.slice(skip, skip + safeLimit), total: jobs.length });
    }

    const repo = AppDataSource.getRepository(RemediationJobEntity);
    const qb = repo.createQueryBuilder('j').orderBy('j.createdAt', 'DESC').skip(skip).take(safeLimit);
    if (status) qb.where('j.status = :status', { status });
    const [jobs, total] = await qb.getManyAndCount();
    return res.json({ jobs, total });
  } catch (err: any) {
    logger.error('[GET /remediation/jobs]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/remediation/jobs/:id
router.get('/jobs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (isMock()) {
      const job = mockStore.remediationJobs.find((j: any) => j.id === id);
      return job ? res.json(job) : res.status(404).json({ error: 'Not found' });
    }
    const repo = AppDataSource.getRepository(RemediationJobEntity);
    const job = await repo.findOne({ where: { id } });
    return job ? res.json(job) : res.status(404).json({ error: 'Not found' });
  } catch (err: any) {
    logger.error('[GET /remediation/jobs/:id]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/remediation/jobs — create and queue job (admin/operator only)
router.post('/jobs', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  try {
    const {
      name, machineIds, findingIds, benchmarkId, stigVersion,
      severity, strategy = 'dsc_push',
    } = req.body;

    const requester = (req as any).auth;
    const triggeredByOid  = requester?.oid  ?? 'system';
    const triggeredByName = requester?.name ?? 'System';

    if (!machineIds?.length || !findingIds?.length) {
      return res.status(400).json({ error: 'machineIds and findingIds are required' });
    }

    const jobData: any = {
      name:            name ?? `Remediation ${new Date().toISOString().slice(0, 10)}`,
      status:          'pending',
      strategy,
      machineIds,
      findingIds,
      benchmarkId:     benchmarkId ?? null,
      stigVersion:     stigVersion ?? null,
      severity:        severity ?? null,
      triggeredByOid,
      triggeredByName,
      totalItems:      machineIds.length * findingIds.length,
      succeeded:       0,
      failed:          0,
      skipped:         0,
      resultLog:       [],
      startedAt:       null,
      completedAt:     null,
      createdAt:       new Date().toISOString(),
    };

    let savedJob: any;
    if (isMock()) {
      savedJob = { ...jobData, id: `rem-${Date.now()}` };
      mockStore.remediationJobs.push(savedJob);
    } else {
      const repo = AppDataSource.getRepository(RemediationJobEntity);
      const entity = repo.create(jobData);
      savedJob = await repo.save(entity);
    }

    // Enqueue asynchronous execution (non-blocking)
    setImmediate(() => executeRemediationJob(savedJob.id).catch((e) =>
      logger.error(`[Remediation] Job ${savedJob.id} execution error: ${e.message}`),
    ));

    return res.status(202).json(savedJob);
  } catch (err: any) {
    logger.error('[POST /remediation/jobs]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/remediation/jobs/:id/cancel
router.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (isMock()) {
      const job = mockStore.remediationJobs.find((j: any) => j.id === id);
      if (!job) return res.status(404).json({ error: 'Not found' });
      if (job.status === 'running') job.status = 'failed';
      return res.json(job);
    }
    const repo = AppDataSource.getRepository(RemediationJobEntity);
    const job = await repo.findOne({ where: { id } });
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.status === 'running') {
      job.status = 'failed';
      await repo.save(job);
    }
    return res.json(job);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Background execution ────────────────────────────────────────────────────

async function executeRemediationJob(jobId: string): Promise<void> {
  const { runRemediationJob } = await import('../scanning/remediationRunner');
  await runRemediationJob(jobId);
}

export default router;
