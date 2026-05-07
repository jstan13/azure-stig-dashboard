/**
 * STIG Management API Routes
 *
 * GET  /api/stigs                            — list all benchmarks (with update-available flag)
 * GET  /api/stigs/:benchmarkId               — benchmark detail + version history
 * GET  /api/stigs/:benchmarkId/controls      — paginated controls for latest active version
 * POST /api/stigs/import                     — trigger STIG import (admin/operator)
 * POST /api/stigs/update-check               — run catalog update check (admin/operator)
 * GET  /api/stigs/update-check/status        — status of last update check
 * POST /api/stigs/:benchmarkId/scan          — trigger PowerSTIG scan of all machines for this STIG
 */

import { Router } from 'express';
import { ILike, In } from 'typeorm';
import { AppDataSource } from '../database/dataSource';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import { StigVersionEntity } from '../models/StigVersion';
import { ControlEntity } from '../models/Control';
import { MachineEntity } from '../models/Machine';
import { requireRole } from '../middleware/auth';
import { recordAudit } from '../auth';
import { createError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { importStigs, DEFAULT_BENCHMARKS } from '../stigs/stigImporter';
import { checkForUpdates, runQuarterlyImport } from '../stigs/stigUpdateScheduler';
import { runPowerStigAudit } from '../scanning/powerStigRunner';
import { parseStigResults } from '../scanning/dscResultParser';

const router = Router();

// ── In-memory update check state (cleared/set by scheduler) ──────────────────
export interface UpdateCheckStatus {
  running: boolean;
  lastRun?: Date;
  results?: Array<{
    benchmarkId: string;
    title: string;
    installedVersion: string | null;
    availableVersion: string | null;
    updateAvailable: boolean;
  }>;
  error?: string;
}
export const updateCheckStatus: UpdateCheckStatus = { running: false };

// ── Mock data ─────────────────────────────────────────────────────────────────
const MOCK_BENCHMARKS = [
  {
    benchmarkId:           'Windows_10_STIG',
    title:                 'Microsoft Windows 10 Security Technical Implementation Guide',
    category:              'Operating System',
    platform:              'Windows',
    latestInstalledVersion:'V2R8',
    latestAvailableVersion:'V2R9',
    sourceUrl:             'https://public.cyber.mil/stigs/downloads/',
    lastContentUpdate:     new Date('2024-01-15'),
    active:                true,
    versions: [
      { version: 'V2R9', benchmarkDate: '2024-01-15', ruleCount: 276, catICount: 5, catIICount: 248, catIIICount: 23, status: 'active' },
      { version: 'V2R8', benchmarkDate: '2023-10-25', ruleCount: 275, catICount: 5, catIICount: 247, catIIICount: 23, status: 'superseded' },
    ],
  },
  {
    benchmarkId:           'Windows_Server_2022_STIG',
    title:                 'Microsoft Windows Server 2022 Security Technical Implementation Guide',
    category:              'Operating System',
    platform:              'Windows',
    latestInstalledVersion:'V2R2',
    latestAvailableVersion:'V2R2',
    sourceUrl:             'https://public.cyber.mil/stigs/downloads/',
    lastContentUpdate:     new Date('2023-10-25'),
    active:                true,
    versions: [
      { version: 'V2R2', benchmarkDate: '2023-10-25', ruleCount: 291, catICount: 6, catIICount: 254, catIIICount: 31, status: 'active' },
    ],
  },
  {
    benchmarkId:           'MS_Edge_STIG',
    title:                 'Microsoft Edge Security Technical Implementation Guide',
    category:              'Browser',
    platform:              'Windows',
    latestInstalledVersion:'V2R1',
    latestAvailableVersion:'V2R1',
    sourceUrl:             'https://public.cyber.mil/stigs/downloads/',
    lastContentUpdate:     new Date('2023-07-24'),
    active:                true,
    versions: [
      { version: 'V2R1', benchmarkDate: '2023-07-24', ruleCount: 96, catICount: 2, catIICount: 88, catIIICount: 6, status: 'active' },
    ],
  },
];

const MOCK_CONTROLS = Array.from({ length: 20 }, (_, i) => ({
  id:             `Windows_10_STIG|V-22070${i}`,
  vulnId:         `V-22070${i}`,
  ruleId:         `SV-22070${i}r123456_rule`,
  title:          `Sample Control ${i + 1}`,
  severity:       ['high', 'medium', 'low'][i % 3],
  checkType:      ['Registry', 'AuditPolicy', 'UserRightsAssignment', 'Service', 'Manual'][i % 5],
  checkContent:   'Navigate to the following registry key and verify the value...',
  fixText:        'Configure the policy value to...',
  benchmarkId:    'Windows_10_STIG',
  stigVersionId:  'Windows_10_STIG-V2R8',
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stigs
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const MOCK = process.env.MOCK_MODE === 'true';
    if (MOCK) {
      return res.json({
        data: MOCK_BENCHMARKS,
        total: MOCK_BENCHMARKS.length,
      });
    }

    const repo = AppDataSource.getRepository(StigBenchmarkEntity);
    const benchmarks = await repo.find({
      where: { active: true },
      order: { title: 'ASC' },
    });

    const data = benchmarks.map((b) => ({
      ...b,
      updateAvailable:
        b.latestAvailableVersion !== null &&
        b.latestAvailableVersion !== b.latestInstalledVersion,
    }));

    return res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stigs/update-check/status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/update-check/status', (_req, res) => {
  res.json(updateCheckStatus);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stigs/:benchmarkId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:benchmarkId', async (req, res, next) => {
  try {
    const { benchmarkId } = req.params;
    const MOCK = process.env.MOCK_MODE === 'true';

    if (MOCK) {
      const bm = MOCK_BENCHMARKS.find((b) => b.benchmarkId === benchmarkId);
      if (!bm) return next(createError('Benchmark not found', 404, 'NOT_FOUND'));
      return res.json(bm);
    }

    const bmRepo = AppDataSource.getRepository(StigBenchmarkEntity);
    const svRepo = AppDataSource.getRepository(StigVersionEntity);

    const benchmark = await bmRepo.findOne({ where: { benchmarkId } });
    if (!benchmark) return next(createError('Benchmark not found', 404, 'NOT_FOUND'));

    const versions = await svRepo.find({
      where: { benchmarkId },
      order: { benchmarkDate: 'DESC' },
    });

    return res.json({ ...benchmark, versions });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stigs/:benchmarkId/controls
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:benchmarkId/controls', async (req, res, next) => {
  try {
    const { benchmarkId } = req.params;
    const {
      page = '1',
      pageSize = '100',
      severity,
      checkType,
      q,
      version,
    } = req.query as Record<string, string>;

    const p  = Math.max(1, parseInt(page));
    const ps = Math.min(200, parseInt(pageSize));

    const MOCK = process.env.MOCK_MODE === 'true';
    if (MOCK) {
      let controls = MOCK_CONTROLS.filter((c) => c.benchmarkId === benchmarkId);
      if (severity)  controls = controls.filter((c) => c.severity === severity);
      if (checkType) controls = controls.filter((c) => c.checkType === checkType);
      if (q) {
        const lower = q.toLowerCase();
        controls = controls.filter(
          (c) => c.title.toLowerCase().includes(lower) || c.vulnId.toLowerCase().includes(lower),
        );
      }
      const total = controls.length;
      return res.json({ data: controls.slice((p - 1) * ps, p * ps), total, page: p, pageSize: ps });
    }

    // Resolve stigVersionId
    let stigVersionId: string;
    if (version) {
      const sv = await AppDataSource.getRepository(StigVersionEntity).findOne({
        where: { benchmarkId, version },
      });
      if (!sv) return next(createError('Version not found', 404, 'NOT_FOUND'));
      stigVersionId = sv.id;
    } else {
      // Find active version
      const sv = await AppDataSource.getRepository(StigVersionEntity).findOne({
        where: { benchmarkId, status: 'active' },
        order: { benchmarkDate: 'DESC' },
      });
      if (!sv) return next(createError('No active version found for this benchmark', 404, 'NOT_FOUND'));
      stigVersionId = sv.id;
    }

    const controlRepo = AppDataSource.getRepository(ControlEntity);
    const qb = controlRepo
      .createQueryBuilder('c')
      .where('c.stigVersionId = :stigVersionId', { stigVersionId });

    if (severity)  qb.andWhere('c.severity = :severity', { severity });
    if (checkType) qb.andWhere('c.checkType = :checkType', { checkType });
    if (q) {
      qb.andWhere(
        '(c.title ILIKE :q OR c.vulnId ILIKE :q OR c.ruleId ILIKE :q)',
        { q: `%${q}%` },
      );
    }

    const [controls, total] = await qb
      .orderBy('c.vulnId', 'ASC')
      .skip((p - 1) * ps)
      .take(ps)
      .getManyAndCount();

    return res.json({ data: controls, total, page: p, pageSize: ps });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/stigs/import
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/import',
  requireRole('admin', 'operator'),
  async (req, res, next) => {
    try {
      const { benchmarkTitles, force = false, dryRun = false } = req.body as {
        benchmarkTitles?: string[];
        force?: boolean;
        dryRun?: boolean;
      };

      const MOCK = process.env.MOCK_MODE === 'true';
      if (MOCK) {
        await recordAudit(req, {
          action: 'stig.imported',
          entityType: 'stig_benchmark',
          entityId: (benchmarkTitles ?? DEFAULT_BENCHMARKS).join(','),
          after: { benchmarks: benchmarkTitles ?? DEFAULT_BENCHMARKS, force, dryRun, mock: true },
          result: 'Success',
        });
        return res.json({
          message: 'Import triggered (mock mode — no actual download)',
          benchmarks: benchmarkTitles ?? DEFAULT_BENCHMARKS,
        });
      }

      // Run import async — respond immediately with 202
      const jobId = `import-${Date.now()}`;
      await recordAudit(req, {
        action: 'stig.imported',
        entityType: 'stig_benchmark',
        entityId: jobId,
        after: { benchmarks: benchmarkTitles ?? DEFAULT_BENCHMARKS, force, dryRun, jobId },
        result: 'Success',
      });
      res.status(202).json({ message: 'Import started', jobId });

      importStigs({
        benchmarkTitles: benchmarkTitles ?? DEFAULT_BENCHMARKS,
        force,
        dryRun,
        dataSource: AppDataSource,
      }).catch((err: Error) => {
        logger.error(`[StigsRoute] Import job ${jobId} failed: ${err.message}`);
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/stigs/update-check
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/update-check',
  requireRole('admin', 'operator'),
  async (req, res, next) => {
    try {
      if (updateCheckStatus.running) {
        return res.status(409).json({ message: 'Update check already in progress' });
      }

      const MOCK = process.env.MOCK_MODE === 'true';
      if (MOCK) {
        return res.json({
          message: 'Update check triggered (mock mode)',
          results: MOCK_BENCHMARKS.map((b) => ({
            benchmarkId:      b.benchmarkId,
            title:            b.title,
            installedVersion: b.latestInstalledVersion,
            availableVersion: b.latestAvailableVersion,
            updateAvailable:  b.latestAvailableVersion !== b.latestInstalledVersion,
          })),
        });
      }

      // Run async
      res.status(202).json({ message: 'Update check started' });

      updateCheckStatus.running = true;
      checkForUpdates(AppDataSource)
        .then((results) => {
          updateCheckStatus.running = false;
          updateCheckStatus.lastRun = new Date();
          updateCheckStatus.results = results.map((r) => ({
            benchmarkId:      r.benchmarkId,
            title:            r.title,
            installedVersion: r.installedVersion,
            availableVersion: r.availableVersion,
            updateAvailable:  r.updateAvailable,
          }));
        })
        .catch((err: Error) => {
          updateCheckStatus.running = false;
          updateCheckStatus.error = err.message;
          logger.error(`[StigsRoute] Update check failed: ${err.message}`);
        });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/stigs/:benchmarkId/scan
// Triggers PowerSTIG audit on all machines that have this benchmark assigned
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:benchmarkId/scan',
  requireRole('admin', 'operator'),
  async (req, res, next) => {
    try {
      const { benchmarkId } = req.params;
      const { machineIds, version } = req.body as {
        machineIds?: string[];
        version?: string;
      };

      const MOCK = process.env.MOCK_MODE === 'true';
      if (MOCK) {
        await recordAudit(req, {
          action: 'stig.scan_triggered',
          entityType: 'stig_benchmark',
          entityId: benchmarkId,
          after: { machineIds: machineIds ?? null, version: version ?? null, mock: true },
          result: 'Success',
        });
        return res.json({
          message: `Scan triggered for ${benchmarkId} (mock mode)`,
          machinesQueued: machineIds?.length ?? 3,
        });
      }

      // Resolve active STIG version
      const svRepo = AppDataSource.getRepository(StigVersionEntity);
      const stigVersion = version
        ? await svRepo.findOne({ where: { benchmarkId, version } })
        : await svRepo.findOne({ where: { benchmarkId, status: 'active' }, order: { benchmarkDate: 'DESC' } });

      if (!stigVersion) {
        return next(createError(`No active version found for benchmark ${benchmarkId}`, 404, 'NOT_FOUND'));
      }

      // Get machines to scan
      const machineRepo = AppDataSource.getRepository(MachineEntity);
      const machines = machineIds
        ? await machineRepo.findBy({ id: In(machineIds) })
        : await machineRepo.find({ where: { osType: 'Windows' } });

      if (machines.length === 0) {
        return res.json({ message: 'No machines found to scan', machinesQueued: 0 });
      }

      // Queue scans — respond immediately
      res.status(202).json({
        message: `Scan triggered for ${machines.length} machines`,
        machinesQueued: machines.length,
        benchmarkId,
        version: stigVersion.version,
      });

      // Run scans in background
      (async () => {
        for (const machine of machines) {
          try {
            const result = await runPowerStigAudit({
              machineId:       machine.id,
              machineName:     machine.name,
              resourceGroupName: machine.resourceGroupName ?? '',
              subscriptionId:  machine.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID ?? '',
              benchmarkId,
              stigVersion:     stigVersion.version,
              osType:          machine.osType ?? 'Windows',
              isArcConnected:  machine.isArcConnected ?? false,
            });

            if (result.status === 'succeeded' && result.rawOutput) {
              await parseStigResults(
                {
                  rawOutput:      result.rawOutput,
                  machineId:      machine.id,
                  stigVersionId:  stigVersion.id,
                  runCommandJobId: result.jobId,
                },
                AppDataSource,
              );
            } else {
              logger.warn(`[StigsRoute] Scan ${result.status} for ${machine.name}: ${result.error ?? ''}`);
            }
          } catch (err: any) {
            logger.error(`[StigsRoute] Scan failed for ${machine.name}: ${err.message}`);
          }
        }
      })();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
