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
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import { parsePage, parsePageSize } from '../utils/paging';
import { logger } from '../utils/logger';
import { z } from 'zod';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

function getMaxMachinesPerJob(): number {
  const parsed = Number.parseInt(process.env.REMEDIATION_MAX_MACHINES ?? '50', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return parsed;
}

const createRemediationJobSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  machineIds: z.array(z.string().trim().min(1)).min(1),
  findingIds: z.array(z.string().trim().min(1)).min(1),
  benchmarkId: z.string().trim().min(1).optional().nullable(),
  stigVersion: z.string().trim().min(1).optional().nullable(),
  severity: z.string().trim().min(1).max(50).optional().nullable(),
  strategy: z.enum(['dsc_push', 'azure_policy', 'manual']).default('dsc_push'),
});

// GET /api/remediation/jobs
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const safeLimit = parsePageSize(limit, 20, 200);
    const skip = (parsePage(page) - 1) * safeLimit;

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
    return sendServerError(res, '[GET /remediation/jobs]', err);
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
    return sendServerError(res, '[GET /remediation/jobs/:id]', err);
  }
});

// POST /api/remediation/jobs — create and queue job (admin/operator only)
router.post('/jobs', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  try {
    const parse = createRemediationJobSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid remediation payload', details: parse.error.flatten() });
    }

    const {
      name, machineIds, findingIds, benchmarkId, stigVersion, severity, strategy,
    } = parse.data;

    const requester = (req as any).auth;
    const triggeredByOid  = requester?.oid  ?? 'system';
    const triggeredByName = requester?.name ?? 'System';

    if (!machineIds?.length || !findingIds?.length) {
      return res.status(400).json({ error: 'machineIds and findingIds are required' });
    }

    const maxMachines = getMaxMachinesPerJob();
    if (machineIds.length > maxMachines) {
      return res.status(400).json({
        error: `Remediation job exceeds machine cap (${maxMachines}). Split into smaller batches.`,
      });
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
      approvalRequired: true,
      approved: false,
      approvedByOid: null,
      approvedByName: null,
      approvedAt: null,
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

    await recordAudit(req, {
      action: 'remediation.queued_for_approval',
      entityType: 'remediation_job',
      entityId: savedJob.id,
      after: {
        machineIds, findingIds, benchmarkId, stigVersion, strategy, severity,
        approvalRequired: true,
        approved: false,
        maxMachines,
        totalItems: jobData.totalItems,
      },
      result: 'Success',
    });

    return res.status(202).json(savedJob);
  } catch (err: any) {
    return sendServerError(res, '[POST /remediation/jobs]', err);
  }
});

// POST /api/remediation/jobs/:id/approve — second-person approval gate
router.post('/jobs/:id/approve', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const approver = (req as any).auth;
    const approverOid = approver?.oid ?? approver?.sub;
    const approverName = approver?.name ?? 'Unknown';

    if (!approverOid) {
      return res.status(401).json({ error: 'Approver identity missing from token' });
    }

    if (isMock()) {
      const job = mockStore.remediationJobs.find((j: any) => j.id === id);
      if (!job) return res.status(404).json({ error: 'Not found' });
      if (job.approved) return res.status(409).json({ error: 'Job already approved' });
      if (job.status !== 'pending') return res.status(409).json({ error: `Job is ${job.status}; only pending jobs can be approved` });
      if (job.triggeredByOid === approverOid) {
        return res.status(403).json({ error: 'A different operator must approve this job (4-eyes required)' });
      }

      const before = { status: job.status, approved: !!job.approved };
      job.approved = true;
      job.approvedByOid = approverOid;
      job.approvedByName = approverName;
      job.approvedAt = new Date().toISOString();
      job.status = 'pending';

      setImmediate(() => executeRemediationJob(job.id).catch((e) =>
        logger.error(`[Remediation] Job ${job.id} execution error: ${e.message}`),
      ));

      await recordAudit(req, {
        action: 'remediation.approved',
        entityType: 'remediation_job',
        entityId: id,
        before,
        after: {
          status: job.status,
          approved: job.approved,
          approvedByOid: job.approvedByOid,
          approvedByName: job.approvedByName,
          approvedAt: job.approvedAt,
        },
        result: 'Success',
      });

      return res.json(job);
    }

    const repo = AppDataSource.getRepository(RemediationJobEntity);
    const job = await repo.findOne({ where: { id } });
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.approved) return res.status(409).json({ error: 'Job already approved' });
    if (job.status !== 'pending') return res.status(409).json({ error: `Job is ${job.status}; only pending jobs can be approved` });
    if (job.triggeredByOid === approverOid) {
      return res.status(403).json({ error: 'A different operator must approve this job (4-eyes required)' });
    }

    const before = { status: job.status, approved: job.approved };
    job.approved = true;
    job.approvedByOid = approverOid;
    job.approvedByName = approverName;
    job.approvedAt = new Date();
    job.status = 'pending';
    const saved = await repo.save(job);

    setImmediate(() => executeRemediationJob(saved.id).catch((e) =>
      logger.error(`[Remediation] Job ${saved.id} execution error: ${e.message}`),
    ));

    await recordAudit(req, {
      action: 'remediation.approved',
      entityType: 'remediation_job',
      entityId: id,
      before,
      after: {
        status: saved.status,
        approved: saved.approved,
        approvedByOid: saved.approvedByOid,
        approvedByName: saved.approvedByName,
        approvedAt: saved.approvedAt,
      },
      result: 'Success',
    });

    return res.json(saved);
  } catch (err: any) {
    return sendServerError(res, '[POST /remediation/jobs/:id/approve]', err);
  }
});

// POST /api/remediation/jobs/:id/cancel \u2014 admin/operator only (Audit #2)
router.post('/jobs/:id/cancel', requireRole('admin', 'operator'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (isMock()) {
      const job = mockStore.remediationJobs.find((j: any) => j.id === id);
      if (!job) return res.status(404).json({ error: 'Not found' });
      const before = { status: job.status };
      if (job.status === 'running') job.status = 'failed';
      await recordAudit(req, {
        action: 'remediation.cancelled',
        entityType: 'remediation_job',
        entityId: id,
        before,
        after: { status: job.status },
        result: 'Success',
      });
      return res.json(job);
    }
    const repo = AppDataSource.getRepository(RemediationJobEntity);
    const job = await repo.findOne({ where: { id } });
    if (!job) return res.status(404).json({ error: 'Not found' });
    const before = { status: job.status };
    if (job.status === 'running') {
      job.status = 'failed';
      await repo.save(job);
    }
    await recordAudit(req, {
      action: 'remediation.cancelled',
      entityType: 'remediation_job',
      entityId: id,
      before,
      after: { status: job.status },
      result: 'Success',
    });
    return res.json(job);
  } catch (err: any) {
    return sendServerError(res, '[POST /remediation/jobs/:id/cancel]', err);
  }
});

// ─── Background execution ────────────────────────────────────────────────────

async function executeRemediationJob(jobId: string): Promise<void> {
  const { runRemediationJob } = await import('../scanning/remediationRunner');
  await runRemediationJob(jobId);
}

export default router;
