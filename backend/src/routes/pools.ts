/**
 * Asset pools + shared (pool / platform-scoped) manual STIG answers.
 *
 *   Pools (role groups — Domain Controllers, Web Servers, Build Servers…):
 *     GET    /api/pools                              list pools (+ member counts)
 *     POST   /api/pools                              create
 *     GET    /api/pools/:id                          detail (+ members)
 *     PATCH  /api/pools/:id                          update
 *     DELETE /api/pools/:id                          archive
 *     POST   /api/pools/:id/members                  add machines {machineIds}
 *     DELETE /api/pools/:id/members/:machineId       remove a machine
 *     GET    /api/pools/:id/answers                  list pool manual answers
 *     PUT    /api/pools/:id/answers/:controlId       upsert + apply a pool answer
 *     DELETE /api/pools/:id/answers/:controlId       remove + revert a pool answer
 *
 *   Platforms (derived: azure / arc / arc-<cloud>):
 *     GET    /api/pools/platforms                    list platforms (+ counts)
 *     GET    /api/pools/platforms/:platform/answers  list platform answers
 *     PUT    /api/pools/platforms/:platform/answers/:controlId  upsert + apply
 *     DELETE /api/pools/platforms/:platform/answers/:controlId  remove + revert
 *
 * Pool administration requires `collection:manage`; authoring answers requires
 * `findings:write`.
 */
import { Router } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../database/dataSource';
import { AssetPoolEntity } from '../models/AssetPool';
import { AssetPoolMemberEntity } from '../models/AssetPoolMember';
import { ManualAnswerEntity } from '../models/ManualAnswer';
import { MachineEntity } from '../models/Machine';
import { FindingEntity } from '../models/Finding';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { createError } from '../middleware/errorHandler';
import {
  machineIdsForScope, upsertAndApplyManualAnswer, revertManualAnswer, isManualStatus,
} from '../services/manualAnswers';
import { platformOf, platformLabel } from '../utils/platform';

const router = Router();

const MOCK = () => process.env.MOCK_MODE === 'true';

function ensureDb(): void {
  if (MOCK() || !AppDataSource.isInitialized) {
    throw createError('Asset pool endpoints are unavailable in mock mode', 503, 'MOCK_MODE');
  }
}

interface PoolRollup {
  total: number; open: number;
  catIOpen: number; catIIOpen: number; catIIIOpen: number;
  notAFinding: number; notApplicable: number; notReviewed: number;
}

function emptyRollup(): PoolRollup {
  return {
    total: 0, open: 0, catIOpen: 0, catIIOpen: 0, catIIIOpen: 0,
    notAFinding: 0, notApplicable: 0, notReviewed: 0,
  };
}

/** Tally member findings into a CAT I/II/III severity rollup. */
async function rollupForMachineIds(machineIds: string[]): Promise<PoolRollup> {
  const r = emptyRollup();
  if (!machineIds.length) return r;
  const findings = await AppDataSource.getRepository(FindingEntity).find({
    where: { machineId: In(machineIds) },
    select: ['status', 'severity'],
  });
  for (const f of findings) {
    r.total++;
    if (f.status === 'open') {
      r.open++;
      if (f.severity === 'high') r.catIOpen++;
      else if (f.severity === 'medium') r.catIIOpen++;
      else r.catIIIOpen++;
    } else if (f.status === 'not_a_finding') {
      r.notAFinding++;
    } else if (f.status === 'not_applicable') {
      r.notApplicable++;
    } else {
      r.notReviewed++;
    }
  }
  return r;
}

function avgScore(machines: Pick<MachineEntity, 'complianceScore'>[]): number {
  if (!machines.length) return 0;
  return Math.round(machines.reduce((s, m) => s + (m.complianceScore || 0), 0) / machines.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Platforms (literal path declared before /:id so it wins)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/platforms', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    ensureDb();
    const machines = await AppDataSource.getRepository(MachineEntity).find();
    const counts = new Map<string, number>();
    for (const m of machines) {
      const key = platformOf(m);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const answerRepo = AppDataSource.getRepository(ManualAnswerEntity);
    const data = await Promise.all(
      Array.from(counts.entries()).map(async ([key, machineCount]) => ({
        key,
        label: platformLabel(key),
        machineCount,
        answerCount: await answerRepo.count({ where: { scopeType: 'platform', scopeId: key } }),
      })),
    );
    res.json({ data: data.sort((a, b) => a.key.localeCompare(b.key)) });
  } catch (err) { next(err); }
});

router.get('/platforms/:platform/answers', requirePermission('dashboard:read'), async (req, res, next) => {
  try {
    ensureDb();
    const rows = await AppDataSource.getRepository(ManualAnswerEntity).find({
      where: { scopeType: 'platform', scopeId: req.params.platform },
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.put('/platforms/:platform/answers/:controlId', requirePermission('findings:write'), async (req, res, next) => {
  try {
    ensureDb();
    const { status, comments, findingDetails } = req.body ?? {};
    if (!isManualStatus(status)) {
      return next(createError('status must be open | not_a_finding | not_applicable | not_reviewed', 400, 'VALIDATION_ERROR'));
    }
    const result = await upsertAndApplyManualAnswer(AppDataSource, {
      scopeType: 'platform',
      scopeId: req.params.platform,
      controlId: req.params.controlId,
      status,
      comments,
      findingDetails,
      answeredBy: req.principal?.objectId ?? null,
    });
    await recordAudit(req, {
      action: 'manualAnswer.platform.upserted',
      entityType: 'manual_answer',
      entityId: result.answer.id,
      after: { platform: req.params.platform, controlId: req.params.controlId, status, applied: result.applied },
      result: 'Success',
    });
    res.json({ answer: result.answer, applied: result.applied });
  } catch (err) { next(err); }
});

router.delete('/platforms/:platform/answers/:controlId', requirePermission('findings:write'), async (req, res, next) => {
  try {
    ensureDb();
    const reverted = await revertManualAnswer(AppDataSource, 'platform', req.params.platform, req.params.controlId);
    await recordAudit(req, {
      action: 'manualAnswer.platform.removed',
      entityType: 'manual_answer',
      entityId: `${req.params.platform}:${req.params.controlId}`,
      after: { reverted },
      result: 'Success',
    });
    res.json({ reverted });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pools
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    ensureDb();
    const pools = await AppDataSource.getRepository(AssetPoolEntity).find({ where: { status: 'active' } });
    const memberRepo = AppDataSource.getRepository(AssetPoolMemberEntity);
    const answerRepo = AppDataSource.getRepository(ManualAnswerEntity);
    const machineRepo = AppDataSource.getRepository(MachineEntity);
    const data = await Promise.all(pools.map(async (p) => {
      const machineIds = await machineIdsForScope(AppDataSource, 'pool', p.id);
      const machines = machineIds.length
        ? await machineRepo.find({ where: { id: In(machineIds) }, select: ['complianceScore'] })
        : [];
      return {
        ...p,
        memberCount: machineIds.length,
        explicitMemberCount: await memberRepo.count({ where: { poolId: p.id } }),
        answerCount: await answerRepo.count({ where: { scopeType: 'pool', scopeId: p.id } }),
        avgScore: avgScore(machines),
        rollup: await rollupForMachineIds(machineIds),
      };
    }));
    res.json({ data });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const { name, description, role, selectionMode, tagRule, machineIds } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return next(createError('name is required', 400, 'VALIDATION_ERROR'));
    }
    const mode = selectionMode === 'tag' ? 'tag' : 'explicit';
    const repo = AppDataSource.getRepository(AssetPoolEntity);
    const pool = await repo.save(repo.create({
      name,
      description: description ?? null,
      role: role ?? null,
      selectionMode: mode,
      tagRule: mode === 'tag' ? (tagRule ?? null) : null,
      createdBy: req.principal?.objectId ?? null,
    }));

    if (Array.isArray(machineIds) && machineIds.length) {
      const memberRepo = AppDataSource.getRepository(AssetPoolMemberEntity);
      for (const machineId of machineIds as string[]) {
        await memberRepo.save(memberRepo.create({ poolId: pool.id, machineId, addedBy: req.principal?.objectId ?? null }));
      }
    }

    await recordAudit(req, {
      action: 'pool.created', entityType: 'asset_pool', entityId: pool.id,
      after: { name: pool.name, selectionMode: pool.selectionMode }, result: 'Success',
    });
    res.status(201).json(pool);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('dashboard:read'), async (req, res, next) => {
  try {
    ensureDb();
    const pool = await AppDataSource.getRepository(AssetPoolEntity).findOne({ where: { id: req.params.id } });
    if (!pool) return next(createError('Pool not found', 404, 'NOT_FOUND'));
    const machineIds = await machineIdsForScope(AppDataSource, 'pool', pool.id);
    const machines = machineIds.length
      ? await AppDataSource.getRepository(MachineEntity).findByIds(machineIds)
      : [];
    const explicit = await AppDataSource.getRepository(AssetPoolMemberEntity).find({ where: { poolId: pool.id } });
    const explicitIds = new Set(explicit.map((e) => e.machineId));
    res.json({
      ...pool,
      avgScore: avgScore(machines),
      rollup: await rollupForMachineIds(machineIds),
      members: machines.map((m) => ({
        id: m.id, name: m.name, osType: m.osType, osVersion: m.osVersion,
        resourceGroupName: m.resourceGroupName, isArcConnected: m.isArcConnected,
        complianceScore: m.complianceScore,
        membership: explicitIds.has(m.id) ? 'explicit' : 'tag',
      })),
    });
  } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const repo = AppDataSource.getRepository(AssetPoolEntity);
    const pool = await repo.findOne({ where: { id: req.params.id } });
    if (!pool) return next(createError('Pool not found', 404, 'NOT_FOUND'));
    const { name, description, role, selectionMode, tagRule, status } = req.body ?? {};
    if (name !== undefined) pool.name = name;
    if (description !== undefined) pool.description = description;
    if (role !== undefined) pool.role = role;
    if (selectionMode === 'tag' || selectionMode === 'explicit') pool.selectionMode = selectionMode;
    if (tagRule !== undefined) pool.tagRule = tagRule;
    if (status === 'active' || status === 'archived') pool.status = status;
    await repo.save(pool);
    await recordAudit(req, {
      action: 'pool.updated', entityType: 'asset_pool', entityId: pool.id,
      after: { name: pool.name, status: pool.status }, result: 'Success',
    });
    res.json(pool);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const repo = AppDataSource.getRepository(AssetPoolEntity);
    const pool = await repo.findOne({ where: { id: req.params.id } });
    if (!pool) return next(createError('Pool not found', 404, 'NOT_FOUND'));
    pool.status = 'archived';
    await repo.save(pool);
    await recordAudit(req, {
      action: 'pool.archived', entityType: 'asset_pool', entityId: pool.id,
      after: { name: pool.name }, result: 'Success',
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/members', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const pool = await AppDataSource.getRepository(AssetPoolEntity).findOne({ where: { id: req.params.id } });
    if (!pool) return next(createError('Pool not found', 404, 'NOT_FOUND'));
    const machineIds: string[] = Array.isArray(req.body?.machineIds) ? req.body.machineIds : [];
    if (!machineIds.length) return next(createError('machineIds[] is required', 400, 'VALIDATION_ERROR'));
    const memberRepo = AppDataSource.getRepository(AssetPoolMemberEntity);
    let added = 0;
    for (const machineId of machineIds) {
      const exists = await memberRepo.findOne({ where: { poolId: pool.id, machineId } });
      if (exists) continue;
      await memberRepo.save(memberRepo.create({ poolId: pool.id, machineId, addedBy: req.principal?.objectId ?? null }));
      added += 1;
    }
    await recordAudit(req, {
      action: 'pool.members.added', entityType: 'asset_pool', entityId: pool.id,
      after: { added, machineIds }, result: 'Success',
    });
    res.json({ added });
  } catch (err) { next(err); }
});

router.delete('/:id/members/:machineId', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const memberRepo = AppDataSource.getRepository(AssetPoolMemberEntity);
    const row = await memberRepo.findOne({ where: { poolId: req.params.id, machineId: req.params.machineId } });
    if (!row) return next(createError('Membership not found', 404, 'NOT_FOUND'));
    await memberRepo.remove(row);
    await recordAudit(req, {
      action: 'pool.members.removed', entityType: 'asset_pool', entityId: req.params.id,
      after: { machineId: req.params.machineId }, result: 'Success',
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id/answers', requirePermission('dashboard:read'), async (req, res, next) => {
  try {
    ensureDb();
    const rows = await AppDataSource.getRepository(ManualAnswerEntity).find({
      where: { scopeType: 'pool', scopeId: req.params.id },
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.put('/:id/answers/:controlId', requirePermission('findings:write'), async (req, res, next) => {
  try {
    ensureDb();
    const pool = await AppDataSource.getRepository(AssetPoolEntity).findOne({ where: { id: req.params.id } });
    if (!pool) return next(createError('Pool not found', 404, 'NOT_FOUND'));
    const { status, comments, findingDetails } = req.body ?? {};
    if (!isManualStatus(status)) {
      return next(createError('status must be open | not_a_finding | not_applicable | not_reviewed', 400, 'VALIDATION_ERROR'));
    }
    const result = await upsertAndApplyManualAnswer(AppDataSource, {
      scopeType: 'pool',
      scopeId: pool.id,
      controlId: req.params.controlId,
      status,
      comments,
      findingDetails,
      answeredBy: req.principal?.objectId ?? null,
    });
    await recordAudit(req, {
      action: 'manualAnswer.pool.upserted', entityType: 'manual_answer', entityId: result.answer.id,
      after: { poolId: pool.id, controlId: req.params.controlId, status, applied: result.applied }, result: 'Success',
    });
    res.json({ answer: result.answer, applied: result.applied });
  } catch (err) { next(err); }
});

router.delete('/:id/answers/:controlId', requirePermission('findings:write'), async (req, res, next) => {
  try {
    ensureDb();
    const reverted = await revertManualAnswer(AppDataSource, 'pool', req.params.id, req.params.controlId);
    await recordAudit(req, {
      action: 'manualAnswer.pool.removed', entityType: 'manual_answer',
      entityId: `${req.params.id}:${req.params.controlId}`, after: { reverted }, result: 'Success',
    });
    res.json({ reverted });
  } catch (err) { next(err); }
});

export default router;
