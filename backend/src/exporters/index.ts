/**
 * Export orchestrator enforcing constitution Principle IV / FR-009.
 *
 * Every Finding included in an exported checklist (CKL/JSON/CSV/POAM) must
 * carry a complete `mappingChain` so the resulting artifact is fully
 * traceable from STIG rule \u2192 Azure source signal \u2192 benchmark hash. Findings
 * missing any required mappingChain field MUST be rejected before the export
 * is generated; the orchestrator returns 422 Unprocessable Entity with a
 * structured list of offenders so callers can fix the data and retry.
 *
 * The orchestrator is deliberately stateless and synchronous; it does not
 * read from the DB itself. Routes pass in the candidate findings and the
 * orchestrator either returns them unchanged (success) or throws a typed
 * error describing the violations.
 */

export type MappingChainSource =
  | 'azure-policy'
  | 'defender'
  | 'resource-graph'
  | 'manual'
  | 'stig-manager';

export interface MappingChain {
  source: MappingChainSource | string;
  sourceRef: string;
  vulnNum: string;
  ruleId: string;
  cciRefs: string[];
  nistControls: string[];
  stigBenchmarkId: string;
  stigBenchmarkVersion: string;
  benchmarkSha256: string;
  mappedAt: string;
  mappedBy: string;
}

export interface FindingForExport {
  id: string;
  machineId?: string | null;
  controlId?: string | null;
  status?: string | null;
  severity?: string | null;
  mappingChain?: Partial<MappingChain> | null;
}

export type MappingChainViolationReason =
  | 'missing'
  | 'incomplete';

export interface MappingChainViolation {
  findingId: string;
  reason: MappingChainViolationReason;
  missingFields: string[];
}

export class MappingChainViolationError extends Error {
  public override readonly name = 'MappingChainViolationError';
  public readonly violations: MappingChainViolation[];
  public readonly statusCode = 422;
  public readonly errorCode = 'MAPPING_CHAIN_INCOMPLETE';

  constructor(violations: MappingChainViolation[]) {
    super(
      `Cannot export ${violations.length} finding(s) missing a complete mappingChain (constitution Principle IV / FR-009)`,
    );
    this.violations = violations;
  }
}

const REQUIRED_FIELDS: ReadonlyArray<keyof MappingChain> = [
  'source',
  'sourceRef',
  'vulnNum',
  'ruleId',
  'cciRefs',
  'nistControls',
  'stigBenchmarkId',
  'stigBenchmarkVersion',
  'benchmarkSha256',
  'mappedAt',
  'mappedBy',
] as const;

/**
 * Validates that every finding has a complete mappingChain. Returns the
 * findings unchanged on success; throws `MappingChainViolationError` on
 * the first batch of offenders.
 */
export function enforceMappingChain<T extends FindingForExport>(
  findings: T[],
): T[] {
  const violations: MappingChainViolation[] = [];

  for (const f of findings) {
    if (!f.mappingChain) {
      violations.push({
        findingId: f.id,
        reason: 'missing',
        missingFields: [...REQUIRED_FIELDS],
      });
      continue;
    }
    const missing = REQUIRED_FIELDS.filter((k) => !isPopulated(f.mappingChain?.[k]));
    if (missing.length > 0) {
      violations.push({
        findingId: f.id,
        reason: 'incomplete',
        missingFields: missing,
      });
    }
  }

  if (violations.length > 0) {
    throw new MappingChainViolationError(violations);
  }
  return findings;
}

function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
