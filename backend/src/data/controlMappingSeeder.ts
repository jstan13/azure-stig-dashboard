/**
 * Control Mapping Seeder & Transitive Generator
 *
 * Populates the `control_mappings` table that the scan orchestrator reads to
 * turn Azure Policy / Defender signals into STIG findings. Without this, the
 * table is empty and the entire control-plane ingestion path produces nothing
 * in real (non-mock) mode.
 *
 * Two tiers of mapping are produced:
 *
 *   1. DIRECT (confidence 1) — explicit STIG-rule → Azure source pairs, taken
 *      from (a) an operator-maintained JSON file in the `example-mapping.json`
 *      shape and (b) the `azurePolicyIds` / `defenderRuleIds` columns each
 *      Control carries from XCCDF/SCAP import.
 *
 *   2. TRANSITIVE (confidence 2) — derived. Every STIG rule carries CCIs, and
 *      CCIs resolve to NIST 800-53 controls (cciNistMapping). We build an index
 *      of "NIST control → Azure source" from the direct mappings plus the
 *      curated NIST_AZURE_POLICY_MAP registry, then fan each Azure source out to
 *      ALL rules that share that NIST control. This multiplies a handful of
 *      authoritative direct mappings across hundreds of related controls.
 *
 * All writes are idempotent: a mapping is keyed by (controlId, sourceType,
 * sourceId); re-running updates the existing row rather than duplicating it. A
 * direct (confidence-1) mapping is never downgraded by a transitive one.
 */

import fs from 'fs';
import path from 'path';
import { DataSource } from 'typeorm';
import { ControlEntity } from '../models/Control';
import { ControlMappingEntity } from '../models/ControlMapping';
import { ccisToNistControls } from './cciNistMapping';
import { NIST_AZURE_POLICY_MAP, NistPolicyRef, MappingSourceType } from './nistAzurePolicyMap';
import { logger } from '../utils/logger';

export interface MappingCoverageReport {
  controlsTotal: number;
  controlsWithCcis: number;
  controlsMapped: number;
  directMappings: number;
  transitiveMappings: number;
  coveragePercent: number;
  bySource: Record<string, number>;
}

interface DirectPair {
  sourceType: MappingSourceType;
  sourceId: string;
  sourceName?: string;
}

/** Shape of the operator-maintained mapping JSON (docs/example-mapping.json). */
interface ExternalMappingFile {
  mappings?: Record<
    string,
    {
      stigId?: string;
      ruleId?: string;
      groupId?: string;
      title?: string;
      azurePolicyDefinitionIds?: string[];
      defenderRuleIds?: string[];
      notes?: string;
    }
  >;
}

/**
 * Resolve the path to the external direct-mapping JSON. Override with
 * CONTROL_MAPPING_FILE; defaults to the bundled docs/example-mapping.json.
 */
function resolveMappingFilePath(): string | null {
  const override = process.env.CONTROL_MAPPING_FILE;
  const candidates = [
    override,
    path.resolve(process.cwd(), 'docs/example-mapping.json'),
    path.resolve(__dirname, '../../../docs/example-mapping.json'),
    path.resolve(__dirname, '../../../../docs/example-mapping.json'),
  ].filter((p): p is string => !!p);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Load the external direct-mapping file, tolerating absence/parse errors. */
function loadExternalMappings(): ExternalMappingFile['mappings'] {
  const filePath = resolveMappingFilePath();
  if (!filePath) {
    logger.info('[MappingSeeder] No external mapping file found; using DB columns + registry only');
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ExternalMappingFile;
    logger.info(
      `[MappingSeeder] Loaded ${Object.keys(parsed.mappings ?? {}).length} external mapping entry(ies) from ${filePath}`,
    );
    return parsed.mappings ?? {};
  } catch (err: any) {
    logger.warn(`[MappingSeeder] Could not read mapping file ${filePath}: ${err?.message}`);
    return {};
  }
}

/** Merge the curated registry with an optional generated overlay. */
function loadNistRegistry(): Record<string, NistPolicyRef[]> {
  const merged: Record<string, NistPolicyRef[]> = {};
  for (const [k, v] of Object.entries(NIST_AZURE_POLICY_MAP)) merged[k] = [...v];

  const generatedCandidates = [
    process.env.NIST_POLICY_MAP_FILE,
    path.resolve(__dirname, 'nistAzurePolicyMap.generated.json'),
    path.resolve(__dirname, '../../src/data/nistAzurePolicyMap.generated.json'),
    path.resolve(process.cwd(), 'backend/src/data/nistAzurePolicyMap.generated.json'),
  ].filter((p): p is string => !!p);
  for (const candidate of generatedCandidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const overlay = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Record<string, NistPolicyRef[]>;
      for (const [nist, refs] of Object.entries(overlay)) {
        merged[nist] = [...(merged[nist] ?? []), ...refs];
      }
      logger.info(
        `[MappingSeeder] Merged generated NIST→policy overlay (${Object.keys(overlay).length} controls) from ${candidate}`,
      );
      break;
    } catch (err: any) {
      logger.warn(`[MappingSeeder] Could not read generated overlay ${candidate}: ${err?.message}`);
    }
  }
  return merged;
}

/** Collect the explicit Azure source pairs a single Control carries on its columns. */
function directPairsFromControl(control: ControlEntity): DirectPair[] {
  const pairs: DirectPair[] = [];
  const policyIds = new Set<string>([
    ...(control.azurePolicyIds ?? []),
    ...(control.azurePolicyId ? [control.azurePolicyId] : []),
  ]);
  const defenderIds = new Set<string>([
    ...(control.defenderRuleIds ?? []),
    ...(control.defenderRuleId ? [control.defenderRuleId] : []),
  ]);
  for (const id of policyIds) if (id) pairs.push({ sourceType: 'azure-policy', sourceId: id });
  for (const id of defenderIds) if (id) pairs.push({ sourceType: 'defender', sourceId: id });
  return pairs;
}

/**
 * Rebuild the control_mappings table for the given (or all) STIG versions.
 *
 * @param ds              Initialised data source.
 * @param stigVersionId   Optional: limit to one STIG version (used after import).
 */
export async function rebuildControlMappings(
  ds: DataSource,
  stigVersionId?: string,
): Promise<MappingCoverageReport> {
  const controlRepo = ds.getRepository(ControlEntity);
  const mappingRepo = ds.getRepository(ControlMappingEntity);

  const controls = await controlRepo.find({
    where: stigVersionId ? { stigVersionId } : {},
  });
  logger.info(`[MappingSeeder] Rebuilding mappings for ${controls.length} control(s)`);

  const external = loadExternalMappings();
  const registry = loadNistRegistry();

  // Index controls for fast lookup by the keys the external file uses.
  const byVulnId = new Map<string, ControlEntity[]>();
  const byRuleId = new Map<string, ControlEntity[]>();
  const byStigId = new Map<string, ControlEntity[]>();
  const push = (m: Map<string, ControlEntity[]>, k: string | undefined, c: ControlEntity) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    list.push(c);
    m.set(k, list);
  };
  for (const c of controls) {
    push(byVulnId, c.vulnId, c);
    push(byRuleId, c.ruleId, c);
    push(byStigId, c.stigId, c);
  }

  // ── Pass 1: collect DIRECT pairs per control ──────────────────────────────
  // controlId → (sourceType|sourceId) → DirectPair
  const directByControl = new Map<string, Map<string, DirectPair>>();
  const addDirect = (controlId: string, pair: DirectPair) => {
    const key = `${pair.sourceType}|${pair.sourceId}`;
    const inner = directByControl.get(controlId) ?? new Map<string, DirectPair>();
    if (!inner.has(key)) inner.set(key, pair);
    directByControl.set(controlId, inner);
  };

  // 1a. From the external file (matched by vulnId → ruleId → stigId).
  for (const entry of Object.values(external ?? {})) {
    const matches =
      (entry.groupId && byVulnId.get(entry.groupId)) ||
      (entry.stigId && byVulnId.get(entry.stigId)) ||
      (entry.ruleId && byRuleId.get(entry.ruleId)) ||
      (entry.stigId && byStigId.get(entry.stigId)) ||
      [];
    for (const c of matches) {
      for (const pid of entry.azurePolicyDefinitionIds ?? []) {
        addDirect(c.id, { sourceType: 'azure-policy', sourceId: pid, sourceName: entry.title });
      }
      for (const did of entry.defenderRuleIds ?? []) {
        addDirect(c.id, { sourceType: 'defender', sourceId: did, sourceName: entry.title });
      }
    }
  }

  // 1b. From each control's own columns.
  for (const c of controls) {
    for (const pair of directPairsFromControl(c)) {
      addDirect(c.id, { ...pair, sourceName: pair.sourceName ?? c.title });
    }
  }

  // ── Pass 2: build NIST control → Azure source index ───────────────────────
  // From the curated/generated registry plus every direct pair (via its CCIs).
  const nistIndex = new Map<string, Map<string, NistPolicyRef>>();
  const addToIndex = (nist: string, ref: NistPolicyRef) => {
    const key = `${ref.sourceType}|${ref.sourceId}`;
    const inner = nistIndex.get(nist) ?? new Map<string, NistPolicyRef>();
    const prev = inner.get(key);
    // Keep the strongest (lowest confidence number) reference.
    if (!prev || ref.confidence < prev.confidence) inner.set(key, ref);
    nistIndex.set(nist, inner);
  };
  for (const [nist, refs] of Object.entries(registry)) {
    for (const ref of refs) addToIndex(nist, ref);
  }
  for (const c of controls) {
    const inner = directByControl.get(c.id);
    if (!inner) continue;
    const nistControls = ccisToNistControls(c.ccis ?? []);
    for (const nist of nistControls) {
      for (const pair of inner.values()) {
        addToIndex(nist, {
          sourceType: pair.sourceType,
          sourceId: pair.sourceId,
          sourceName: pair.sourceName ?? c.title,
          confidence: 2, // direct on one rule → transitive (related) on siblings
        });
      }
    }
  }

  // ── Pass 3: assemble final per-control mapping set ────────────────────────
  // controlId → key → { pair, confidence, sourceName, notes }
  interface FinalMapping {
    sourceType: MappingSourceType;
    sourceId: string;
    sourceName?: string;
    confidence: number;
    notes?: string;
  }
  const finalByControl = new Map<string, Map<string, FinalMapping>>();
  const addFinal = (controlId: string, m: FinalMapping) => {
    const key = `${m.sourceType}|${m.sourceId}`;
    const inner = finalByControl.get(controlId) ?? new Map<string, FinalMapping>();
    const prev = inner.get(key);
    if (!prev || m.confidence < prev.confidence) inner.set(key, m);
    finalByControl.set(controlId, inner);
  };

  let directCount = 0;
  let transitiveCount = 0;

  // 3a. Direct mappings (confidence 1).
  for (const [controlId, inner] of directByControl) {
    for (const pair of inner.values()) {
      addFinal(controlId, {
        sourceType: pair.sourceType,
        sourceId: pair.sourceId,
        sourceName: pair.sourceName,
        confidence: 1,
        notes: 'Direct mapping',
      });
    }
  }

  // 3b. Transitive mappings (confidence 2) via shared NIST controls.
  for (const c of controls) {
    const nistControls = ccisToNistControls(c.ccis ?? []);
    for (const nist of nistControls) {
      const refs = nistIndex.get(nist);
      if (!refs) continue;
      for (const ref of refs.values()) {
        addFinal(c.id, {
          sourceType: ref.sourceType,
          sourceId: ref.sourceId,
          sourceName: ref.sourceName,
          confidence: Math.max(2, ref.confidence),
          notes: `Transitive via ${nist}`,
        });
      }
    }
  }

  // ── Pass 4: idempotent upsert into control_mappings ───────────────────────
  const bySource: Record<string, number> = {};
  const mappedControlIds = new Set<string>();

  for (const [controlId, inner] of finalByControl) {
    for (const m of inner.values()) {
      const existing = await mappingRepo.findOne({
        where: { controlId, sourceType: m.sourceType, sourceId: m.sourceId },
      });
      if (existing) {
        if (m.confidence < existing.confidence) {
          existing.confidence = m.confidence;
          existing.sourceName = m.sourceName ?? existing.sourceName;
          existing.notes = m.notes ?? existing.notes;
          await mappingRepo.save(existing);
        }
      } else {
        await mappingRepo.save(
          mappingRepo.create({
            controlId,
            sourceType: m.sourceType,
            sourceId: m.sourceId,
            sourceName: m.sourceName,
            confidence: m.confidence,
            notes: m.notes,
          }),
        );
      }
      mappedControlIds.add(controlId);
      bySource[m.sourceType] = (bySource[m.sourceType] ?? 0) + 1;
      if (m.confidence === 1) directCount++;
      else transitiveCount++;
    }
  }

  const controlsWithCcis = controls.filter((c) => (c.ccis ?? []).length > 0).length;
  const report: MappingCoverageReport = {
    controlsTotal: controls.length,
    controlsWithCcis,
    controlsMapped: mappedControlIds.size,
    directMappings: directCount,
    transitiveMappings: transitiveCount,
    coveragePercent: controls.length
      ? Math.round((mappedControlIds.size / controls.length) * 1000) / 10
      : 0,
    bySource,
  };

  logger.info(
    `[MappingSeeder] Done: ${report.controlsMapped}/${report.controlsTotal} controls mapped ` +
      `(${report.coveragePercent}%) — ${directCount} direct, ${transitiveCount} transitive`,
  );
  return report;
}
