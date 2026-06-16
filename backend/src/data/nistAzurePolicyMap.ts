/**
 * NIST SP 800-53 Rev. 5 control → Azure Policy / Defender reference registry.
 *
 * This is the breadth lever for the transitive mapping engine
 * ([controlMappingSeeder.ts]). A STIG rule already carries CCIs, and
 * [cciNistMapping.ts] resolves those CCIs to NIST 800-53 controls. By knowing
 * which Azure Policy definitions / Defender assessments address a given NIST
 * control, we can map *any* STIG rule that shares that control — without an
 * explicit per-rule entry.
 *
 * ── Provenance & integrity ──────────────────────────────────────────────────
 * The authoritative, full-fidelity source for this table is Microsoft's
 * built-in regulatory-compliance initiative **"NIST SP 800-53 Rev. 5"**
 * (policySetDefinition `179d1daa-458f-4e47-8086-2a68d0d6c38f`). Each policy
 * reference inside that initiative is tagged with the NIST control(s) it
 * addresses in its `metadata`. Rather than hand-transcribe ~1,000 GUIDs (which
 * would risk drift and typos), regenerate this file from the live tenant with:
 *
 *     scripts/build-nist-policy-map.ps1 -OutFile backend/src/data/nistAzurePolicyMap.generated.json
 *
 * The seeder merges `nistAzurePolicyMap.generated.json` (if present) on top of
 * the curated entries below, so the generated set always wins.
 *
 * The curated entries below are a conservative starter set covering the most
 * common, stable controls. Each is marked with a confidence and MUST be
 * validated against your environment before being relied on for an ATO.
 */

export type MappingSourceType = 'azure-policy' | 'defender';

export interface NistPolicyRef {
  sourceType: MappingSourceType;
  /**
   * The exact identifier the scan orchestrator matches against:
   *   - azure-policy: full policy definition ID
   *     (`/providers/Microsoft.Authorization/policyDefinitions/<guid>`)
   *   - defender: assessment name / id (often a GUID) or rule key (e.g. MDFC-AV-001)
   */
  sourceId: string;
  sourceName: string;
  /** 1 = exact/authoritative, 2 = related, 3 = inferred. */
  confidence: number;
  notes?: string;
}

/**
 * Curated NIST control → Azure source registry.
 *
 * Keys are NIST 800-53 control IDs as emitted by `ccisToNistControls`, e.g.
 * "IA-2", "IA-2(1)", "SC-28", "SI-3". A STIG rule is matched if ANY of its
 * resolved NIST controls is present here.
 *
 * NOTE: The GUIDs below intentionally reuse the illustrative definition IDs
 * already shipped in `docs/example-mapping.json` so the curated data is
 * internally consistent with the repo. Replace via the regeneration script for
 * production accuracy.
 */
export const NIST_AZURE_POLICY_MAP: Record<string, NistPolicyRef[]> = {
  // Identification & Authentication — multifactor authentication.
  'IA-2': [
    {
      sourceType: 'defender',
      sourceId: 'MDFC-MFA-001',
      sourceName: 'MFA should be enabled on accounts with privileged permissions',
      confidence: 2,
      notes: 'Defender for Cloud identity recommendation. Validate assessment id in your tenant.',
    },
  ],
  'IA-2(1)': [
    {
      sourceType: 'azure-policy',
      sourceId:
        '/providers/Microsoft.Authorization/policyDefinitions/931e118d-4c71-4c0a-8b13-2c18e6c6b3a3',
      sourceName: 'Accounts with owner permissions should have MFA enabled',
      confidence: 2,
      notes: 'Conditional Access / MFA enforcement. Regenerate for authoritative GUID.',
    },
  ],
  'IA-2(2)': [
    {
      sourceType: 'azure-policy',
      sourceId:
        '/providers/Microsoft.Authorization/policyDefinitions/e3e008c3-56b9-4133-8fd7-d3347377402a',
      sourceName: 'Accounts with write permissions should have MFA enabled',
      confidence: 2,
    },
  ],

  // System & Communications Protection — encryption at rest / in transit.
  'SC-28': [
    {
      sourceType: 'defender',
      sourceId: 'MDFC-ENC-001',
      sourceName: 'Disk encryption should be applied on virtual machines',
      confidence: 2,
      notes: 'Defender for Cloud data-protection recommendation.',
    },
  ],
  'SC-28(1)': [
    {
      sourceType: 'defender',
      sourceId: 'MDFC-ENC-001',
      sourceName: 'Disk encryption should be applied on virtual machines',
      confidence: 2,
    },
  ],

  // System & Information Integrity — malicious code protection.
  'SI-3': [
    {
      sourceType: 'defender',
      sourceId: 'MDFC-AV-001',
      sourceName: 'Endpoint protection should be installed on machines',
      confidence: 2,
      notes: 'Defender for Cloud endpoint-protection recommendation.',
    },
    {
      sourceType: 'azure-policy',
      sourceId:
        '/providers/Microsoft.Authorization/policyDefinitions/af6cd1bd-1635-48cb-bde7-5b15693900b9',
      sourceName: 'Microsoft Antimalware for Azure should be configured to automatically update',
      confidence: 2,
    },
  ],

  // Configuration Management — trusted launch / firmware (TPM).
  'CM-6': [
    {
      sourceType: 'azure-policy',
      sourceId:
        '/providers/Microsoft.Authorization/policyDefinitions/a8793640-60f7-487c-b5c3-1d37215905c4',
      sourceName: 'vTPM should be enabled on supported virtual machines',
      confidence: 3,
      notes: 'Trusted Launch / vTPM. Broad CM-6 baseline mapping; validate scope.',
    },
  ],
};

/** Total curated NIST controls covered (for reporting). */
export function curatedNistControlCount(): number {
  return Object.keys(NIST_AZURE_POLICY_MAP).length;
}
