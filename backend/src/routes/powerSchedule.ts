/**
 * GET    /api/power-schedule         — current window, deferral and next transitions
 * PUT    /api/power-schedule         — change the window (admin)
 * POST   /api/power-schedule/extend  — "working late": push tonight's shutdown back
 * DELETE /api/power-schedule/extend  — cancel an active deferral
 * POST   /api/power-schedule/heartbeat — scheduler check-in ('power:report')
 * POST   /api/power-schedule/state   — scheduler reports the action it is taking
 *
 * Changing the policy needs 'power:schedule' (admin). The two endpoints the
 * scheduler Function calls need only 'power:report', which the operator role
 * carries, so the Function does not have to run as an administrator.
 *
 * The scheduler Function reads GET on a short poll and reconciles Azure to the
 * `desiredState` it returns, so this router is the single source of truth for
 * when the dashboard's own resources are powered on.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import {
  getPowerSchedule, savePowerSchedule, powerScheduleResponse,
  computeDeferUntil, isValidTimeZone, normalizeDays, MAX_DEFER_HOURS,
} from '../services/powerScheduleService';

const router = Router();

const actorOf = (req: Request): string =>
  req.principal?.upn || req.principal?.objectId || 'unknown';

const scheduleSchema = z.object({
  enabled: z.boolean(),
  autoShutdown: z.boolean(),
  timeZone: z.string().trim().min(1).max(64),
  startHour: z.number().int().min(0).max(23),
  startMinute: z.number().int().min(0).max(59),
  endHour: z.number().int().min(0).max(23),
  endMinute: z.number().int().min(0).max(59),
  days: z.array(z.number().int().min(0).max(6)).max(7),
});

const extendSchema = z.object({
  hours: z.number().min(0.5).max(MAX_DEFER_HOURS),
});

const stateSchema = z.object({
  action: z.enum(['started', 'stopped']),
});

router.get('/', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    res.json(powerScheduleResponse(await getPowerSchedule()));
  } catch (err) {
    next(err);
  }
});

router.put('/', requirePermission('power:schedule'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const input = parsed.data;

  if (!isValidTimeZone(input.timeZone)) {
    return res.status(400).json({ error: `Unknown time zone: ${input.timeZone}` });
  }
  const days = normalizeDays(input.days);
  if (input.enabled && days.length === 0) {
    return res.status(400).json({ error: 'Select at least one day, or turn the schedule off' });
  }
  if (input.startHour === input.endHour && input.startMinute === input.endMinute) {
    return res.status(400).json({ error: 'Start and end time must differ' });
  }

  try {
    const policy = await getPowerSchedule();
    const before = powerScheduleResponse(policy);
    Object.assign(policy, input, { days });
    const saved = await savePowerSchedule(policy);
    const after = powerScheduleResponse(saved);
    await recordAudit(req, {
      action: 'power_schedule.changed',
      entityType: 'power_schedule',
      entityId: 'singleton',
      before,
      after,
      result: 'Success',
    });
    return res.json(after);
  } catch (err) {
    return next(err);
  }
});

router.post('/extend', requirePermission('power:schedule'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = extendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  try {
    const policy = await getPowerSchedule();
    if (!policy.enabled || !policy.autoShutdown) {
      return res.status(409).json({ error: 'Automatic shutdown is not enabled, so there is nothing to delay' });
    }
    const before = powerScheduleResponse(policy);
    policy.deferUntil = computeDeferUntil(policy, parsed.data.hours);
    policy.deferredBy = actorOf(req);
    const saved = await savePowerSchedule(policy);
    const after = powerScheduleResponse(saved);
    await recordAudit(req, {
      action: 'power_schedule.deferred',
      entityType: 'power_schedule',
      entityId: 'singleton',
      before,
      after,
      result: 'Success',
    });
    return res.json(after);
  } catch (err) {
    return next(err);
  }
});

router.delete('/extend', requirePermission('power:schedule'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await getPowerSchedule();
    const before = powerScheduleResponse(policy);
    policy.deferUntil = null;
    policy.deferredBy = null;
    const saved = await savePowerSchedule(policy);
    const after = powerScheduleResponse(saved);
    await recordAudit(req, {
      action: 'power_schedule.deferral_cancelled',
      entityType: 'power_schedule',
      entityId: 'singleton',
      before,
      after,
      result: 'Success',
    });
    return res.json(after);
  } catch (err) {
    return next(err);
  }
});

// The scheduler calls this on every successful poll so the UI can tell the
// difference between "the schedule says 6pm" and "the schedule says 6pm and
// something is actually out there enforcing it".
router.post('/heartbeat', requirePermission('power:report'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await getPowerSchedule();
    policy.lastPolledAt = new Date();
    return res.json(powerScheduleResponse(await savePowerSchedule(policy)));
  } catch (err) {
    return next(err);
  }
});

// The scheduler calls this immediately *before* it acts, because a shutdown
// takes the backend offline and it could not report afterwards.
router.post('/state', requirePermission('power:report'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = stateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  try {
    const policy = await getPowerSchedule();
    policy.lastAction = parsed.data.action;
    policy.lastActionAt = new Date();
    // A completed shutdown consumes any deferral that was holding it back.
    if (parsed.data.action === 'stopped') {
      policy.deferUntil = null;
      policy.deferredBy = null;
    }
    return res.json(powerScheduleResponse(await savePowerSchedule(policy)));
  } catch (err) {
    return next(err);
  }
});

export default router;
