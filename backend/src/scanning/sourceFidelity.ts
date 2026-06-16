/**
 * Source Fidelity & Best-Source Selection
 *
 * A single STIG control on a single machine can be evaluated by several data
 * sources. They do not all observe the same thing:
 *
 *   - In-guest scanners (PowerSTIG, SCAP/OpenSCAP, Azure Guest Configuration)
 *     read the *actual operating-system state* — registry keys, audit policy,
 *     user-rights, services, security options, account policy, etc. They are
 *     authoritative for the bulk of a STIG benchmark.
 *   - Azure control-plane connectors (Defender for Cloud, Azure Policy) observe
 *     *cloud-plane posture* only. They can answer a thin slice of high-level
 *     controls (MFA, disk encryption, anti-malware presence, network exposure)
 *     and cannot see in-guest OS settings at all.
 *   - Resource Graph / ARM provide inventory, not compliance.
 *
 * When more than one source reports on the same (machine, control) pair we must
 * keep the result from the *highest-fidelity* source so a weaker signal never
 * silently downgrades a stronger one. This module is the single source of truth
 * for that decision, so every ingestion path (orchestrator, DSC parser, SCAP
 * parser, Guest Configuration sync) behaves identically.
 */

/** Canonical `Finding.sourceType` values understood by the precedence model. */
export type FindingSource =
  | 'manual'
  | 'stig-manager'
  | 'powerstig'
  | 'scc'
  | 'scap'
  | 'openscap'
  | 'guest-configuration'
  | 'defender'
  | 'azure-policy'
  | 'resource-graph';

/**
 * Higher number = more authoritative.
 *
 * Human decisions outrank everything: a reviewer who marks a control
 * Not Applicable (with justification) or accepts a risk must not have that
 * overwritten by an automated scan. In-guest scanners (which read real OS
 * state) outrank Azure control-plane signals, which in turn outrank inventory.
 */
export const SOURCE_FIDELITY: Record<string, number> = {
  // Human-authored — authoritative, never auto-overwritten by automation.
  manual: 1000,
  'stig-manager': 1000,

  // In-guest scanners — read actual host state (the bulk of a STIG).
  powerstig: 100, // PowerSTIG DSC audit via Run Command / Arc
  scc: 95, // DISA SCAP Compliance Checker (Windows)
  scap: 90, // SCAP / ARF in-guest evaluation
  openscap: 90, // oscap in-guest evaluation (Linux)
  'guest-configuration': 85, // Azure Guest Configuration in-guest DSC (agent-based)

  // Azure control-plane — cloud posture only, covers a thin slice of controls.
  defender: 50, // Microsoft Defender for Cloud CSPM assessment
  'azure-policy': 40, // Azure Policy compliance state

  // Inventory — presence/metadata, not a compliance verdict.
  'resource-graph': 20,
};

/** Fidelity assigned to a source we do not explicitly recognise. */
const DEFAULT_FIDELITY = 30;

/**
 * Numeric fidelity of a source. Unknown/empty sources get a low-middle default
 * so they neither clobber strong sources nor are clobbered by inventory.
 */
export function fidelityOf(source?: string | null): number {
  if (!source) return 0;
  return SOURCE_FIDELITY[source] ?? DEFAULT_FIDELITY;
}

/**
 * Best-source decision: should an incoming result replace the existing one?
 *
 * Returns true when the incoming source is at least as authoritative as the
 * source already on record. Equal fidelity replaces (a fresher run of the same
 * class of scanner is the latest truth); lower fidelity is ignored so a weak
 * control-plane signal cannot downgrade a strong in-guest result, and no
 * automated scan can overwrite a human reviewer's decision.
 */
export function shouldReplaceFinding(
  existingSource?: string | null,
  incomingSource?: string | null,
): boolean {
  return fidelityOf(incomingSource) >= fidelityOf(existingSource);
}
