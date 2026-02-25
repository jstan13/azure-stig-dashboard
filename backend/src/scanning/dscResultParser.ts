/**
 * DSC Result Parser
 *
 * Parses the JSON output from a PowerSTIG audit run into:
 *   - PowerStigResultEntity rows (one per rule per machine per run)
 *   - FindingEntity rows (upsert via vulnId + machineId)
 *
 * Input (from Run Command stdout):
 * {
 *   "Machine":   "WIN10-DC01",
 *   "StigId":    "Windows_10_STIG",
 *   "Version":   "V2R8",
 *   "CheckedAt": "2024-01-15T03:00:00.000Z",
 *   "Results": [
 *     {
 *       "RuleId":     "V-220700",
 *       "CheckType":  "Registry",
 *       "Result":     "Fail",
 *       "Reason":     "Value is 0; expected 1",
 *       "Properties": { "Key": "HKLM:\\...", "ValueName": "...", "ValueData": [1] }
 *     },
 *     ...
 *   ]
 * }
 *
 * The parser also updates the parent Finding status:
 *   Pass            → not_a_finding
 *   Fail            → open
 *   Error           → not_reviewed
 *   NotApplicable   → not_applicable
 *   Skipped         → not_reviewed
 */

import { DataSource } from 'typeorm';
import { PowerStigResultEntity } from '../models/PowerStigResult';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { MachineEntity } from '../models/Machine';
import { StigVersionEntity } from '../models/StigVersion';
import { logger } from '../utils/logger';

/** Raw JSON shape output by the PowerSTIG audit script */
export interface RawAuditOutput {
  Machine: string;
  StigId: string;
  Version: string;
  CheckedAt: string;
  Results: RawRuleResult[];
}

export interface RawRuleResult {
  RuleId: string;
  CheckType: string;
  Result: 'Pass' | 'Fail' | 'Error' | 'NotApplicable' | 'Skipped';
  Reason: string;
  Properties: Record<string, unknown>;
}

export interface ParseStigResultOptions {
  rawOutput: string;
  machineId: string;
  stigVersionId: string;
  runCommandJobId: string;
}

export interface ParseStigResultSummary {
  rulesProcessed: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  notApplicableCount: number;
  findingsCreated: number;
  findingsUpdated: number;
}

const FINDING_STATUS_MAP: Record<string, FindingEntity['status']> = {
  Pass:          'not_a_finding',
  Fail:          'open',
  Error:         'not_reviewed',
  NotApplicable: 'not_applicable',
  Skipped:       'not_reviewed',
};

/**
 * Parse PowerSTIG audit output and persist results to the database.
 */
export async function parseStigResults(
  opts: ParseStigResultOptions,
  dataSource: DataSource,
): Promise<ParseStigResultSummary> {
  const { rawOutput, machineId, stigVersionId, runCommandJobId } = opts;

  // ── 1. Extract JSON from Run Command stdout (may have extra lines) ─────────
  const auditOutput = extractJson(rawOutput);
  if (!auditOutput) {
    throw new Error('Could not parse PowerSTIG JSON output from Run Command stdout');
  }

  logger.info(
    `[DSCResultParser] Parsing ${auditOutput.Results.length} results for machine ${auditOutput.Machine} (STIG: ${auditOutput.StigId} ${auditOutput.Version})`,
  );

  const checkedAt = new Date(auditOutput.CheckedAt);
  const summary: ParseStigResultSummary = {
    rulesProcessed: 0,
    passCount: 0,
    failCount: 0,
    errorCount: 0,
    notApplicableCount: 0,
    findingsCreated: 0,
    findingsUpdated: 0,
  };

  const powerStigResultRepo = dataSource.getRepository(PowerStigResultEntity);
  const findingRepo         = dataSource.getRepository(FindingEntity);
  const controlRepo         = dataSource.getRepository(ControlEntity);

  for (const raw of auditOutput.Results) {
    summary.rulesProcessed++;

    // ── 2. Upsert PowerStigResult row ───────────────────────────────────────
    const existing = await powerStigResultRepo.findOne({
      where: { machineId, stigVersionId, ruleId: raw.RuleId },
    });

    const psResult = existing ?? powerStigResultRepo.create();
    psResult.machineId       = machineId;
    psResult.stigVersionId   = stigVersionId;
    psResult.ruleId          = raw.RuleId;
    psResult.dscResource     = raw.CheckType;
    psResult.checkType       = raw.CheckType;
    psResult.result          = raw.Result;
    psResult.reason          = raw.Reason || null;
    psResult.rawProperties   = raw.Properties ?? {};
    psResult.runCommandJobId = runCommandJobId;
    psResult.checkedAt       = checkedAt;

    await powerStigResultRepo.save(psResult);

    // ── 3. Tally result types ────────────────────────────────────────────────
    switch (raw.Result) {
      case 'Pass':          summary.passCount++;          break;
      case 'Fail':          summary.failCount++;          break;
      case 'Error':         summary.errorCount++;         break;
      case 'NotApplicable': summary.notApplicableCount++; break;
    }

    // ── 4. Resolve the Control entity for this ruleId ────────────────────────
    const control = await controlRepo.findOne({
      where: { stigVersionId, vulnId: raw.RuleId },
    });

    if (!control) {
      // Might be a SV-XXXXXX ruleId instead of V-XXXXXX vulnId; try ruleId field
      const controlByRuleId = await controlRepo.findOne({
        where: { stigVersionId, ruleId: raw.RuleId },
      });

      if (!controlByRuleId) {
        logger.debug(`[DSCResultParser] Control not found for ruleId ${raw.RuleId}, skipping finding upsert`);
        continue;
      }
    }

    const resolvedControl = control ?? await controlRepo.findOne({ where: { stigVersionId, ruleId: raw.RuleId } });
    if (!resolvedControl) continue;

    // ── 5. Upsert Finding ────────────────────────────────────────────────────
    const newStatus = FINDING_STATUS_MAP[raw.Result] ?? 'not_reviewed';

    const existingFinding = await findingRepo.findOne({
      where: { machineId, controlId: resolvedControl.id },
    });

    if (existingFinding) {
      const previousStatus = existingFinding.status;
      existingFinding.status     = newStatus;
      existingFinding.comments   = raw.Reason || existingFinding.comments;
      existingFinding.reviewedAt = new Date();

      // Preserve manual overrides: if reviewer marked as 'not_applicable' or 'not_a_finding',
      // only override back to 'open' if it's now failing
      if (
        (existingFinding.status === 'not_applicable' || existingFinding.status === 'not_a_finding') &&
        newStatus !== 'open'
      ) {
        // Keep manual override unless it newly actively fails
        existingFinding.status = existingFinding.status;
      } else {
        existingFinding.status = newStatus;
      }

      await findingRepo.save(existingFinding);
      if (previousStatus !== existingFinding.status) {
        summary.findingsUpdated++;
      }
    } else {
      // Create new finding
      const finding = findingRepo.create({
        machineId,
        controlId:    resolvedControl.id,
        status:       newStatus,
        severity:     resolvedControl.severity,
        comments:     raw.Reason || null,
        reviewedAt:   new Date(),
        dueDate:      computeDueDate(resolvedControl.severity, newStatus),
      } as any);

      await findingRepo.save(finding);
      summary.findingsCreated++;
    }
  }

  logger.info(
    `[DSCResultParser] Done: ${summary.passCount} pass / ${summary.failCount} fail / ${summary.errorCount} error / ${summary.notApplicableCount} N/A. Findings: ${summary.findingsCreated} created, ${summary.findingsUpdated} updated.`,
  );

  return summary;
}

/**
 * Extract the first occurrence of a JSON object from a string that may
 * contain PowerShell progress / informational output before the JSON.
 */
export function extractJson(text: string): RawAuditOutput | null {
  if (!text) return null;

  // Find first '{' and last '}' to bound the JSON block
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(text.slice(start, end + 1)) as RawAuditOutput;
  } catch {
    // Try line-by-line — sometimes multi-line JSON is split
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          return JSON.parse(trimmed) as RawAuditOutput;
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}

/**
 * Compute an initial due date based on severity (DOD 8531.01 timelines):
 *   CAT I  (Critical/High):  30 days
 *   CAT II (Medium):         90 days
 *   CAT III (Low/Info):     180 days
 */
function computeDueDate(severity: string, status: string): Date | null {
  if (status !== 'open') return null;

  const now = new Date();
  switch (severity?.toLowerCase()) {
    case 'critical':
    case 'high':
      return new Date(now.setDate(now.getDate() + 30));
    case 'medium':
      return new Date(now.setDate(now.getDate() + 90));
    default:
      return new Date(now.setDate(now.getDate() + 180));
  }
}
