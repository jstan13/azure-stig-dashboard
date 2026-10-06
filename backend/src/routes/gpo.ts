/**
 * DISA GPO release lifecycle API.
 *
 * Human review (Entra users, existing RBAC):
 *   GET  /api/gpo/status                         — agents, soak period, feature flag
 *   GET  /api/gpo/releases                       — discovered packages and their stage
 *   GET  /api/gpo/releases/:id                   — diff, evidence, decisions, jobs
 *   POST /api/gpo/check                          — look for a new DISA package now
 *   POST /api/gpo/releases/:id/approve-test      — review #1: deploy to test
 *   POST /api/gpo/releases/:id/approve-production — review #2: link in production
 *   POST /api/gpo/releases/:id/retry | reject | rollback
 *   GET|POST /api/gpo/exceptions, POST /api/gpo/exceptions/:id/approve|revoke
 *
 * Agents (app-only tokens holding gpo-agent-test / gpo-agent-production):
 *   POST /api/gpo/agent/jobs/claim
 *   POST /api/gpo/agent/jobs/:id/heartbeat | reports | complete
 *   GET  /api/gpo/agent/releases/:id/package
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppDataSource } from '../database/dataSource';
import { requirePermission, requireDifferentActor } from '../middleware/authz';
import { recordAudit } from '../auth';
import { logger } from '../utils/logger';
import { GpoExceptionEntity } from '../models/GpoException';
import { GpoReleaseEntity, type GpoEnvironment } from '../models/GpoRelease';
import {
  GpoWorkflowError, approveForProduction, approveForTest, claimJob, completeJob,
  heartbeat, lifecycleStatus, listReleases, packageForAgent, precheckRelease,
  recordGpoReport, rejectRelease, releaseDetail, restartRelease, resurveyProduction, retryRelease,
  rollbackRelease, runDiscovery,
  type Actor,
} from '../gpo/gpoReleaseService';
import { getGpoSettings, gpoSettingsResponse, saveGpoSettings } from '../gpo/gpoSettingsService';

const isMock = () => process.env.MOCK_MODE === 'true';

function actorOf(req: Request): Actor {
  return { name: req.principal?.upn || req.principal?.name || req.principal?.objectId || 'unknown', oid: req.principal?.objectId ?? null };
}

function handle(res: Response, context: string, err: unknown, next: NextFunction): void {
  if (err instanceof GpoWorkflowError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  logger.error(`[GPO] ${context}: ${(err as Error)?.message}`);
  next(err);
}

function requireDatabase(_req: Request, res: Response, next: NextFunction): void {
  if (isMock()) {
    res.status(503).json({ error: 'The GPO lifecycle requires a database and is unavailable in demo mode' });
    return;
  }
  next();
}

const idParam = z.string().uuid();
const commentSchema = z.object({ comment: z.string().trim().max(2000).optional() });
const reasonSchema = z.object({ reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(2000) });

function parseId(req: Request, res: Response): string | null {
  const parsed = idParam.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid ID' });
    return null;
  }
  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human review
// ─────────────────────────────────────────────────────────────────────────────

export const gpoRouter = Router();

gpoRouter.get('/status', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    if (isMock()) {
      const s = await getGpoSettings();
      return res.json({
        enabled: s.discoveryMode === 'scheduled', discoveryMode: s.discoveryMode, nextCheckAt: gpoSettingsResponse(s).nextCheckAt,
        soakHours: s.testSoakHours, distinctApprovers: s.requireDistinctApprovers, carryForwardMode: s.carryForwardMode, agents: [],
      });
    }
    return res.json(await lifecycleStatus(AppDataSource));
  } catch (err) {
    return handle(res, 'status', err, next);
  }
});

const settingsSchema = z.object({
  discoveryMode: z.enum(['manual', 'scheduled']),
  frequency: z.enum(['daily', 'weekly']),
  dayOfWeek: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timeZone: z.string().trim().min(1).max(64),
  carryForwardMode: z.enum(['auto', 'review']),
  testSoakHours: z.number().int().min(0).max(24 * 30),
  requireDistinctApprovers: z.boolean(),
});

gpoRouter.get('/settings', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    return res.json(gpoSettingsResponse(await getGpoSettings()));
  } catch (err) {
    return handle(res, 'settings', err, next);
  }
});

gpoRouter.put('/settings', requirePermission('gpo:configure'), async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timeZone });
    } catch {
      return res.status(400).json({ error: `Unknown time zone: ${parsed.data.timeZone}` });
    }
    const settings = await getGpoSettings();
    const before = gpoSettingsResponse(settings);
    Object.assign(settings, parsed.data);
    const after = gpoSettingsResponse(await saveGpoSettings(settings));
    await recordAudit(req, {
      action: 'gpo_settings.changed', entityType: 'gpo_settings', entityId: 'singleton', before, after, result: 'Success',
    });
    return res.json(after);
  } catch (err) {
    return handle(res, 'settings save', err, next);
  }
});

gpoRouter.get('/releases', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    if (isMock()) return res.json({ data: [], total: 0 });
    const data = await listReleases(AppDataSource);
    return res.json({ data, total: data.length });
  } catch (err) {
    return handle(res, 'list', err, next);
  }
});

gpoRouter.get('/releases/:id', requirePermission('dashboard:read'), requireDatabase, async (req, res, next) => {
  try {
    const id = parseId(req, res);
    if (!id) return undefined;
    return res.json(await releaseDetail(AppDataSource, id));
  } catch (err) {
    return handle(res, 'detail', err, next);
  }
});

gpoRouter.post('/check', requirePermission('gpo:approve'), requireDatabase, async (req, res, next) => {
  try {
    const result = await runDiscovery(AppDataSource, actorOf(req));
    await recordAudit(req, {
      action: 'gpo.discovery_run',
      entityType: 'gpo_release',
      entityId: result.outcome === 'none' ? 'none' : result.release.id,
      after: { outcome: result.outcome },
      result: 'Success',
    });
    return res.json({
      outcome: result.outcome,
      release: result.outcome === 'none' ? null : { id: result.release.id, label: result.release.label },
    });
  } catch (err) {
    return handle(res, 'discovery', err, next);
  }
});

type Transition = (id: string, actor: Actor, text: string | undefined, body: Record<string, unknown>) => Promise<GpoReleaseEntity>;

function transitionRoute(action: string, needsReason: boolean, run: Transition) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req, res);
      if (!id) return undefined;
      const parsed = needsReason ? reasonSchema.safeParse(req.body ?? {}) : commentSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
      const text = 'reason' in parsed.data ? parsed.data.reason : parsed.data.comment;
      const release = await run(id, actorOf(req), text, req.body ?? {});
      await recordAudit(req, {
        action: `gpo.${action}`,
        entityType: 'gpo_release',
        entityId: id,
        after: { status: release.status, label: release.label, sha256: release.sourceHash, comment: text ?? null },
        result: 'Success',
      });
      return res.json({ id: release.id, status: release.status });
    } catch (err) {
      return handle(res, action, err, next);
    }
  };
}

gpoRouter.post('/releases/:id/approve-test', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('approved_for_test', false, (id, a, c) => approveForTest(AppDataSource, id, a, c)));
gpoRouter.post('/releases/:id/approve-production', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('approved_for_production', false,
    (id, a, c, body) => approveForProduction(AppDataSource, id, a, c, body.acknowledgeUnsupported === true)));
gpoRouter.post('/releases/:id/restart', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('restarted', false, (id, a, c) => restartRelease(AppDataSource, id, a, c)));
gpoRouter.post('/releases/:id/survey', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('survey_requested', false, (id, a) => resurveyProduction(AppDataSource, id, a)));
gpoRouter.post('/releases/:id/retry', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('retried', false, (id, a, c) => retryRelease(AppDataSource, id, a, c)));
gpoRouter.post('/releases/:id/reject', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('rejected', true, (id, a, r) => rejectRelease(AppDataSource, id, a, r!)));
gpoRouter.post('/releases/:id/rollback', requirePermission('gpo:approve'), requireDatabase,
  transitionRoute('rollback_requested', true, (id, a, r) => rollbackRelease(AppDataSource, id, a, r!)));

// ── Exceptions ───────────────────────────────────────────────────────────────

const TEMPLATE_SECTIONS = [
  'System Access', 'Kerberos Policy', 'Event Audit', 'Privilege Rights',
  'Registry Values', 'Service General Setting', 'Group Membership',
  'Application Log', 'Security Log', 'System Log',
] as const;
const REGISTRY_TYPES = ['String', 'ExpandString', 'Binary', 'DWord', 'MultiString', 'QWord'] as const;
const SINGLE_LINE = /^[^\r\n]*$/;

const exceptionBase = {
  gpoFamily: z.string().trim().min(3).max(200),
  action: z.enum(['set', 'delete']).default('set'),
  justification: z.string().trim().min(10, 'Justification must be at least 10 characters').max(4000),
  reference: z.string().trim().max(200).optional(),
  expiresAt: z.string().datetime().optional(),
};

const exceptionSchema = z.union([
  z.object({
    kind: z.literal('registry'),
    ...exceptionBase,
    hive: z.enum(['HKLM', 'HKCU']),
    key: z.string().trim().min(3).max(512).regex(/^(?!HK)[A-Za-z0-9][^\r\n"]*$/, 'Enter the key path without the hive, e.g. Software\\Policies\\Microsoft\\Edge'),
    valueName: z.string().trim().min(1).max(256).regex(/^[^\r\n"]*$/),
    valueType: z.enum(REGISTRY_TYPES).optional(),
    value: z.string().max(4096).regex(SINGLE_LINE).optional(),
  }),
  z.object({
    kind: z.literal('securityTemplate'),
    ...exceptionBase,
    section: z.enum(TEMPLATE_SECTIONS),
    settingKey: z.string().trim().min(1).max(256).regex(/^[^=\r\n[\]]+$/, 'Setting keys cannot contain =, brackets, or line breaks'),
    settingValue: z.string().max(4096).regex(SINGLE_LINE).optional(),
  }),
]).superRefine((v, ctx) => {
  if (v.action !== 'set') return;
  if (v.kind === 'registry') {
    if (!v.valueType || v.value === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Registry exceptions that set a value need valueType and value' });
    } else if ((v.valueType === 'DWord' || v.valueType === 'QWord') && !/^\d+$/.test(v.value)) {
      ctx.addIssue({ code: 'custom', message: `${v.valueType} values must be non-negative integers` });
    }
  } else if (v.settingValue === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Security template exceptions that set a value need settingValue' });
  }
});

gpoRouter.get('/exceptions', requirePermission('dashboard:read'), async (_req, res, next) => {
  try {
    if (isMock()) return res.json({ data: [], total: 0 });
    const data = await AppDataSource.getRepository(GpoExceptionEntity).find({ order: { createdAt: 'DESC' } });
    return res.json({ data, total: data.length });
  } catch (err) {
    return handle(res, 'exceptions', err, next);
  }
});

gpoRouter.post('/exceptions', requirePermission('exception:write'), requireDatabase, async (req, res, next) => {
  try {
    const parsed = exceptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const v = parsed.data;

    const latest = await AppDataSource.getRepository(GpoReleaseEntity).find({ order: { discoveredAt: 'DESC' }, take: 1 });
    if (latest[0] && !latest[0].gpos.some((g) => g.family === v.gpoFamily)) {
      return res.status(400).json({ error: `"${v.gpoFamily}" is not a GPO in the latest DISA package (${latest[0].label})` });
    }

    const actor = actorOf(req);
    const repo = AppDataSource.getRepository(GpoExceptionEntity);
    const saved = await repo.save(repo.create({
      gpoFamily: v.gpoFamily,
      kind: v.kind,
      action: v.action,
      hive: v.kind === 'registry' ? v.hive : null,
      key: v.kind === 'registry' ? v.key : null,
      valueName: v.kind === 'registry' ? v.valueName : null,
      valueType: v.kind === 'registry' && v.action === 'set' ? v.valueType ?? null : null,
      value: v.kind === 'registry' && v.action === 'set' ? v.value ?? null : null,
      section: v.kind === 'securityTemplate' ? v.section : null,
      settingKey: v.kind === 'securityTemplate' ? v.settingKey : null,
      settingValue: v.kind === 'securityTemplate' && v.action === 'set' ? v.settingValue ?? null : null,
      justification: v.justification,
      reference: v.reference ?? null,
      status: 'pending',
      requestedByOid: actor.oid ?? 'unknown',
      requestedBy: actor.name,
      expiresAt: v.expiresAt ? new Date(v.expiresAt) : null,
    }));
    await recordAudit(req, {
      action: 'gpo.exception_requested', entityType: 'gpo_exception', entityId: saved.id, after: saved, result: 'Success',
    });
    return res.status(201).json(saved);
  } catch (err) {
    return handle(res, 'exception create', err, next);
  }
});

const exceptionRequester = async (req: Request) => {
  const parsed = idParam.safeParse(req.params.id);
  if (!parsed.success || isMock()) return null;
  const row = await AppDataSource.getRepository(GpoExceptionEntity).findOne({ where: { id: parsed.data } });
  return row?.requestedByOid ?? null;
};

gpoRouter.post('/exceptions/:id/approve', requirePermission('exception:approve'), requireDatabase,
  requireDifferentActor(exceptionRequester), async (req, res, next) => {
    try {
      const id = parseId(req, res);
      if (!id) return undefined;
      const repo = AppDataSource.getRepository(GpoExceptionEntity);
      const row = await repo.findOne({ where: { id } });
      if (!row) return res.status(404).json({ error: 'Exception not found' });
      if (row.status !== 'pending') return res.status(409).json({ error: `Exception is already ${row.status}` });
      const actor = actorOf(req);
      row.status = 'approved';
      row.approvedBy = actor.name;
      row.approvedByOid = actor.oid;
      row.approvedAt = new Date();
      await repo.save(row);
      await recordAudit(req, {
        action: 'gpo.exception_approved', entityType: 'gpo_exception', entityId: id, after: { status: row.status }, result: 'Success',
      });
      return res.json(row);
    } catch (err) {
      return handle(res, 'exception approve', err, next);
    }
  });

gpoRouter.post('/exceptions/:id/revoke', requirePermission('exception:approve'), requireDatabase, async (req, res, next) => {
  try {
    const id = parseId(req, res);
    if (!id) return undefined;
    const repo = AppDataSource.getRepository(GpoExceptionEntity);
    const row = await repo.findOne({ where: { id } });
    if (!row) return res.status(404).json({ error: 'Exception not found' });
    if (row.status === 'revoked') return res.status(409).json({ error: 'Exception is already revoked' });
    const before = row.status;
    row.status = 'revoked';
    row.revokedBy = actorOf(req).name;
    row.revokedAt = new Date();
    await repo.save(row);
    await recordAudit(req, {
      action: 'gpo.exception_revoked', entityType: 'gpo_exception', entityId: id,
      before: { status: before }, after: { status: row.status }, result: 'Success',
    });
    return res.json(row);
  } catch (err) {
    return handle(res, 'exception revoke', err, next);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_ROLES: Record<GpoEnvironment, string> = {
  test: 'gpo-agent-test',
  production: 'gpo-agent-production',
};

/**
 * Environments the caller may act for. Only application (client-credential)
 * tokens qualify, so a signed-in human can never impersonate an agent.
 */
export function agentEnvironments(req: Request): GpoEnvironment[] {
  const p = req.principal;
  if (!p) return [];
  const raw = p.rawPayload ?? {};
  const appOnly = raw.scp === undefined && (raw.idtyp === undefined || raw.idtyp === 'app');
  if (!appOnly) return [];
  return (Object.keys(AGENT_ROLES) as GpoEnvironment[]).filter((env) => p.appRoles.includes(AGENT_ROLES[env]));
}

function agentName(req: Request): string {
  const raw = req.principal?.rawPayload ?? {};
  const app = raw.app_displayname ?? raw.azp ?? raw.appid;
  return typeof app === 'string' ? app : req.principal?.objectId ?? 'agent';
}

const envSchema = z.enum(['test', 'production']);

/** Validates `environment` in the body and that this agent holds its role. */
function requireAgentFor(req: Request, res: Response): GpoEnvironment | null {
  const parsed = envSchema.safeParse(req.body?.environment);
  if (!parsed.success) {
    res.status(400).json({ error: 'environment must be "test" or "production"' });
    return null;
  }
  if (!agentEnvironments(req).includes(parsed.data)) {
    res.status(403).json({ error: `Requires an application token with the ${AGENT_ROLES[parsed.data]} app role` });
    return null;
  }
  return parsed.data;
}

export const gpoAgentRouter = Router();
gpoAgentRouter.use(requireDatabase);

const claimSchema = z.object({
  environment: envSchema,
  hostname: z.string().trim().max(255).optional(),
  version: z.string().trim().max(50).optional(),
});

gpoAgentRouter.post('/jobs/claim', async (req, res, next) => {
  try {
    const environment = requireAgentFor(req, res);
    if (!environment) return undefined;
    const body = claimSchema.parse(req.body);
    const payload = await claimJob(AppDataSource, environment, {
      oid: req.principal!.objectId, name: agentName(req), hostname: body.hostname, version: body.version,
    });
    if (!payload) return res.status(204).end();
    await recordAudit(req, {
      action: 'gpo.job_claimed', entityType: 'gpo_job', entityId: payload.job.id,
      after: { type: payload.job.type, environment, releaseId: payload.release.id, attempt: payload.job.attempt },
      result: 'Success',
    });
    return res.json(payload);
  } catch (err) {
    return handle(res, 'claim', err, next);
  }
});

gpoAgentRouter.post('/jobs/:id/heartbeat', async (req, res, next) => {
  try {
    const environment = requireAgentFor(req, res);
    if (!environment) return undefined;
    const id = parseId(req, res);
    if (!id) return undefined;
    const leaseExpiresAt = await heartbeat(AppDataSource, id, environment, req.principal!.objectId);
    return res.json({ leaseExpiresAt });
  } catch (err) {
    return handle(res, 'heartbeat', err, next);
  }
});

const reportSchema = z.object({
  environment: envSchema,
  gpoId: z.string().trim().regex(/^\{?[0-9A-Fa-f-]{36}\}?$/),
  gpoName: z.string().trim().min(1).max(512),
  sourceBackupId: z.string().trim().regex(/^\{[0-9A-Fa-f-]{36}\}$/),
  reportXml: z.string().min(50).max(8 * 1024 * 1024),
});

gpoAgentRouter.post('/jobs/:id/reports', async (req, res, next) => {
  try {
    const environment = requireAgentFor(req, res);
    if (!environment) return undefined;
    const id = parseId(req, res);
    if (!id) return undefined;
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const summary = await recordGpoReport(AppDataSource, id, environment, req.principal!.objectId, parsed.data);
    return res.json(summary);
  } catch (err) {
    return handle(res, 'report', err, next);
  }
});

const guid = z.string().trim().regex(/^\{?[0-9A-Fa-f-]{36}\}?$/);
const linkSchema = z.object({
  target: z.string().trim().min(3).max(1024),
  gpoId: guid,
  gpoName: z.string().trim().max(512),
  order: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
  enforced: z.boolean().optional(),
});
const surveySchema = z.object({
  surveyedAt: z.string().max(64),
  gpos: z.array(z.object({
    gpoFamily: z.string().trim().max(512),
    gpoId: guid,
    gpoName: z.string().trim().max(512),
    baseline: z.enum(['release', 'package', 'unknown']),
    baselineLabel: z.string().max(200).nullable().optional(),
  })).max(500),
  customizations: z.array(z.object({
    gpoFamily: z.string().trim().min(3).max(200),
    kind: z.enum(['registry', 'securityTemplate']),
    action: z.enum(['set', 'delete']),
    hive: z.enum(['HKLM', 'HKCU']).nullable().optional(),
    key: z.string().max(512).regex(/^[^\r\n"]*$/).nullable().optional(),
    valueName: z.string().max(256).regex(/^[^\r\n"]*$/).nullable().optional(),
    valueType: z.enum(REGISTRY_TYPES).nullable().optional(),
    value: z.string().max(8192).regex(SINGLE_LINE).nullable().optional(),
    section: z.enum(TEMPLATE_SECTIONS).nullable().optional(),
    settingKey: z.string().max(512).regex(/^[^=\r\n[\]]*$/).nullable().optional(),
    settingValue: z.string().max(8192).regex(SINGLE_LINE).nullable().optional(),
    sourceGpoName: z.string().trim().max(512),
    baselineKnown: z.boolean(),
  })).max(5000),
  unsupported: z.array(z.object({
    gpoFamily: z.string().max(512),
    gpoName: z.string().max(512),
    detail: z.string().max(2000),
  })).max(2000),
});
const completionSchema = z.object({
  environment: envSchema,
  success: z.boolean(),
  error: z.string().max(8000).optional(),
  gpos: z.array(z.object({
    id: guid,
    name: z.string().trim().min(1).max(512),
    sourceBackupId: z.string().trim().regex(/^\{[0-9A-Fa-f-]{36}\}$/),
    family: z.string().trim().max(512),
  })).max(500).optional(),
  links: z.array(linkSchema).max(2000).optional(),
  previousLinks: z.array(linkSchema).max(2000).optional(),
  validation: z.object({
    collectedAt: z.string().max(64),
    computers: z.array(z.object({
      name: z.string().trim().min(1).max(255),
      reachable: z.boolean(),
      error: z.string().max(4000).nullable().optional(),
      distinguishedName: z.string().max(1024).nullable().optional(),
      expectedGpoIds: z.array(guid).max(500),
      appliedGpoIds: z.array(guid).max(2000),
      filteredGpoIds: z.array(guid).max(2000),
      missingGpoIds: z.array(guid).max(500),
      extensionErrors: z.array(z.object({ name: z.string().max(255), code: z.string().max(64) })).max(200),
      script: z.object({ passed: z.boolean(), summary: z.string().max(4000).nullable().optional() }).nullable().optional(),
    })).max(500),
  }).optional(),
  log: z.array(z.string().max(2000)).max(500).optional(),
  survey: surveySchema.optional(),
});

gpoAgentRouter.post('/jobs/:id/precheck', async (req, res, next) => {
  try {
    const environment = requireAgentFor(req, res);
    if (!environment) return undefined;
    const id = parseId(req, res);
    if (!id) return undefined;
    const parsed = surveySchema.safeParse(req.body?.survey);
    if (!parsed.success) {
      return res.status(400).json({ error: `survey.${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}` });
    }
    return res.json(await precheckRelease(AppDataSource, id, environment, req.principal!.objectId, parsed.data));
  } catch (err) {
    return handle(res, 'precheck', err, next);
  }
});

gpoAgentRouter.post('/jobs/:id/complete', async (req, res, next) => {
  try {
    const environment = requireAgentFor(req, res);
    if (!environment) return undefined;
    const id = parseId(req, res);
    if (!id) return undefined;
    const parsed = completionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}` });
    }
    const { environment: _env, ...body } = parsed.data;
    const release = await completeJob(AppDataSource, id, environment, req.principal!.objectId, body);
    await recordAudit(req, {
      action: parsed.data.success ? 'gpo.job_succeeded' : 'gpo.job_failed',
      entityType: 'gpo_job',
      entityId: id,
      after: { environment, releaseId: release.id, releaseStatus: release.status, error: body.error ?? null },
      result: parsed.data.success ? 'Success' : 'Error',
    });
    return res.json({ releaseStatus: release.status });
  } catch (err) {
    return handle(res, 'complete', err, next);
  }
});

gpoAgentRouter.get('/releases/:id/package', async (req, res, next) => {
  try {
    const environments = agentEnvironments(req);
    if (environments.length === 0) {
      return res.status(403).json({ error: 'Requires a GPO agent application token' });
    }
    const id = parseId(req, res);
    if (!id) return undefined;
    const pkg = await packageForAgent(AppDataSource, id, environments, req.principal!.objectId);
    res.setHeader('X-Content-SHA256', pkg.sha256);
    return res.download(pkg.path, pkg.filename);
  } catch (err) {
    return handle(res, 'package', err, next);
  }
});
