/**
 * Cross-package types & enums for the Azure STIG Dashboard.
 *
 * These mirror the canonical vocabulary from
 * `specs/001-azure-stig-dashboard/data-model.md` and
 * `specs/001-azure-stig-dashboard/contracts/openapi.yaml`. Use these types
 * everywhere instead of redefining string literals in each package.
 *
 * Note: the existing scaffold under `backend/src/models/` uses some legacy
 * names (e.g. `Machine` instead of `Asset`, lowercase status strings). The
 * canonical vocabulary defined here is what flows over the wire and into
 * exports, per DISA conventions. The backend is responsible for any
 * mapping between its internal storage names and the canonical vocabulary.
 */

// ── DISA finding statuses (verbatim) ─────────────────────────────────────────
export const FindingStatus = {
  Open: 'Open',
  NotAFinding: 'NotAFinding',
  NotApplicable: 'Not_Applicable',
  NotReviewed: 'Not_Reviewed',
} as const;
export type FindingStatus = (typeof FindingStatus)[keyof typeof FindingStatus];

// ── DISA severity (verbatim) ─────────────────────────────────────────────────
export const Severity = {
  CatI: 'CAT_I',
  CatII: 'CAT_II',
  CatIII: 'CAT_III',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

// ── App roles ────────────────────────────────────────────────────────────────
export const RoleName = {
  Admin: 'admin',
  Operator: 'operator',
  Auditor: 'auditor',
} as const;
export type RoleName = (typeof RoleName)[keyof typeof RoleName];

// ── Asset / resource taxonomy ────────────────────────────────────────────────
export const ResourceType = {
  AzureVm: 'AzureVm',
  ArcMachine: 'ArcMachine',
  Aks: 'Aks',
  ArcK8s: 'ArcK8s',
  AppService: 'AppService',
  SqlDb: 'SqlDb',
  StorageAccount: 'StorageAccount',
  KeyVault: 'KeyVault',
  Other: 'Other',
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

// ── Lifecycle / state machines (data-model.md) ───────────────────────────────
export const AssetLifecycle = {
  Active: 'Active',
  Stale: 'Stale',
  Retired: 'Retired',
} as const;
export type AssetLifecycle = (typeof AssetLifecycle)[keyof typeof AssetLifecycle];

export const ScanState = {
  Queued: 'Queued',
  Evaluating: 'Evaluating',
  Evaluated: 'Evaluated',
  Failed: 'Failed',
  PartiallyEvaluated: 'PartiallyEvaluated',
} as const;
export type ScanState = (typeof ScanState)[keyof typeof ScanState];

export const ExceptionState = {
  Pending: 'Pending',
  Approved: 'Approved',
  Rejected: 'Rejected',
  Expired: 'Expired',
  Revoked: 'Revoked',
} as const;
export type ExceptionState = (typeof ExceptionState)[keyof typeof ExceptionState];

export const POAMState = {
  Open: 'Open',
  Closed: 'Closed',
  Overdue: 'Overdue',
} as const;
export type POAMState = (typeof POAMState)[keyof typeof POAMState];

export const SignalSource = {
  MachineConfiguration: 'MC_AuditPackage',
  Policy: 'Policy',
  Defender: 'Defender',
  ResourceGraph: 'ResourceGraph',
  Arm: 'Arm',
  Manual: 'Manual',
} as const;
export type SignalSource = (typeof SignalSource)[keyof typeof SignalSource];

export const ExportFormat = {
  Ckl: 'ckl',
  Cklb: 'cklb',
  Xccdf: 'xccdf',
  Oscal: 'oscal',
  Csv: 'csv',
} as const;
export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

// ── Mapping chain (FR-009 traceability) ──────────────────────────────────────
export interface MappingChain {
  source: SignalSource;
  vulnNum: string;
  ruleId: string;
  cciRefs: string[];
  nistControls: string[];
  benchmarkSha256: string;
}

// ── Audit log result ─────────────────────────────────────────────────────────
export const AuditResult = {
  Success: 'Success',
  Denied: 'Denied',
  Error: 'Error',
} as const;
export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];

// ── Legacy ↔ canonical status mapping (for backend internal storage) ─────────
/**
 * Translates the existing scaffold's lowercase status strings to canonical
 * DISA values. Backend reads/writes use this until storage is migrated.
 */
export function toCanonicalStatus(legacy: string): FindingStatus {
  switch (legacy?.toLowerCase()) {
    case 'open':
      return FindingStatus.Open;
    case 'not_a_finding':
    case 'notafinding':
      return FindingStatus.NotAFinding;
    case 'not_applicable':
    case 'notapplicable':
      return FindingStatus.NotApplicable;
    case 'not_reviewed':
    case 'notreviewed':
    default:
      return FindingStatus.NotReviewed;
  }
}

export function fromCanonicalStatus(s: FindingStatus): string {
  switch (s) {
    case FindingStatus.Open:
      return 'open';
    case FindingStatus.NotAFinding:
      return 'not_a_finding';
    case FindingStatus.NotApplicable:
      return 'not_applicable';
    case FindingStatus.NotReviewed:
      return 'not_reviewed';
  }
}

export function toCanonicalSeverity(legacy: string): Severity {
  switch (legacy?.toLowerCase()) {
    case 'high':
      return Severity.CatI;
    case 'medium':
      return Severity.CatII;
    case 'low':
      return Severity.CatIII;
    default:
      return Severity.CatII;
  }
}
