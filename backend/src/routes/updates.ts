/**
 * GET   /api/updates          — current version, what's available, and the policy
 * PUT   /api/updates/policy   — change the policy (admin)
 * POST  /api/updates/approve  — clear a specific version for install (admin)
 * POST  /api/updates/apply    — install now, ignoring window and approval (admin)
 * POST  /api/updates/available — scheduler reports what it found upstream
 * POST  /api/updates/result   — scheduler reports how an install went
 *
 * The scheduler authenticates with its managed identity like every other
 * Function App call, so the reporting endpoints are permission-checked too.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import {
  getPolicy, savePolicy, recordHistory, decide, isWithinWindow,
} from '../services/updateService';
import type { UpdateMode } from '../models/UpdatePolicy';

const router = Router();

/** Who to record as having signed off. */
const actorOf = (req: Request): string =>
  req.principal?.upn || req.principal?.objectId || 'unknown';

const policySchema = z.object({
  mode: z.enum(['off', 'notify', 'auto']).optional(),
  requireApproval: z.boolean().optional(),
  securityOnly: z.boolean().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  timeZone: z.string().trim().min(1).max(64).optional(),
}).refine((v) => Object.keys(v).length > 0, {
  message: 'At least one field must be provided',
});

const versionSchema = z.object({
  // Tag shape is fixed by the release workflow; anything else is not ours.
  version: z.string().trim().regex(/^v\d+\.\d+\.\d+$/, 'Expected a version like v1.2.3'),
});

const availableSchema = versionSchema.extend({
  notes: z.string().max(20_000).optional(),
});

const resultSchema = versionSchema.extend({
  result: z.enum(['succeeded', 'rolled_back', 'failed']),
  detail: z.string().max(2_000).optional(),
  previousVersion: z.string().trim().max(32).nullable().optional(),
});

// ── Status ───────────────────────────────────────────────────────────────────
router.get('/', requirePermission('dashboard:read'), async (_req: Request, res: Response) => {
  try {
    const policy = await getPolicy();
    const decision = decide(policy);
    return res.json({
      currentVersion: policy.currentVersion,
      availableVersion: policy.availableVersion,
      availableNotes: policy.availableNotes,
      updateAvailable: Boolean(
        policy.availableVersion && policy.availableVersion !== policy.currentVersion,
      ),
      approvedVersion: policy.approvedVersion,
      approvedBy: policy.approvedBy,
      applyNowVersion: policy.applyNowVersion,
      lastCheckedAt: policy.lastCheckedAt,
      inWindowNow: isWithinWindow(policy),
      nextAction: decision,
      policy: {
        mode: policy.mode,
        requireApproval: policy.requireApproval,
        securityOnly: policy.securityOnly,
        dayOfWeek: policy.dayOfWeek,
        hour: policy.hour,
        timeZone: policy.timeZone,
      },
      history: policy.history ?? [],
    });
  } catch (err: any) {
    return sendServerError(res, '[GET /updates]', err);
  }
});

// ── Policy ───────────────────────────────────────────────────────────────────
router.put('/policy', requirePermission('updates:manage'), async (req: Request, res: Response) => {
  try {
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const patch = parsed.data;

    if (patch.timeZone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timeZone });
      } catch {
        return res.status(400).json({ error: `Unknown time zone: ${patch.timeZone}` });
      }
    }

    const policy = await getPolicy();
    const before = {
      mode: policy.mode,
      requireApproval: policy.requireApproval,
      securityOnly: policy.securityOnly,
      dayOfWeek: policy.dayOfWeek,
      hour: policy.hour,
      timeZone: policy.timeZone,
    };

    if (patch.mode !== undefined) policy.mode = patch.mode as UpdateMode;
    if (patch.requireApproval !== undefined) policy.requireApproval = patch.requireApproval;
    if (patch.securityOnly !== undefined) policy.securityOnly = patch.securityOnly;
    if (patch.dayOfWeek !== undefined) policy.dayOfWeek = patch.dayOfWeek;
    if (patch.hour !== undefined) policy.hour = patch.hour;
    if (patch.timeZone !== undefined) policy.timeZone = patch.timeZone;

    // Tightening the gate must not leave a stale approval standing.
    if (patch.requireApproval === true && before.requireApproval === false) {
      policy.approvedVersion = null;
      policy.approvedBy = null;
    }

    const saved = await savePolicy(policy);
    await recordAudit(req, {
      action: 'update_policy.changed',
      entityType: 'update_policy',
      entityId: 'singleton',
      before,
      after: {
        mode: saved.mode,
        requireApproval: saved.requireApproval,
        securityOnly: saved.securityOnly,
        dayOfWeek: saved.dayOfWeek,
        hour: saved.hour,
        timeZone: saved.timeZone,
      },
      result: 'Success',
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return sendServerError(res, '[PUT /updates/policy]', err);
  }
});

// ── Approval ─────────────────────────────────────────────────────────────────
router.post('/approve', requirePermission('updates:manage'), async (req: Request, res: Response) => {
  try {
    const parsed = versionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const policy = await getPolicy();
    if (parsed.data.version !== policy.availableVersion) {
      return res.status(409).json({
        error: `Version ${parsed.data.version} is not the release currently on offer`,
      });
    }
    policy.approvedVersion = parsed.data.version;
    policy.approvedBy = actorOf(req);
    await savePolicy(policy);
    await recordAudit(req, {
      action: 'update.approved',
      entityType: 'update_policy',
      entityId: 'singleton',
      after: { version: parsed.data.version },
      result: 'Success',
    });
    return res.json({ ok: true, approvedVersion: policy.approvedVersion });
  } catch (err: any) {
    return sendServerError(res, '[POST /updates/approve]', err);
  }
});

// ── Install now ──────────────────────────────────────────────────────────────
router.post('/apply', requirePermission('updates:manage'), async (req: Request, res: Response) => {
  try {
    const policy = await getPolicy();
    const decision = decide(policy, new Date(), true);
    if (decision.action !== 'install') {
      return res.status(409).json({ error: decision.reason });
    }
    // Persist the one-shot bypass so it survives until the external scheduler's
    // next pass; the backend cannot swap its own image without killing itself.
    policy.approvedVersion = decision.version;
    policy.approvedBy = actorOf(req);
    policy.applyNowVersion = decision.version;
    await savePolicy(policy);
    await recordAudit(req, {
      action: 'update.apply_requested',
      entityType: 'update_policy',
      entityId: 'singleton',
      after: { version: decision.version },
      result: 'Success',
    });
    return res.status(202).json({
      ok: true,
      version: decision.version,
      message: 'Update queued. The scheduler will install it within 20 minutes.',
    });
  } catch (err: any) {
    return sendServerError(res, '[POST /updates/apply]', err);
  }
});

// ── Scheduler reporting ──────────────────────────────────────────────────────
router.post('/available', requirePermission('updates:report'), async (req: Request, res: Response) => {
  try {
    const parsed = availableSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const policy = await getPolicy();
    policy.availableVersion = parsed.data.version;
    policy.availableNotes = parsed.data.notes ?? null;
    policy.lastCheckedAt = new Date();
    // A newer release invalidates approval granted for an older one.
    if (policy.approvedVersion && policy.approvedVersion !== parsed.data.version) {
      policy.approvedVersion = null;
      policy.approvedBy = null;
    }
    if (policy.applyNowVersion && policy.applyNowVersion !== parsed.data.version) {
      policy.applyNowVersion = null;
    }
    await savePolicy(policy);
    const decision = decide(policy);
    return res.json({ ok: true, nextAction: decision });
  } catch (err: any) {
    return sendServerError(res, '[POST /updates/available]', err);
  }
});

router.post('/result', requirePermission('updates:report'), async (req: Request, res: Response) => {
  try {
    const parsed = resultSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { version, result, detail, previousVersion } = parsed.data;
    await recordHistory({
      version,
      previousVersion: previousVersion ?? null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result,
      detail,
      actor: 'scheduler',
    });
    const policy = await getPolicy();
    if (result === 'succeeded') {
      policy.currentVersion = version;
    }
    policy.approvedVersion = null;
    policy.approvedBy = null;
    if (policy.applyNowVersion === version) {
      policy.applyNowVersion = null;
    }
    await savePolicy(policy);
    await recordAudit(req, {
      action: `update.${result}`,
      entityType: 'update_policy',
      entityId: 'singleton',
      after: { version, detail },
      result: result === 'succeeded' ? 'Success' : 'Error',
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return sendServerError(res, '[POST /updates/result]', err);
  }
});

export default router;
