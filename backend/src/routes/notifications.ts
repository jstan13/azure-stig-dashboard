/**
 * POST   /api/notifications/configs       — create notification rule
 * GET    /api/notifications/configs       — list all configs
 * PATCH  /api/notifications/configs/:id  — update config
 * DELETE /api/notifications/configs/:id  — delete config
 * POST   /api/notifications/test/:id     — fire a test notification
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import {
  NotificationConfigEntity,
  type NotificationTrigger,
  type NotificationChannel,
} from '../models/NotificationConfig';
import { dispatchNotification, assertAllowedWebhook } from '../services/notificationService';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import { z } from 'zod';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

const NOTIFICATION_TRIGGERS = [
  'new_cat1', 'new_finding', 'overdue_poam', 'stig_update',
  'daily_digest', 'weekly_digest', 'scan_complete',
] as const;
const NOTIFICATION_CHANNELS = ['email', 'teams_webhook', 'azure_monitor'] as const;

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Index-based so there is no backtracking on attacker-supplied input. */
function isEmailAddress(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

/** Reject a destination that does not match its channel. Returns an error message, or null when valid. */
function destinationError(channel: NotificationChannel, destination: string): string | null {
  switch (channel) {
    case 'email':
      return isEmailAddress(destination) ? null : 'destination must be a valid email address';
    case 'teams_webhook':
      try {
        assertAllowedWebhook(destination);
        return null;
      } catch (err: any) {
        return `destination is not an allowed webhook URL: ${err.message}`;
      }
    case 'azure_monitor':
      return WORKSPACE_ID_RE.test(destination)
        ? null
        : 'destination must be a Log Analytics workspace GUID';
    default:
      return 'unsupported channel';
  }
}

/**
 * A webhook URL's embedded token is the credential to post to the channel, so
 * the raw destination must never reach the audit log (`audit:read` is granted
 * to auditors). Emails are masked as PII.
 */
function maskDestination(destination: string): string {
  if (/^https?:\/\//i.test(destination)) {
    try {
      return `${new URL(destination).origin}/***`;
    } catch {
      return '***';
    }
  }
  const at = destination.indexOf('@');
  if (at > 0) return `${destination[0]}***${destination.slice(at)}`;
  return '***';
}

const createNotificationConfigSchema = z.object({
  trigger: z.enum(NOTIFICATION_TRIGGERS),
  channel: z.enum(NOTIFICATION_CHANNELS),
  destination: z.string().trim().min(1).max(500),
  filter: z.any().optional(),
  ownerOid: z.string().trim().min(1).max(128).optional().nullable(),
  enabled: z.boolean().optional(),
});
const updateNotificationConfigSchema = z.object({
  trigger: z.enum(NOTIFICATION_TRIGGERS).optional(),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  destination: z.string().trim().min(1).max(500).optional(),
  filter: z.any().optional(),
  ownerOid: z.string().trim().min(1).max(128).optional().nullable(),
  enabled: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

// GET /api/notifications/configs — admin only: `destination` holds Teams/Logic
// Apps webhook URLs, whose embedded token is itself the credential to post.
router.get('/configs', requirePermission('notifications:manage'), async (_req: Request, res: Response) => {
  try {
    if (isMock()) {
      return res.json(mockStore.notificationConfigs);
    }
    const repo = AppDataSource.getRepository(NotificationConfigEntity);
    const configs = await repo.find({ order: { trigger: 'ASC' } });
    return res.json(configs);
  } catch (err: any) {
    return sendServerError(res, '[GET /notifications/configs]', err);
  }
});

// POST /api/notifications/configs — admin only
router.post('/configs', requirePermission('notifications:manage'), async (req: Request, res: Response) => {
  try {
    const parse = createNotificationConfigSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid notification config payload', details: parse.error.flatten() });
    }
    const { trigger, channel, destination, filter, ownerOid, enabled } = parse.data;

    const destErr = destinationError(channel, destination);
    if (destErr) {
      return res.status(400).json({ error: 'Invalid notification config payload', details: destErr });
    }

    if (isMock()) {
      const cfg = {
        id: `notif-${Date.now()}`,
        trigger, channel, destination,
        filter: filter ?? null,
        ownerOid: ownerOid ?? null,
        enabled: enabled !== false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockStore.notificationConfigs.push(cfg);
      await recordAudit(req, {
        action: 'notification_config.created',
        entityType: 'notification_config',
        entityId: cfg.id,
        after: { trigger, channel, destination: maskDestination(destination), enabled: cfg.enabled },
        result: 'Success',
      });
      return res.status(201).json(cfg);
    }

    const repo = AppDataSource.getRepository(NotificationConfigEntity);
    const cfg = repo.create({
      trigger: trigger as NotificationTrigger,
      channel: channel as NotificationChannel,
      destination,
      filter,
      ownerOid: ownerOid ?? undefined,
      enabled: enabled !== false,
    });
    const saved = await repo.save(cfg);
    await recordAudit(req, {
      action: 'notification_config.created',
      entityType: 'notification_config',
      entityId: saved.id,
      after: { trigger, channel, destination: maskDestination(destination), enabled: saved.enabled },
      result: 'Success',
    });
    return res.status(201).json(saved);
  } catch (err: any) {
    return sendServerError(res, '[POST /notifications/configs]', err);
  }
});

// PATCH /api/notifications/configs/:id — admin only
router.patch('/configs/:id', requirePermission('notifications:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parse = updateNotificationConfigSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid notification update payload', details: parse.error.flatten() });
    }
    const updates = parse.data;

    /**
     * Destination and channel can move independently, so validate the merged
     * pair — but only when one of them changes, so a legacy or now-disallowed
     * config can still be disabled.
     */
    const validateMerged = (current: { channel: NotificationChannel; destination: string }): string | null => {
      if (updates.channel === undefined && updates.destination === undefined) return null;
      const nextChannel = updates.channel ?? current.channel;
      const nextDestination = updates.destination ?? current.destination;
      return destinationError(nextChannel, nextDestination);
    };
    const auditedUpdates = {
      ...updates,
      ...(updates.destination !== undefined
        ? { destination: maskDestination(updates.destination) }
        : {}),
    };

    if (isMock()) {
      const idx = mockStore.notificationConfigs.findIndex((c: any) => c.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      const before = { ...mockStore.notificationConfigs[idx] };
      const mergeErr = validateMerged(before as { channel: NotificationChannel; destination: string });
      if (mergeErr) {
        return res.status(400).json({ error: 'Invalid notification update payload', details: mergeErr });
      }
      mockStore.notificationConfigs[idx] = { ...mockStore.notificationConfigs[idx], ...updates, updatedAt: new Date().toISOString() };
      await recordAudit(req, {
        action: 'notification_config.updated',
        entityType: 'notification_config',
        entityId: id,
        before: { enabled: before.enabled, channel: before.channel, destination: maskDestination(before.destination) },
        after: auditedUpdates,
        result: 'Success',
      });
      return res.json(mockStore.notificationConfigs[idx]);
    }

    const repo = AppDataSource.getRepository(NotificationConfigEntity);
    const cfg = await repo.findOne({ where: { id } });
    if (!cfg) return res.status(404).json({ error: 'Not found' });
    const mergeErr = validateMerged(cfg);
    if (mergeErr) {
      return res.status(400).json({ error: 'Invalid notification update payload', details: mergeErr });
    }
    const before = { enabled: (cfg as any).enabled, channel: (cfg as any).channel, destination: maskDestination((cfg as any).destination) };
    Object.assign(cfg, updates);
    const saved = await repo.save(cfg);
    await recordAudit(req, {
      action: 'notification_config.updated',
      entityType: 'notification_config',
      entityId: id,
      before,
      after: auditedUpdates,
      result: 'Success',
    });
    return res.json(saved);
  } catch (err: any) {
    return sendServerError(res, '[PATCH /notifications/configs/:id]', err);
  }
});

// DELETE /api/notifications/configs/:id — admin only
router.delete('/configs/:id', requirePermission('notifications:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (isMock()) {
      const idx = mockStore.notificationConfigs.findIndex((c: any) => c.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      const removed = mockStore.notificationConfigs[idx];
      mockStore.notificationConfigs.splice(idx, 1);
      await recordAudit(req, {
        action: 'notification_config.deleted',
        entityType: 'notification_config',
        entityId: id,
        before: { trigger: removed.trigger, channel: removed.channel, destination: maskDestination(removed.destination) },
        result: 'Success',
      });
      return res.status(204).send();
    }

    const repo = AppDataSource.getRepository(NotificationConfigEntity);
    const cfg = await repo.findOne({ where: { id } });
    if (!cfg) return res.status(404).json({ error: 'Not found' });
    await repo.remove(cfg);
    await recordAudit(req, {
      action: 'notification_config.deleted',
      entityType: 'notification_config',
      entityId: id,
      before: { trigger: (cfg as any).trigger, channel: (cfg as any).channel, destination: maskDestination((cfg as any).destination) },
      result: 'Success',
    });
    return res.status(204).send();
  } catch (err: any) {
    return sendServerError(res, '[DELETE /notifications/configs/:id]', err);
  }
});

// POST /api/notifications/test/:id — fire test notification (admin only)
router.post('/test/:id', requirePermission('notifications:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    let cfg: any;
    if (isMock()) {
      cfg = mockStore.notificationConfigs.find((c: any) => c.id === id);
    } else {
      cfg = await AppDataSource.getRepository(NotificationConfigEntity).findOne({ where: { id } });
    }
    if (!cfg) return res.status(404).json({ error: 'Config not found' });

    await dispatchNotification({
      trigger:      cfg.trigger,
      title:        `[TEST] STIG Dashboard Notification Test`,
      body:         `This is a test notification sent from the Azure STIG Dashboard.\nChannel: ${cfg.channel}\nTrigger configured: ${cfg.trigger}`,
      severity:     'medium',
      metadata:     { test: true, configId: id },
    });

    await recordAudit(req, {
      action: 'notification_config.tested',
      entityType: 'notification_config',
      entityId: id,
      after: { channel: cfg.channel, destination: maskDestination(cfg.destination) },
      result: 'Success',
    });

    return res.json({ ok: true, message: `Test notification dispatched via ${cfg.channel} to ${maskDestination(cfg.destination)}` });
  } catch (err: any) {
    return sendServerError(res, '[POST /notifications/test/:id]', err);
  }
});

export default router;
