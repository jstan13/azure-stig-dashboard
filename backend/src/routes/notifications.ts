/**
 * POST   /api/notifications/configs       — create notification rule
 * GET    /api/notifications/configs       — list all configs
 * PATCH  /api/notifications/configs/:id  — update config
 * DELETE /api/notifications/configs/:id  — delete config
 * POST   /api/notifications/test/:id     — fire a test notification
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { NotificationConfigEntity } from '../models/NotificationConfig';
import { dispatchNotification } from '../services/notificationService';
import { requireRole } from '../middleware/auth';
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import { z } from 'zod';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

const createNotificationConfigSchema = z.object({
  trigger: z.string().trim().min(1).max(100),
  channel: z.string().trim().min(1).max(50),
  destination: z.string().trim().min(1).max(500),
  filter: z.any().optional(),
  ownerOid: z.string().trim().min(1).max(128).optional().nullable(),
  enabled: z.boolean().optional(),
});
const updateNotificationConfigSchema = z.object({
  trigger: z.string().trim().min(1).max(100).optional(),
  channel: z.string().trim().min(1).max(50).optional(),
  destination: z.string().trim().min(1).max(500).optional(),
  filter: z.any().optional(),
  ownerOid: z.string().trim().min(1).max(128).optional().nullable(),
  enabled: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

// GET /api/notifications/configs
router.get('/configs', async (_req: Request, res: Response) => {
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
router.post('/configs', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const parse = createNotificationConfigSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid notification config payload', details: parse.error.flatten() });
    }
    const { trigger, channel, destination, filter, ownerOid, enabled } = parse.data;

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
        after: { trigger, channel, destination, enabled: cfg.enabled },
        result: 'Success',
      });
      return res.status(201).json(cfg);
    }

    const repo = AppDataSource.getRepository(NotificationConfigEntity);
    const cfg = repo.create({ trigger, channel, destination, filter, ownerOid, enabled: enabled !== false });
    const saved = await repo.save(cfg);
    await recordAudit(req, {
      action: 'notification_config.created',
      entityType: 'notification_config',
      entityId: saved.id,
      after: { trigger, channel, destination, enabled: saved.enabled },
      result: 'Success',
    });
    return res.status(201).json(saved);
  } catch (err: any) {
    return sendServerError(res, '[POST /notifications/configs]', err);
  }
});

// PATCH /api/notifications/configs/:id — admin only
router.patch('/configs/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parse = updateNotificationConfigSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid notification update payload', details: parse.error.flatten() });
    }
    const updates = parse.data;

    if (isMock()) {
      const idx = mockStore.notificationConfigs.findIndex((c: any) => c.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      const before = { ...mockStore.notificationConfigs[idx] };
      mockStore.notificationConfigs[idx] = { ...mockStore.notificationConfigs[idx], ...updates, updatedAt: new Date().toISOString() };
      await recordAudit(req, {
        action: 'notification_config.updated',
        entityType: 'notification_config',
        entityId: id,
        before: { enabled: before.enabled, channel: before.channel, destination: before.destination },
        after: updates,
        result: 'Success',
      });
      return res.json(mockStore.notificationConfigs[idx]);
    }

    const repo = AppDataSource.getRepository(NotificationConfigEntity);
    const cfg = await repo.findOne({ where: { id } });
    if (!cfg) return res.status(404).json({ error: 'Not found' });
    const before = { enabled: (cfg as any).enabled, channel: (cfg as any).channel, destination: (cfg as any).destination };
    Object.assign(cfg, updates);
    const saved = await repo.save(cfg);
    await recordAudit(req, {
      action: 'notification_config.updated',
      entityType: 'notification_config',
      entityId: id,
      before,
      after: updates,
      result: 'Success',
    });
    return res.json(saved);
  } catch (err: any) {
    return sendServerError(res, '[PATCH /notifications/configs/:id]', err);
  }
});

// DELETE /api/notifications/configs/:id — admin only
router.delete('/configs/:id', requireRole('admin'), async (req: Request, res: Response) => {
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
        before: { trigger: removed.trigger, channel: removed.channel, destination: removed.destination },
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
      before: { trigger: (cfg as any).trigger, channel: (cfg as any).channel, destination: (cfg as any).destination },
      result: 'Success',
    });
    return res.status(204).send();
  } catch (err: any) {
    return sendServerError(res, '[DELETE /notifications/configs/:id]', err);
  }
});

// POST /api/notifications/test/:id — fire test notification (admin only)
router.post('/test/:id', requireRole('admin'), async (req: Request, res: Response) => {
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
      after: { channel: cfg.channel, destination: cfg.destination },
      result: 'Success',
    });

    return res.json({ ok: true, message: `Test notification dispatched via ${cfg.channel} to ${cfg.destination}` });
  } catch (err: any) {
    return sendServerError(res, '[POST /notifications/test/:id]', err);
  }
});

export default router;
