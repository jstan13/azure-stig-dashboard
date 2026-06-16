import { DataSource } from 'typeorm';
import { FindingEntity } from '../models/Finding';
import { MachineEntity } from '../models/Machine';
import { ControlEntity } from '../models/Control';
import { AssetPoolEntity } from '../models/AssetPool';
import { AssetPoolMemberEntity } from '../models/AssetPoolMember';
import { ManualAnswerEntity } from '../models/ManualAnswer';
import { platformOf } from '../utils/platform';

/**
 * manualAnswers — shared (pool / platform-scoped) manual STIG answers.
 *
 * Design: `manual_answers` is the source of truth for answers authored once at
 * a broad scope. Whenever an answer is written (or a machine is (re)scanned) we
 * **apply** it onto the affected Finding rows. Keeping the answer materialized on
 * the Finding means every existing compliance/score/export code path keeps
 * working unchanged, while the source-of-truth table guarantees new machines
 * inherit and edits re-propagate.
 *
 * Precedence (most specific wins, never overwritten by a broader scope):
 *      machine  >  pool  >  platform  >  automated/default
 */

export type ManualScope = 'machine' | 'pool' | 'platform';

const SCOPE_RANK: Record<ManualScope, number> = { machine: 3, pool: 2, platform: 1 };

const MANUAL_STATUSES = new Set(['open', 'not_a_finding', 'not_applicable', 'not_reviewed']);

export function isManualStatus(value: unknown): value is string {
  return typeof value === 'string' && MANUAL_STATUSES.has(value);
}

/** True when an incoming scope is allowed to overwrite a finding's current scope. */
export function scopeCanOverwrite(
  incoming: ManualScope,
  current: 'machine' | 'pool' | 'platform' | null,
): boolean {
  if (!current) return true; // automated/default — any manual answer applies
  return SCOPE_RANK[incoming] >= SCOPE_RANK[current];
}

/** Resolve the set of machine ids covered by a scope. */
export async function machineIdsForScope(
  ds: DataSource,
  scopeType: 'pool' | 'platform',
  scopeId: string,
): Promise<string[]> {
  if (scopeType === 'platform') {
    const machines = await ds.getRepository(MachineEntity).find();
    return machines.filter((m) => platformOf(m) === scopeId).map((m) => m.id);
  }

  // pool
  const pool = await ds.getRepository(AssetPoolEntity).findOne({ where: { id: scopeId } });
  if (!pool) return [];
  const memberRows = await ds.getRepository(AssetPoolMemberEntity).find({ where: { poolId: scopeId } });
  const ids = new Set(memberRows.map((r) => r.machineId));

  if (pool.selectionMode === 'tag' && pool.tagRule && Object.keys(pool.tagRule).length) {
    const machines = await ds.getRepository(MachineEntity).find();
    for (const m of machines) {
      const tags = m.tags ?? {};
      const matches = Object.entries(pool.tagRule).every(([k, v]) => tags[k] === v);
      if (matches) ids.add(m.id);
    }
  }
  return Array.from(ids);
}

/** Pools (active) a given machine belongs to (explicit + tag membership). */
export async function poolsForMachine(ds: DataSource, machine: MachineEntity): Promise<AssetPoolEntity[]> {
  const pools = await ds.getRepository(AssetPoolEntity).find({ where: { status: 'active' } });
  const explicit = await ds.getRepository(AssetPoolMemberEntity).find({ where: { machineId: machine.id } });
  const explicitPoolIds = new Set(explicit.map((e) => e.poolId));
  const tags = machine.tags ?? {};
  return pools.filter((p) => {
    if (explicitPoolIds.has(p.id)) return true;
    if (p.selectionMode === 'tag' && p.tagRule && Object.keys(p.tagRule).length) {
      return Object.entries(p.tagRule).every(([k, v]) => tags[k] === v);
    }
    return false;
  });
}

/** Recompute and persist complianceScore for the given machines. */
export async function recomputeCompliance(ds: DataSource, machineIds: string[]): Promise<void> {
  if (!machineIds.length) return;
  const findingRepo = ds.getRepository(FindingEntity);
  const machineRepo = ds.getRepository(MachineEntity);
  for (const machineId of machineIds) {
    const all = await findingRepo.find({ where: { machineId } });
    const applicable = all.filter((f) => f.status !== 'not_applicable');
    const passing = all.filter((f) => f.status === 'not_a_finding');
    const machine = await machineRepo.findOne({ where: { id: machineId } });
    if (!machine) continue;
    machine.complianceScore = applicable.length
      ? Math.round((passing.length / applicable.length) * 100)
      : 0;
    await machineRepo.save(machine);
  }
}

/**
 * Apply one ManualAnswer onto every covered machine's matching Finding,
 * respecting precedence. Returns the number of findings updated.
 */
export async function applyManualAnswer(ds: DataSource, answer: ManualAnswerEntity): Promise<number> {
  const machineIds = await machineIdsForScope(ds, answer.scopeType, answer.scopeId);
  if (!machineIds.length) return 0;

  const findingRepo = ds.getRepository(FindingEntity);
  const incomingScope = answer.scopeType as ManualScope;
  let updated = 0;
  const touched: string[] = [];

  for (const machineId of machineIds) {
    const finding = await findingRepo.findOne({ where: { machineId, controlId: answer.controlId } });
    if (!finding) continue; // machine isn't evaluated against this control
    if (!scopeCanOverwrite(incomingScope, finding.manualAnswerScope)) continue;

    finding.status = answer.status;
    finding.comments = answer.comments ?? finding.comments;
    finding.findingDetails = answer.findingDetails ?? finding.findingDetails;
    finding.sourceType = 'manual';
    finding.manualAnswerScope = incomingScope;
    finding.manualAnswerScopeId = answer.scopeId;
    finding.reviewedAt = new Date();
    await findingRepo.save(finding);
    updated += 1;
    touched.push(machineId);
  }

  await recomputeCompliance(ds, Array.from(new Set(touched)));
  return updated;
}

/**
 * Upsert a pool/platform manual answer and apply it.
 */
export async function upsertAndApplyManualAnswer(
  ds: DataSource,
  input: {
    scopeType: 'pool' | 'platform';
    scopeId: string;
    controlId: string;
    status: string;
    comments?: string | null;
    findingDetails?: string | null;
    answeredBy?: string | null;
  },
): Promise<{ answer: ManualAnswerEntity; applied: number }> {
  const repo = ds.getRepository(ManualAnswerEntity);
  let answer = await repo.findOne({
    where: { scopeType: input.scopeType, scopeId: input.scopeId, controlId: input.controlId },
  });

  // Capture vulnId for resilience/display.
  const control = await ds.getRepository(ControlEntity).findOne({ where: { id: input.controlId } });

  if (!answer) {
    answer = repo.create({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      controlId: input.controlId,
      vulnId: control?.vulnId ?? null,
    });
  }
  answer.status = input.status;
  answer.comments = input.comments ?? null;
  answer.findingDetails = input.findingDetails ?? null;
  answer.answeredBy = input.answeredBy ?? answer.answeredBy ?? null;
  answer = await repo.save(answer);

  const applied = await applyManualAnswer(ds, answer);
  return { answer, applied };
}

/**
 * Remove a pool/platform manual answer. Findings that were set by this exact
 * scope are reverted to 'not_reviewed' so the broader assertion no longer
 * stands; more-specific (machine) answers are left untouched.
 */
export async function revertManualAnswer(
  ds: DataSource,
  scopeType: 'pool' | 'platform',
  scopeId: string,
  controlId: string,
): Promise<number> {
  const repo = ds.getRepository(ManualAnswerEntity);
  const answer = await repo.findOne({ where: { scopeType, scopeId, controlId } });
  if (!answer) return 0;

  const findingRepo = ds.getRepository(FindingEntity);
  const machineIds = await machineIdsForScope(ds, scopeType, scopeId);
  const touched: string[] = [];
  for (const machineId of machineIds) {
    const finding = await findingRepo.findOne({ where: { machineId, controlId } });
    if (!finding) continue;
    if (finding.manualAnswerScope === scopeType && finding.manualAnswerScopeId === scopeId) {
      finding.status = 'not_reviewed';
      finding.manualAnswerScope = null;
      finding.manualAnswerScopeId = null;
      finding.reviewedAt = null;
      await findingRepo.save(finding);
      touched.push(machineId);
    }
  }
  await repo.remove(answer);
  await recomputeCompliance(ds, Array.from(new Set(touched)));
  return touched.length;
}

/**
 * Re-apply all applicable platform + pool answers onto one machine. Called when
 * a machine is (re)scanned so newly-discovered machines inherit shared answers.
 * Platform answers are applied first (lowest precedence), then pool answers.
 */
export async function reapplyAllForMachine(ds: DataSource, machine: MachineEntity): Promise<number> {
  const answerRepo = ds.getRepository(ManualAnswerEntity);
  const findingRepo = ds.getRepository(FindingEntity);

  // platform answers (precedence 1)
  const platformKey = platformOf(machine);
  const platformAnswers = await answerRepo.find({ where: { scopeType: 'platform', scopeId: platformKey } });

  // pool answers (precedence 2) — for pools this machine belongs to
  const pools = await poolsForMachine(ds, machine);
  const poolAnswers: ManualAnswerEntity[] = [];
  for (const pool of pools) {
    poolAnswers.push(...await answerRepo.find({ where: { scopeType: 'pool', scopeId: pool.id } }));
  }

  let updated = 0;
  const ordered: Array<{ scope: ManualScope; a: ManualAnswerEntity }> = [
    ...platformAnswers.map((a) => ({ scope: 'platform' as ManualScope, a })),
    ...poolAnswers.map((a) => ({ scope: 'pool' as ManualScope, a })),
  ];

  for (const { scope, a } of ordered) {
    const finding = await findingRepo.findOne({ where: { machineId: machine.id, controlId: a.controlId } });
    if (!finding) continue;
    if (!scopeCanOverwrite(scope, finding.manualAnswerScope)) continue;
    finding.status = a.status;
    finding.comments = a.comments ?? finding.comments;
    finding.findingDetails = a.findingDetails ?? finding.findingDetails;
    finding.sourceType = 'manual';
    finding.manualAnswerScope = scope;
    finding.manualAnswerScopeId = a.scopeId;
    finding.reviewedAt = new Date();
    await findingRepo.save(finding);
    updated += 1;
  }

  if (updated) await recomputeCompliance(ds, [machine.id]);
  return updated;
}
