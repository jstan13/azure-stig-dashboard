/**
 * GPO release workflow engine.
 *
 * Humans decide; agents execute. Every transition is serialized with a
 * transaction-scoped advisory lock so two approvers, or an approver and an
 * agent, can never advance the same release twice. Agents are trusted only
 * for evidence: whether a test run passed is decided here, not by the agent.
 */

import fs from 'fs';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  GpoReleaseEntity, GpoJobEntity, GpoAgentEntity,
  type GpoEnvironment, type GpoReleaseStatus, type GpoFailedStage, type GpoJobType,
  type DeployedGpo, type GpoLinkRecord, type ValidationEvidence, type ValidationOutcome,
  type EnvironmentState, type GpoExceptionSnapshot, type GpoCustomization, type ProductionSurvey,
} from '../models/GpoRelease';
import { GpoExceptionEntity } from '../models/GpoException';
import { GpoSettingsEntity } from '../models/GpoSettings';
import { fetchRawCatalog } from '../stigs/stigCatalog';
import { downloadArchive } from '../stigs/xccdfDownloader';
import { notifyGpoRelease } from '../services/notificationService';
import { logger } from '../utils/logger';
import {
  diffPackages, diffSettings, flattenGpoReport, parseGpoPackage, selectLatestGpoPackage,
} from './gpoPackage';
import { getGpoSettings, nextDiscoveryAt, recordDiscoveryCheck } from './gpoSettingsService';

export class GpoWorkflowError extends Error {
  constructor(message: string, public readonly statusCode = 409) {
    super(message);
  }
}

export interface Actor {
  name: string;
  oid: string | null;
}

const SYSTEM: Actor = { name: 'system', oid: null };

/** Releases that occupy the single deployment pipeline. */
export const PIPELINE_STATUSES: GpoReleaseStatus[] = [
  'test_deploying', 'test_validating', 'staging_production',
  'awaiting_production_approval', 'releasing', 'rolling_back', 'failed',
];

const leaseMinutes = () => Math.max(5, Number(process.env.GPO_JOB_LEASE_MINUTES ?? 60));

/** Workflow-advancing job types; a survey is read-only and never moves a release. */
type StageJobType = Exclude<GpoJobType, 'survey'>;

const STAGE_OF: Record<StageJobType, GpoFailedStage> = {
  deploy: 'test_deploy',
  validate: 'test_validation',
  stage: 'production_stage',
  release: 'production_release',
  rollback: 'rollback',
};

/** Release status each job type is allowed to advance. */
const EXPECTED_STATUS: Record<StageJobType, GpoReleaseStatus> = {
  deploy: 'test_deploying',
  validate: 'test_validating',
  stage: 'staging_production',
  release: 'releasing',
  rollback: 'rolling_back',
};

/** Statuses in which surveying production is still useful. */
const SURVEYABLE: GpoReleaseStatus[] = [
  'awaiting_test_approval', 'test_deploying', 'test_validating',
  'staging_production', 'awaiting_production_approval', 'failed',
];

function jobMayRun(type: GpoJobType, release: GpoReleaseEntity): boolean {
  return type === 'survey' ? SURVEYABLE.includes(release.status) : release.status === EXPECTED_STATUS[type];
}

interface PendingNotice {
  title: string;
  body: string;
  severity?: 'high' | 'medium' | 'low';
  metadata: Record<string, unknown>;
}

function sendNotices(ds: DataSource, notices: PendingNotice[]): void {
  for (const n of notices) {
    notifyGpoRelease(n.title, n.body, n.metadata, n.severity, ds)
      .catch((err) => logger.warn(`[GPO] Notification failed: ${err.message}`));
  }
}

async function lockWorkflow(m: EntityManager): Promise<void> {
  await m.query(`SELECT pg_advisory_xact_lock(hashtext('stig-tracker:gpo-workflow'))`);
}

async function loadRelease(m: EntityManager, id: string, withSnapshot = false): Promise<GpoReleaseEntity> {
  const qb = m.getRepository(GpoReleaseEntity).createQueryBuilder('r').where('r.id = :id', { id });
  if (withSnapshot) qb.addSelect('r.settingsSnapshot');
  const release = await qb.getOne();
  if (!release) throw new GpoWorkflowError('GPO release not found', 404);
  return release;
}

function record(release: GpoReleaseEntity, action: string, actor: Actor, comment?: string | null): void {
  release.decisions = [
    ...(release.decisions ?? []),
    { action, actor: actor.name, actorOid: actor.oid, at: new Date().toISOString(), comment: comment ?? null },
  ];
}

function requireStatus(release: GpoReleaseEntity, allowed: GpoReleaseStatus[]): void {
  if (!allowed.includes(release.status)) {
    throw new GpoWorkflowError(
      `Release ${release.label} is ${release.status.replace(/_/g, ' ')}; expected ${allowed.join(' or ').replace(/_/g, ' ')}`,
    );
  }
}

async function enqueue(
  m: EntityManager,
  release: GpoReleaseEntity,
  environment: GpoEnvironment,
  type: GpoJobType,
  notBefore = new Date(),
): Promise<GpoJobEntity> {
  const repo = m.getRepository(GpoJobEntity);
  return repo.save(repo.create({
    releaseId: release.id, environment, type, status: 'queued', notBefore,
    attempts: 0, deviations: [],
  }));
}

function fail(release: GpoReleaseEntity, stage: GpoFailedStage, error: string, notices: PendingNotice[]): void {
  release.status = 'failed';
  release.failedStage = stage;
  release.lastError = error;
  record(release, `failed:${stage}`, SYSTEM, error);
  notices.push({
    title: `GPO release ${release.label} failed during ${stage.replace(/_/g, ' ')}`,
    body: error,
    severity: 'high',
    metadata: { releaseId: release.id, stage },
  });
}

const normGuid = (id: string) => id.replace(/[{}]/g, '').toLowerCase();

/** Union of link records keyed by target + GPO; later lists win (they reflect newer state). */
export function mergeLinks(...lists: Array<GpoLinkRecord[] | undefined>): GpoLinkRecord[] {
  const seen = new Map<string, GpoLinkRecord>();
  for (const list of lists) {
    for (const link of list ?? []) {
      seen.set(`${link.target.toLowerCase()}|${normGuid(link.gpoId)}`, link);
    }
  }
  return [...seen.values()];
}

/** True when a failed production release left live (enabled) production links changed. */
function productionPartiallyChanged(release: GpoReleaseEntity): boolean {
  const prod = release.environments?.production;
  return release.status === 'failed' && release.failedStage === 'production_release'
    && (!!prod?.links.some((l) => l.enabled !== false) || (prod?.previousLinks.length ?? 0) > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Production customizations → exceptions
// ─────────────────────────────────────────────────────────────────────────────

type ExceptionLike = Pick<GpoCustomization, 'gpoFamily' | 'kind' | 'action' | 'hive' | 'key' | 'valueName'
  | 'valueType' | 'value' | 'section' | 'settingKey' | 'settingValue'>;

const lower = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** The setting an exception or customization targets, independent of its value. */
export function exceptionIdentity(e: ExceptionLike): string {
  return e.kind === 'registry'
    ? `${e.gpoFamily}|registry|${lower(e.hive)}|${lower(e.key)}|${lower(e.valueName)}`
    : `${e.gpoFamily}|securityTemplate|${lower(e.section)}|${lower(e.settingKey)}`;
}

/** True when two records would leave the setting in the same state. */
export function sameEffect(a: ExceptionLike, b: ExceptionLike): boolean {
  if (exceptionIdentity(a) !== exceptionIdentity(b) || a.action !== b.action) return false;
  if (a.action === 'delete') return true;
  if (a.kind === 'registry') {
    return lower(a.valueType) === lower(b.valueType) && (a.value ?? '') === (b.value ?? '');
  }
  return (a.settingValue ?? '').trim() === (b.settingValue ?? '').trim();
}

/** Customizations found in production that the frozen exceptions would not reproduce. */
export function uncoveredCustomizations(
  found: GpoCustomization[],
  frozen: GpoExceptionSnapshot[],
): GpoCustomization[] {
  return found.filter((c) => !frozen.some((e) => sameEffect(e, c)));
}

type ExceptionRow = ExceptionLike & {
  status: string; source?: string; expiresAt?: Date | null; revokedBy?: string | null;
};

/** Pending, or approved and not expired. */
export function isLiveException(e: ExceptionRow, now = new Date()): boolean {
  if (e.status === 'pending') return true;
  return e.status === 'approved' && (!e.expiresAt || e.expiresAt.getTime() > now.getTime());
}

/** A person revoked it, or it expired: the customization is deliberately being dropped. */
export function isEndedException(e: ExceptionRow, now = new Date()): boolean {
  if (e.status === 'revoked') return !(e.revokedBy ?? '').startsWith('system');
  return e.status === 'approved' && !!e.expiresAt && e.expiresAt.getTime() <= now.getTime();
}

export interface DriftResult {
  /** In production, not in this release, and nobody chose to drop it. */
  uncovered: GpoCustomization[];
  /** Frozen into this release from production, but production no longer has it. */
  stale: GpoExceptionSnapshot[];
  /** In production but deliberately not carried forward (exception revoked or expired). */
  dropped: GpoCustomization[];
}

/** Compares a production survey with what a release will deploy. */
export function evaluateDrift(
  found: GpoCustomization[],
  frozen: GpoExceptionSnapshot[],
  ended: ExceptionLike[],
  surveyedFamilies: Set<string>,
): DriftResult {
  const dropped = found.filter((c) => !frozen.some((e) => sameEffect(e, c)) && ended.some((e) => sameEffect(e, c)));
  const uncovered = found.filter((c) => !frozen.some((e) => sameEffect(e, c)) && !dropped.includes(c));
  const stale = frozen.filter((e) => e.source === 'detected' && surveyedFamilies.has(e.gpoFamily)
    && !found.some((c) => sameEffect(e, c)));
  return { uncovered, stale, dropped };
}

async function endedExceptions(m: EntityManager, families: string[]): Promise<GpoExceptionEntity[]> {
  if (!families.length) return [];
  const rows = await m.getRepository(GpoExceptionEntity).find({ where: { gpoFamily: In(families) } });
  return rows.filter((e) => isEndedException(e));
}

/**
 * Turns production customizations into exceptions so every later release
 * (test and production) reproduces them, and retires detected exceptions
 * that production no longer has. Customizations a person deliberately ended
 * (revoked, or let expire) are not re-created until a survey shows production
 * without them; after that, re-adding them in production counts as new.
 *
 * `retire` must be false for surveys of a release other than the one in the
 * pipeline: a survey omits settings its own DISA package already contains,
 * which says nothing about what another release should carry.
 */
async function recordCustomizations(
  m: EntityManager,
  survey: ProductionSurvey,
  settings: GpoSettingsEntity,
  agent: string,
  retire: boolean,
): Promise<{ approved: number; pending: number; retired: number }> {
  const repo = m.getRepository(GpoExceptionEntity);
  const surveyed = new Set(survey.gpos.map((g) => g.gpoFamily));
  const families = [...new Set([...surveyed, ...survey.customizations.map((c) => c.gpoFamily)])];
  const rows = families.length ? await repo.find({ where: { gpoFamily: In(families) } }) : [];
  const now = new Date();
  let approved = 0;
  let pending = 0;
  let retired = 0;
  for (const c of survey.customizations) {
    const same = rows.filter((e) => exceptionIdentity(e) === exceptionIdentity(c));
    if (same.some((e) => isLiveException(e, now) && sameEffect(e, c))) continue;
    if (same.some((e) => isEndedException(e, now) && sameEffect(e, c))) continue;
    for (const stale of same.filter((e) => e.source === 'detected' && isLiveException(e, now))) {
      stale.status = 'revoked';
      stale.revokedBy = 'system (production value changed)';
      stale.revokedAt = now;
      await repo.save(stale);
    }
    const auto = settings.carryForwardMode === 'auto' && c.baselineKnown;
    const saved = await repo.save(repo.create({
      gpoFamily: c.gpoFamily,
      kind: c.kind,
      action: c.action,
      hive: c.hive ?? null,
      key: c.key ?? null,
      valueName: c.valueName ?? null,
      valueType: c.action === 'set' ? c.valueType ?? null : null,
      value: c.action === 'set' ? c.value ?? null : null,
      section: c.section ?? null,
      settingKey: c.settingKey ?? null,
      settingValue: c.action === 'set' ? c.settingValue ?? null : null,
      justification: c.baselineKnown
        ? `Found in production GPO "${c.sourceGpoName}"; differs from the DISA release it was imported from. Carried forward so the new release keeps it.`
        : `Found in production GPO "${c.sourceGpoName}", whose original DISA release is unknown. This may be a local change or a DISA change between versions; confirm before approving.`,
      reference: null,
      status: auto ? 'approved' : 'pending',
      source: 'detected',
      detectedFrom: c.sourceGpoName,
      baselineKnown: c.baselineKnown,
      requestedByOid: 'system',
      requestedBy: `production survey (${agent})`,
      approvedByOid: auto ? 'system' : null,
      approvedBy: auto ? 'system (carry-forward setting: automatic)' : null,
      approvedAt: auto ? now : null,
      expiresAt: null,
    }));
    rows.push(saved);
    if (auto) approved += 1; else pending += 1;
  }
  if (!retire) return { approved, pending, retired };
  for (const e of rows) {
    if (!surveyed.has(e.gpoFamily) || survey.customizations.some((c) => sameEffect(e, c))) continue;
    if (e.source === 'detected' && isLiveException(e, now)) {
      // Production went back to the DISA value: stop carrying the old customization.
      e.status = 'revoked';
      e.revokedBy = 'system (no longer in production)';
      e.revokedAt = now;
    } else if (isEndedException(e, now)) {
      // The deliberate drop has taken effect; a later re-add in production is a new decision.
      if (e.status === 'revoked') {
        e.revokedBy = `system (dropped from production; revoked by ${e.revokedBy ?? 'unknown'})`;
      } else {
        e.status = 'revoked';
        e.revokedBy = 'system (expired; dropped from production)';
        e.revokedAt = now;
      }
    } else {
      continue;
    }
    await repo.save(e);
    retired += 1;
  }
  return { approved, pending, retired };
}

/** Records drift between a production survey and a staged release on its production state. */
async function applyDrift(m: EntityManager, r: GpoReleaseEntity, survey: ProductionSurvey): Promise<DriftResult> {
  const surveyed = new Set(survey.gpos.map((g) => g.gpoFamily));
  const ended = await endedExceptions(m, [...new Set(survey.customizations.map((c) => c.gpoFamily))]);
  const drift = evaluateDrift(survey.customizations, r.exceptionsSnapshot ?? [], ended, surveyed);
  const prod = r.environments?.production;
  if (prod) {
    r.environments = {
      ...r.environments,
      production: {
        ...prod,
        uncovered: drift.uncovered,
        stale: drift.stale,
        dropped: drift.dropped,
        unsupported: survey.unsupported,
        updatedAt: new Date().toISOString(),
      },
    };
  }
  return drift;
}

function driftReasons(d: Pick<DriftResult, 'uncovered' | 'stale'>): string[] {
  const reasons: string[] = [];
  if (d.uncovered.length) {
    reasons.push(`${d.uncovered.length} customization(s) in today's production GPOs are not part of this release and would be lost`);
  }
  if (d.stale.length) {
    reasons.push(`${d.stale.length} customization(s) frozen into this release were removed from production since review and would be re-applied`);
  }
  return reasons;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

export type DiscoveryOutcome =
  | { outcome: 'none' }
  | { outcome: 'unchanged'; release: GpoReleaseEntity }
  | { outcome: 'new'; release: GpoReleaseEntity };

/**
 * Downloads the newest DISA GPO package, parses every backup, diffs it against
 * what is currently released, and queues it for the first human review.
 */
export async function discoverGpoRelease(ds: DataSource, actor: Actor = SYSTEM): Promise<DiscoveryOutcome> {
  const entry = selectLatestGpoPackage(await fetchRawCatalog());
  if (!entry) return { outcome: 'none' };

  const repo = ds.getRepository(GpoReleaseEntity);
  const sameUrl = await repo.findOne({ where: { downloadUrl: entry.downloadUrl }, order: { discoveredAt: 'DESC' } });
  const archive = await downloadArchive(entry.downloadUrl, sameUrl?.sourceHash);
  const existing = await repo.findOne({ where: { sourceHash: archive.sha256 } });
  if (existing) return { outcome: 'unchanged', release: existing };

  const parsed = parseGpoPackage(fs.readFileSync(archive.filePath));
  const previous = await repo.createQueryBuilder('r')
    .addSelect('r.settingsSnapshot')
    .where('r.status = :status', { status: 'released' })
    .orderBy('r.releasedAt', 'DESC')
    .getOne();
  const diff = diffPackages(
    previous ? { id: previous.id, label: previous.label, parsed: { gpos: previous.gpos, settings: previous.settingsSnapshot } } : null,
    parsed,
  );

  const notices: PendingNotice[] = [];
  const release = await ds.transaction(async (m) => {
    await lockWorkflow(m);
    const r = m.getRepository(GpoReleaseEntity);
    if (await r.findOne({ where: { sourceHash: archive.sha256 } })) return null;
    for (const stale of await r.find({ where: { status: 'awaiting_test_approval' } })) {
      stale.status = 'superseded';
      record(stale, 'superseded', SYSTEM, `Replaced by ${entry.label}`);
      await r.save(stale);
    }
    const created = r.create({
      packageName: entry.packageName,
      label: entry.label,
      releaseDate: entry.releaseDate ? new Date(entry.releaseDate) : null,
      downloadUrl: entry.downloadUrl,
      filename: archive.filename,
      sourceHash: archive.sha256,
      sizeBytes: archive.bytes,
      status: 'awaiting_test_approval',
      failedStage: null,
      gpos: parsed.gpos,
      settingsSnapshot: parsed.settings,
      diff,
      exceptionsSnapshot: null,
      productionSurvey: null,
      environments: {},
      decisions: [],
      releasedAt: null,
      lastError: null,
    });
    record(created, 'discovered', actor);
    const saved = await r.save(created);
    // Read-only: find customizations in today's production GPOs before review.
    await enqueue(m, saved, 'production', 'survey');
    return saved;
  });
  if (!release) {
    return { outcome: 'unchanged', release: (await repo.findOne({ where: { sourceHash: archive.sha256 } }))! };
  }

  notices.push({
    title: `DISA GPO package ${release.label} is ready for review`,
    body: `${diff.changedGpos.length} changed, ${diff.addedGpos.length} new, and ${diff.removedGpos.length} removed GPOs`
      + (diff.previousLabel ? ` compared with ${diff.previousLabel}.` : '. No released baseline exists yet.')
      + ' Approve it to deploy to the test environment.',
    metadata: { releaseId: release.id, sha256: release.sourceHash },
  });
  sendNotices(ds, notices);
  logger.info(`[GPO] Staged DISA GPO package ${release.label} (${release.gpos.length} GPOs) for review`);
  return { outcome: 'new', release };
}

/** Discovery plus bookkeeping shown on the settings page. */
export async function runDiscovery(ds: DataSource, actor: Actor = SYSTEM): Promise<DiscoveryOutcome> {
  try {
    const result = await discoverGpoRelease(ds, actor);
    await recordDiscoveryCheck(result.outcome, null);
    return result;
  } catch (err) {
    await recordDiscoveryCheck('failed', (err as Error).message.slice(0, 2000));
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Human decisions
// ─────────────────────────────────────────────────────────────────────────────

async function snapshotExceptions(m: EntityManager, release: GpoReleaseEntity): Promise<GpoExceptionSnapshot[]> {
  const families = [...new Set(release.gpos.map((g) => g.family))];
  if (families.length === 0) return [];
  const now = Date.now();
  const rows = await m.getRepository(GpoExceptionEntity).find({
    where: { status: 'approved', gpoFamily: In(families) },
    order: { createdAt: 'ASC' },
  });
  return rows
    .filter((e) => !e.expiresAt || e.expiresAt.getTime() > now)
    .map((e) => ({
      id: e.id, gpoFamily: e.gpoFamily, kind: e.kind, action: e.action,
      hive: e.hive, key: e.key, valueName: e.valueName, valueType: e.valueType, value: e.value,
      section: e.section, settingKey: e.settingKey, settingValue: e.settingValue,
      justification: e.justification, approvedBy: e.approvedBy, source: e.source,
    }));
}

export async function approveForTest(ds: DataSource, id: string, actor: Actor, comment?: string): Promise<GpoReleaseEntity> {
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    requireStatus(release, ['awaiting_test_approval']);
    const busy = await m.getRepository(GpoReleaseEntity).findOne({ where: { status: In(PIPELINE_STATUSES) } });
    if (busy) {
      throw new GpoWorkflowError(`GPO release ${busy.label} is still ${busy.status.replace(/_/g, ' ')}; finish, reject, or roll it back first`);
    }
    release.exceptionsSnapshot = await snapshotExceptions(m, release);
    record(release, 'approved_for_test', actor, comment);
    release.status = 'test_deploying';
    release.failedStage = null;
    release.lastError = null;
    await m.getRepository(GpoReleaseEntity).save(release);
    await enqueue(m, release, 'test', 'deploy');
    return release;
  });
}

export async function approveForProduction(
  ds: DataSource,
  id: string,
  actor: Actor,
  comment?: string,
  acknowledgeUnsupported = false,
): Promise<GpoReleaseEntity> {
  const settings = await getGpoSettings();
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    requireStatus(release, ['awaiting_production_approval']);
    if (settings.requireDistinctApprovers) {
      const testApprover = [...release.decisions].reverse().find((d) => d.action === 'approved_for_test');
      if (testApprover?.actorOid && testApprover.actorOid === actor.oid) {
        throw new GpoWorkflowError('Separation of duties: production release needs a different approver than the test deployment', 403);
      }
    }
    const prod = release.environments?.production;
    const blockers = driftReasons({ uncovered: prod?.uncovered ?? [], stale: prod?.stale ?? [] });
    if (blockers.length) {
      throw new GpoWorkflowError(
        `${blockers.join('; ')}. Approve or revoke the affected exceptions, then restart the release from review so it is tested as production will receive it.`,
      );
    }
    if (prod?.unsupported?.length && !acknowledgeUnsupported) {
      throw new GpoWorkflowError(
        `${prod.unsupported.length} production difference(s) cannot be carried forward automatically; acknowledge them to release anyway`,
      );
    }
    const frozen = release.exceptionsSnapshot ?? [];
    if (frozen.length) {
      // Compared by effect: a detected exception retired and re-created with the same value still counts.
      const now = new Date();
      const live = (await m.getRepository(GpoExceptionEntity).find({
        where: { status: 'approved', gpoFamily: In([...new Set(frozen.map((e) => e.gpoFamily))]) },
      })).filter((e) => isLiveException(e, now));
      const lapsed = frozen.filter((e) => !live.some((l) => sameEffect(l, e)));
      if (lapsed.length) {
        throw new GpoWorkflowError(
          `${lapsed.length} exception(s) applied during testing have since been revoked or expired; restart this release so it is tested without them`,
        );
      }
    }
    record(release, 'approved_for_production', actor, comment);
    release.status = 'releasing';
    await m.getRepository(GpoReleaseEntity).save(release);
    await enqueue(m, release, 'production', 'release');
    return release;
  });
}

/**
 * Sends a release back to the first review so newly approved or detected
 * exceptions are frozen in and the whole test → stage path runs again.
 */
export async function restartRelease(ds: DataSource, id: string, actor: Actor, comment?: string): Promise<GpoReleaseEntity> {
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    requireStatus(release, ['awaiting_production_approval', 'failed']);
    if (productionPartiallyChanged(release)) {
      throw new GpoWorkflowError('Production links were partially changed by the failed release; retry it or roll it back');
    }
    await m.getRepository(GpoJobEntity).update(
      { releaseId: release.id, status: 'queued' },
      { status: 'cancelled', completedAt: new Date(), error: 'Release restarted' },
    );
    record(release, 'restarted', actor, comment);
    release.status = 'awaiting_test_approval';
    release.failedStage = null;
    release.lastError = null;
    release.exceptionsSnapshot = null;
    release.environments = {};
    await m.getRepository(GpoReleaseEntity).save(release);
    await enqueue(m, release, 'production', 'survey');
    return release;
  });
}

/** Queues a fresh read-only survey of the GPOs currently live in production. */
export async function resurveyProduction(ds: DataSource, id: string, actor: Actor): Promise<GpoReleaseEntity> {
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    requireStatus(release, SURVEYABLE);
    const waiting = await m.getRepository(GpoJobEntity).count({
      where: { releaseId: release.id, type: 'survey', status: In(['queued', 'claimed']) },
    });
    if (waiting) throw new GpoWorkflowError('A production survey for this release is already queued');
    record(release, 'survey_requested', actor);
    await m.getRepository(GpoReleaseEntity).save(release);
    await enqueue(m, release, 'production', 'survey');
    return release;
  });
}

const RETRY_PLAN: Record<GpoFailedStage, { status: GpoReleaseStatus; environment: GpoEnvironment; type: GpoJobType }> = {
  test_deploy: { status: 'test_deploying', environment: 'test', type: 'deploy' },
  test_validation: { status: 'test_validating', environment: 'test', type: 'validate' },
  production_stage: { status: 'staging_production', environment: 'production', type: 'stage' },
  production_release: { status: 'releasing', environment: 'production', type: 'release' },
  rollback: { status: 'rolling_back', environment: 'production', type: 'rollback' },
};

export async function retryRelease(ds: DataSource, id: string, actor: Actor, comment?: string): Promise<GpoReleaseEntity> {
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    requireStatus(release, ['failed']);
    if (!release.failedStage) throw new GpoWorkflowError('The failed stage is unknown; reject this release instead');
    const plan = RETRY_PLAN[release.failedStage];
    record(release, `retried:${release.failedStage}`, actor, comment);
    release.status = plan.status;
    release.failedStage = null;
    release.lastError = null;
    await m.getRepository(GpoReleaseEntity).save(release);
    await enqueue(m, release, plan.environment, plan.type);
    return release;
  });
}

export async function rejectRelease(ds: DataSource, id: string, actor: Actor, reason: string): Promise<GpoReleaseEntity> {
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    requireStatus(release, ['awaiting_test_approval', 'awaiting_production_approval', 'failed']);
    if (productionPartiallyChanged(release)) {
      throw new GpoWorkflowError('Production links were partially changed by the failed release; retry it or roll it back');
    }
    await m.getRepository(GpoJobEntity).update(
      { releaseId: release.id, status: 'queued' },
      { status: 'cancelled', completedAt: new Date(), error: 'Release rejected' },
    );
    record(release, 'rejected', actor, reason);
    release.status = 'rejected';
    return m.getRepository(GpoReleaseEntity).save(release);
  });
}

export async function rollbackRelease(ds: DataSource, id: string, actor: Actor, reason: string): Promise<GpoReleaseEntity> {
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const release = await loadRelease(m, id);
    if (!productionPartiallyChanged(release)) requireStatus(release, ['released']);
    const busy = await m.getRepository(GpoReleaseEntity).findOne({ where: { status: In(PIPELINE_STATUSES) } });
    if (busy && busy.id !== release.id) {
      throw new GpoWorkflowError(`GPO release ${busy.label} is in progress; resolve it before rolling back production`);
    }
    record(release, 'rollback_requested', actor, reason);
    release.status = 'rolling_back';
    release.failedStage = null;
    release.lastError = null;
    await m.getRepository(GpoReleaseEntity).save(release);
    await enqueue(m, release, 'production', 'rollback');
    return release;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent protocol
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentIdentity {
  oid: string;
  name: string;
  hostname?: string | null;
  version?: string | null;
}

export interface PackageRef {
  id: string;
  label: string;
  sourceHash: string;
  packageUrl: string;
  gpos: Array<{ backupId: string; displayName: string; family: string; backupDirectory: string }>;
}

export interface AgentJobPayload {
  job: { id: string; type: GpoJobType; environment: GpoEnvironment; attempt: number; leaseExpiresAt: string };
  release: { id: string; label: string; packageName: string; sourceHash: string; sizeBytes: number; packageUrl: string };
  gpos: Array<{ backupId: string; displayName: string; family: string; backupDirectory: string }>;
  exceptions: GpoExceptionSnapshot[];
  deployment: Pick<EnvironmentState, 'gpos' | 'links' | 'previousLinks'> | null;
  /**
   * Earlier packages a production GPO may have been imported from, so the
   * agent can tell local customizations apart from DISA content (survey/stage).
   */
  knownReleases: PackageRef[];
}

/** Requeues jobs whose agent stopped heart-beating; fails them after maxAttempts. */
async function reclaimExpiredLeases(m: EntityManager, environment: GpoEnvironment, notices: PendingNotice[]): Promise<void> {
  const jobs = await m.getRepository(GpoJobEntity).createQueryBuilder('j')
    .where('j.environment = :environment AND j.status = :status AND j.leaseExpiresAt < now()', { environment, status: 'claimed' })
    .getMany();
  for (const job of jobs) {
    if (job.attempts >= job.maxAttempts) {
      job.status = 'failed';
      job.error = `Agent lease expired ${job.attempts} times`;
      job.completedAt = new Date();
      const release = await loadRelease(m, job.releaseId);
      if (job.type !== 'survey' && release.status === EXPECTED_STATUS[job.type]) {
        fail(release, STAGE_OF[job.type], job.error, notices);
        await m.getRepository(GpoReleaseEntity).save(release);
      }
    } else {
      job.status = 'queued';
      job.claimedByOid = null;
      job.claimedBy = null;
      job.leaseExpiresAt = null;
    }
    await m.getRepository(GpoJobEntity).save(job);
  }
}

const packageRef = (r: GpoReleaseEntity): PackageRef => ({
  id: r.id,
  label: r.label,
  sourceHash: r.sourceHash,
  packageUrl: `/api/gpo/agent/releases/${r.id}/package`,
  gpos: r.gpos.map(({ backupId, displayName, family, backupDirectory }) => ({ backupId, displayName, family, backupDirectory })),
});

/** Packages that ever reached production, newest first. */
async function knownReleasesFor(m: EntityManager, current: GpoReleaseEntity): Promise<PackageRef[]> {
  const rows = await m.getRepository(GpoReleaseEntity).createQueryBuilder('r')
    .where('r.releasedAt IS NOT NULL AND r.id <> :id', { id: current.id })
    .orderBy('r.releasedAt', 'DESC')
    .take(12)
    .getMany();
  return [packageRef(current), ...rows.map(packageRef)];
}

async function payloadFor(m: EntityManager, job: GpoJobEntity, release: GpoReleaseEntity): Promise<AgentJobPayload> {
  const env = release.environments?.[job.environment];
  const needsBaselines = job.type === 'survey' || job.type === 'stage' || job.type === 'release';
  return {
    job: {
      id: job.id, type: job.type, environment: job.environment, attempt: job.attempts,
      leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
    },
    release: {
      id: release.id, label: release.label, packageName: release.packageName,
      sourceHash: release.sourceHash, sizeBytes: release.sizeBytes,
      packageUrl: `/api/gpo/agent/releases/${release.id}/package`,
    },
    gpos: release.gpos.map(({ backupId, displayName, family, backupDirectory }) => ({ backupId, displayName, family, backupDirectory })),
    exceptions: release.exceptionsSnapshot ?? [],
    deployment: env ? { gpos: env.gpos, links: env.links, previousLinks: env.previousLinks } : null,
    knownReleases: needsBaselines ? await knownReleasesFor(m, release) : [],
  };
}

export async function claimJob(ds: DataSource, environment: GpoEnvironment, agent: AgentIdentity): Promise<AgentJobPayload | null> {
  const notices: PendingNotice[] = [];
  const payload = await ds.transaction(async (m) => {
    await m.getRepository(GpoAgentEntity).save({
      environment, agentOid: agent.oid, hostname: agent.hostname ?? null,
      version: agent.version ?? null, lastSeenAt: new Date(),
    });
    await lockWorkflow(m);
    await reclaimExpiredLeases(m, environment, notices);
    const job = await m.getRepository(GpoJobEntity).createQueryBuilder('j')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .where('j.environment = :environment AND j.status = :status AND j.notBefore <= now()', { environment, status: 'queued' })
      .orderBy('j.createdAt', 'ASC')
      .getOne();
    if (!job) return null;
    const release = await loadRelease(m, job.releaseId);
    if (!jobMayRun(job.type, release)) {
      job.status = 'cancelled';
      job.error = `Release moved to ${release.status} before the job ran`;
      job.completedAt = new Date();
      await m.getRepository(GpoJobEntity).save(job);
      return null;
    }
    job.status = 'claimed';
    job.attempts += 1;
    job.claimedByOid = agent.oid;
    job.claimedBy = agent.hostname ? `${agent.name} (${agent.hostname})` : agent.name;
    job.claimedAt = new Date();
    job.leaseExpiresAt = new Date(Date.now() + leaseMinutes() * 60_000);
    job.deviations = [];
    await m.getRepository(GpoJobEntity).save(job);
    return payloadFor(m, job, release);
  });
  sendNotices(ds, notices);
  return payload;
}

async function loadClaimedJob(m: EntityManager, jobId: string, environment: GpoEnvironment, agentOid: string): Promise<GpoJobEntity> {
  const job = await m.getRepository(GpoJobEntity).findOne({ where: { id: jobId } });
  if (!job || job.environment !== environment) throw new GpoWorkflowError('Job not found', 404);
  if (job.status !== 'claimed' || job.claimedByOid !== agentOid) {
    throw new GpoWorkflowError('This agent does not hold the lease for this job');
  }
  return job;
}

export async function heartbeat(ds: DataSource, jobId: string, environment: GpoEnvironment, agentOid: string): Promise<Date> {
  return ds.transaction(async (m) => {
    const job = await loadClaimedJob(m, jobId, environment, agentOid);
    job.leaseExpiresAt = new Date(Date.now() + leaseMinutes() * 60_000);
    await m.getRepository(GpoJobEntity).save(job);
    return job.leaseExpiresAt;
  });
}

/**
 * Compares the report of a GPO the agent created with the DISA backup it was
 * imported from. Every difference should be explained by an approved exception.
 */
export async function recordGpoReport(
  ds: DataSource,
  jobId: string,
  environment: GpoEnvironment,
  agentOid: string,
  report: { gpoId: string; gpoName: string; sourceBackupId: string; reportXml: string },
): Promise<{ added: number; removed: number; changed: number }> {
  return ds.transaction(async (m) => {
    const job = await loadClaimedJob(m, jobId, environment, agentOid);
    if (job.type !== 'deploy' && job.type !== 'stage') {
      throw new GpoWorkflowError('Reports are only accepted while importing GPOs', 400);
    }
    const release = await loadRelease(m, job.releaseId, true);
    const backupId = report.sourceBackupId.toUpperCase();
    const baseline = release.settingsSnapshot?.[backupId];
    if (!baseline) throw new GpoWorkflowError(`Backup ${report.sourceBackupId} is not part of ${release.label}`, 400);
    let deployed;
    try {
      deployed = flattenGpoReport(report.reportXml);
    } catch (err) {
      throw new GpoWorkflowError(`Unreadable GPO report: ${(err as Error).message}`, 400);
    }
    const diff = diffSettings(baseline, deployed);
    job.deviations = [
      ...(job.deviations ?? []).filter((d) => normGuid(d.gpoId) !== normGuid(report.gpoId)),
      { gpoId: report.gpoId, gpoName: report.gpoName, sourceBackupId: backupId, ...diff },
    ];
    await m.getRepository(GpoJobEntity).save(job);
    return { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
  });
}

/** Decides from raw evidence whether a test deployment passed. */
export function evaluateValidation(
  evidence: ValidationEvidence | null | undefined,
  deployed: DeployedGpo[],
): ValidationOutcome {
  const reasons: string[] = [];
  const computers = evidence?.computers ?? [];
  const nameOf = new Map(deployed.map((g) => [normGuid(g.id), g.name]));
  const label = (id: string) => nameOf.get(normGuid(id)) ?? id;
  const appliedAnywhere = new Set<string>();

  if (deployed.length === 0) reasons.push('No GPOs were deployed to the test environment');
  if (computers.length === 0) reasons.push('No validation computers reported results; configure ValidationComputers on the test agent');

  for (const c of computers) {
    if (!c.reachable) {
      reasons.push(`${c.name}: unreachable${c.error ? ` (${c.error})` : ''}`);
      continue;
    }
    if (c.error) reasons.push(`${c.name}: ${c.error}`);
    const applied = new Set(c.appliedGpoIds.map(normGuid));
    const filtered = new Set(c.filteredGpoIds.map(normGuid));
    applied.forEach((id) => appliedAnywhere.add(id));
    const missing = c.expectedGpoIds.map(normGuid).filter((id) => !applied.has(id) && !filtered.has(id));
    if (missing.length) reasons.push(`${c.name}: linked GPOs did not apply: ${missing.map(label).join(', ')}`);
    if (c.extensionErrors.length) {
      reasons.push(`${c.name}: Group Policy extension errors: ${c.extensionErrors.map((e) => `${e.name} (${e.code})`).join(', ')}`);
    }
    if (c.script && !c.script.passed) {
      reasons.push(`${c.name}: validation script failed${c.script.summary ? `: ${c.script.summary}` : ''}`);
    }
  }
  for (const gpo of deployed) {
    if (!appliedAnywhere.has(normGuid(gpo.id))) {
      reasons.push(`${gpo.name} did not apply to any validation computer`);
    }
  }
  return { passed: reasons.length === 0, reasons, evaluatedAt: new Date().toISOString() };
}

export interface JobCompletion {
  success: boolean;
  error?: string;
  gpos?: DeployedGpo[];
  links?: GpoLinkRecord[];
  previousLinks?: GpoLinkRecord[];
  validation?: ValidationEvidence;
  log?: string[];
  survey?: ProductionSurvey;
}

function environmentState(job: GpoJobEntity, body: JobCompletion): EnvironmentState {
  return {
    agent: job.claimedBy ?? undefined,
    gpos: body.gpos ?? [],
    links: body.links ?? [],
    previousLinks: body.previousLinks ?? [],
    deviations: job.deviations ?? [],
    validation: null,
    outcome: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Import jobs must account for every GPO they created with an uploaded report. */
function importProblems(release: GpoReleaseEntity, job: GpoJobEntity, gpos: DeployedGpo[]): string | null {
  if (gpos.length === 0) {
    return 'The agent imported no GPOs; check that its Baselines match GPO names in this package';
  }
  const known = new Set(release.gpos.map((g) => g.backupId.toUpperCase()));
  const unknown = gpos.filter((g) => !known.has(g.sourceBackupId.toUpperCase()));
  if (unknown.length) return `GPOs reference backups outside this package: ${unknown.map((g) => g.name).join(', ')}`;
  const reported = new Set((job.deviations ?? []).map((d) => normGuid(d.gpoId)));
  const unreported = gpos.filter((g) => !reported.has(normGuid(g.id)));
  if (unreported.length) return `No settings report was uploaded for: ${unreported.map((g) => g.name).join(', ')}`;
  return null;
}

export async function completeJob(
  ds: DataSource,
  jobId: string,
  environment: GpoEnvironment,
  agentOid: string,
  body: JobCompletion,
): Promise<GpoReleaseEntity> {
  const notices: PendingNotice[] = [];
  const settings = await getGpoSettings();
  const release = await ds.transaction(async (m) => {
    await lockWorkflow(m);
    const jobs = m.getRepository(GpoJobEntity);
    const releases = m.getRepository(GpoReleaseEntity);
    const job = await loadClaimedJob(m, jobId, environment, agentOid);
    const r = await loadRelease(m, job.releaseId);

    job.completedAt = new Date();
    job.result = body as unknown as Record<string, unknown>;
    job.leaseExpiresAt = null;

    let error = body.success ? null : (body.error || 'The agent reported a failure without detail');
    if (!error && (job.type === 'deploy' || job.type === 'stage')) {
      error = importProblems(r, job, body.gpos ?? []);
    }
    if (!error && (job.type === 'survey' || job.type === 'stage') && !body.survey) {
      error = 'The agent did not report a production survey; update the agent';
    }
    job.status = error ? 'failed' : 'succeeded';
    job.error = error;
    await jobs.save(job);

    // A survey is read-only: it records findings but never moves the release.
    if (job.type === 'survey') {
      if (error || !body.survey || !SURVEYABLE.includes(r.status)) return r;
      const agent = job.claimedBy ?? 'production agent';
      r.productionSurvey = { ...body.survey, agent };
      const busy = await releases.findOne({ where: { status: In(PIPELINE_STATUSES) } });
      const counts = await recordCustomizations(m, body.survey, settings, agent, !busy || busy.id === r.id);
      // A survey after staging must be able to block a release that would lose production edits.
      const drift = r.status === 'awaiting_production_approval' ? await applyDrift(m, r, body.survey) : null;
      const unsupported = body.survey.unsupported.length;
      record(r, 'production_surveyed', SYSTEM,
        `${body.survey.customizations.length} customization(s) found; ${counts.approved} newly carried forward, `
        + `${counts.pending} awaiting approval, ${counts.retired} no longer in production, ${unsupported} not carried forward automatically`
        + (drift && driftReasons(drift).length ? `; ${driftReasons(drift).join('; ')}` : ''));
      if (counts.pending || unsupported || (drift && driftReasons(drift).length)) {
        notices.push({
          title: `Production GPO customizations need review for ${r.label}`,
          body: `${counts.pending} customization(s) found in production GPOs are waiting for approval`
            + (unsupported ? ` and ${unsupported} cannot be carried forward automatically` : '')
            + (drift && driftReasons(drift).length ? `. ${driftReasons(drift).join('; ')}; restart the release before approving it` : '')
            + '.',
          metadata: { releaseId: r.id },
        });
      }
      return releases.save(r);
    }

    if (r.status !== EXPECTED_STATUS[job.type]) {
      logger.warn(`[GPO] Ignoring ${job.type} result for ${r.label}: release is ${r.status}`);
      return r;
    }
    if (error) {
      // Link changes the agent could not revert must survive so a rollback can undo them.
      if ((job.type === 'release' || job.type === 'deploy') && (body.links?.length || body.previousLinks?.length)) {
        const prior = r.environments?.[job.environment] ?? environmentState(job, {} as JobCompletion);
        r.environments = {
          ...(r.environments ?? {}),
          [job.environment]: {
            ...prior,
            links: mergeLinks(prior.links, body.links),
            previousLinks: mergeLinks(prior.previousLinks, body.previousLinks),
            updatedAt: new Date().toISOString(),
          },
        };
      }
      fail(r, STAGE_OF[job.type], error, notices);
      return releases.save(r);
    }

    const envs = { ...(r.environments ?? {}) };
    switch (job.type) {
      case 'deploy': {
        envs.test = environmentState(job, body);
        r.status = 'test_validating';
        const validateAt = new Date(Date.now() + settings.testSoakHours * 3_600_000);
        record(r, 'deployed_to_test', SYSTEM, `Validation scheduled for ${validateAt.toISOString()}`);
        await enqueue(m, r, 'test', 'validate', validateAt);
        break;
      }
      case 'validate': {
        const test = envs.test;
        const outcome = evaluateValidation(body.validation, test?.gpos ?? []);
        envs.test = { ...(test ?? environmentState(job, {} as JobCompletion)), validation: body.validation ?? null, outcome };
        if (outcome.passed) {
          record(r, 'test_passed', SYSTEM);
          r.status = 'staging_production';
          await enqueue(m, r, 'production', 'stage');
        } else {
          r.environments = envs;
          fail(r, 'test_validation', outcome.reasons.join('; '), notices);
          return releases.save(r);
        }
        break;
      }
      case 'stage': {
        envs.production = environmentState(job, body);
        r.environments = envs;
        // Re-checked at staging: production may have been edited since review.
        const agent = job.claimedBy ?? 'production agent';
        await recordCustomizations(m, body.survey!, settings, agent, true);
        const drift = await applyDrift(m, r, body.survey!);
        envs.production = r.environments.production!;
        r.productionSurvey = { ...body.survey!, agent };
        const blockers = driftReasons(drift);
        r.status = 'awaiting_production_approval';
        record(r, 'staged_in_production', SYSTEM, blockers.length ? blockers.join('; ') : null);
        const unexplained = envs.production.deviations.filter((d) => d.added.length + d.removed.length + d.changed.length > 0);
        notices.push({
          title: `GPO release ${r.label} is staged in production and needs approval`,
          body: `Testing passed. ${envs.production.gpos.length} GPOs are imported in production and linked with the links disabled, next to the live GPOs, for side-by-side comparison.`
            + (unexplained.length ? ` ${unexplained.length} GPO(s) differ from the DISA baseline; review them against the exceptions.` : '')
            + (blockers.length
              ? ` Production changed after review (${blockers.join('; ')}); restart the release so it is tested as production will receive it.`
              : ' Approve the release to enable the new links.'),
          severity: blockers.length ? 'high' : 'medium',
          metadata: { releaseId: r.id },
        });
        break;
      }
      case 'release': {
        const prod = envs.production ?? environmentState(job, {} as JobCompletion);
        envs.production = {
          ...prod,
          links: body.links ?? [],
          // A retried release only sees links still present, so keep replacements from failed attempts.
          previousLinks: mergeLinks(prod.previousLinks, body.previousLinks),
          updatedAt: new Date().toISOString(),
        };
        r.status = 'released';
        r.releasedAt = new Date();
        record(r, 'released', SYSTEM);
        for (const older of await releases.find({ where: { status: 'released' } })) {
          if (older.id === r.id) continue;
          older.status = 'superseded';
          record(older, 'superseded', SYSTEM, `Replaced in production by ${r.label}`);
          await releases.save(older);
        }
        notices.push({
          title: `GPO release ${r.label} is live in production`,
          body: `${(body.links ?? []).length} production link(s) now point to the ${r.label} GPOs.`,
          metadata: { releaseId: r.id },
        });
        break;
      }
      case 'rollback': {
        r.status = 'rolled_back';
        record(r, 'rolled_back', SYSTEM);
        // A partially failed release never superseded the live one, so only
        // revive the prior release when nothing else is marked live.
        const live = await releases.findOne({ where: { status: 'released' } });
        const prior = live ? null : await releases.createQueryBuilder('p')
          .where('p.status = :status AND p.releasedAt IS NOT NULL AND p.id <> :id', { status: 'superseded', id: r.id })
          .orderBy('p.releasedAt', 'DESC')
          .getOne();
        if (prior) {
          prior.status = 'released';
          record(prior, 'restored_by_rollback', SYSTEM, `Rollback of ${r.label}`);
          await releases.save(prior);
        }
        notices.push({
          title: `GPO release ${r.label} was rolled back`,
          body: prior ? `Production links were restored to ${prior.label}.` : 'Production links to this release were removed.',
          severity: 'high',
          metadata: { releaseId: r.id },
        });
        break;
      }
    }
    r.environments = envs;
    return releases.save(r);
  });
  sendNotices(ds, notices);
  return release;
}

/**
 * Last check before production links change: the agent re-surveys production
 * and the release is refused if production drifted since it was staged.
 */
export async function precheckRelease(
  ds: DataSource,
  jobId: string,
  environment: GpoEnvironment,
  agentOid: string,
  survey: ProductionSurvey,
): Promise<{ ok: boolean; reasons: string[] }> {
  const settings = await getGpoSettings();
  return ds.transaction(async (m) => {
    await lockWorkflow(m);
    const job = await loadClaimedJob(m, jobId, environment, agentOid);
    if (job.type !== 'release') throw new GpoWorkflowError('Only release jobs are pre-checked', 400);
    const r = await loadRelease(m, job.releaseId);
    if (r.status !== 'releasing') throw new GpoWorkflowError(`Release is ${r.status}`);
    const agent = job.claimedBy ?? 'production agent';
    await recordCustomizations(m, survey, settings, agent, true);
    const drift = await applyDrift(m, r, survey);
    r.productionSurvey = { ...survey, agent };
    const reasons = driftReasons(drift);
    record(r, 'release_prechecked', SYSTEM, reasons.length ? reasons.join('; ') : 'production unchanged since staging');
    await m.getRepository(GpoReleaseEntity).save(r);
    return { ok: reasons.length === 0, reasons };
  });
}

/**
 * Lets an agent download a package only while it holds a survey or import job:
 * the job's own package, or a package that previously reached production
 * (the baseline a production GPO was imported from).
 */
export async function packageForAgent(
  ds: DataSource,
  releaseId: string,
  environments: GpoEnvironment[],
  agentOid: string,
): Promise<{ path: string; filename: string; sha256: string }> {
  const jobs = await ds.getRepository(GpoJobEntity).find({
    where: {
      status: 'claimed', claimedByOid: agentOid,
      environment: In(environments), type: In(['survey', 'deploy', 'stage', 'release']),
    },
  });
  if (jobs.length === 0) throw new GpoWorkflowError('No survey, import, or release job is leased to this agent', 403);
  const release = await ds.getRepository(GpoReleaseEntity).findOne({ where: { id: releaseId } });
  if (!release) throw new GpoWorkflowError('GPO release not found', 404);
  const ownJob = jobs.some((j) => j.releaseId === releaseId);
  const baseline = release.releasedAt !== null && jobs.some((j) => j.type !== 'deploy');
  if (!ownJob && !baseline) {
    throw new GpoWorkflowError('This package is not needed by any job leased to this agent', 403);
  }
  const archive = await downloadArchive(release.downloadUrl, release.sourceHash);
  if (archive.sha256 !== release.sourceHash) {
    throw new GpoWorkflowError(`DISA replaced or removed the archive for ${release.label}; the agent's local package archive is the only copy`);
  }
  return { path: archive.filePath, filename: archive.filename, sha256: archive.sha256 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export async function listReleases(ds: DataSource): Promise<GpoReleaseEntity[]> {
  return ds.getRepository(GpoReleaseEntity).find({ order: { discoveredAt: 'DESC' }, take: 50 });
}

export async function releaseDetail(ds: DataSource, id: string): Promise<{ release: GpoReleaseEntity; jobs: GpoJobEntity[] }> {
  const release = await ds.getRepository(GpoReleaseEntity).findOne({ where: { id } });
  if (!release) throw new GpoWorkflowError('GPO release not found', 404);
  const jobs = await ds.getRepository(GpoJobEntity).find({ where: { releaseId: id }, order: { createdAt: 'ASC' } });
  return { release, jobs };
}

export async function lifecycleStatus(ds: DataSource): Promise<{
  enabled: boolean; discoveryMode: string; nextCheckAt: string | null; soakHours: number;
  distinctApprovers: boolean; carryForwardMode: string; agents: GpoAgentEntity[];
}> {
  const s = await getGpoSettings();
  return {
    enabled: s.discoveryMode === 'scheduled',
    discoveryMode: s.discoveryMode,
    nextCheckAt: nextDiscoveryAt(s),
    soakHours: s.testSoakHours,
    distinctApprovers: s.requireDistinctApprovers,
    carryForwardMode: s.carryForwardMode,
    agents: await ds.getRepository(GpoAgentEntity).find(),
  };
}
