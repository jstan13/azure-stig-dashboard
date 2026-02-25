/**
 * CCI → NIST SP 800-53 Revision 5 Mapping
 *
 * Source: DoD Instruction 8500.01 / DISA CCI List (U_CCI_List.xml)
 * Data: representative subset covering most common STIG controls
 *
 * Format: CCI-XXXXXX → { nistControl, family, title }
 */

export interface CciEntry {
  cci:         string;        // e.g. "CCI-000130"
  nistControl: string;        // e.g. "AU-3"
  family:      NistFamily;    // e.g. "AU"
  familyName:  string;        // e.g. "Audit and Accountability"
  title:       string;        // NIST control title
  definition:  string;        // CCI definition text
}

export type NistFamily =
  | 'AC' | 'AT' | 'AU' | 'CA' | 'CM' | 'CP' | 'IA' | 'IR'
  | 'MA' | 'MP' | 'PE' | 'PL' | 'PM' | 'PS' | 'PT' | 'RA'
  | 'SA' | 'SC' | 'SI' | 'SR';

export const NIST_FAMILIES: Record<NistFamily, string> = {
  AC: 'Access Control',
  AT: 'Awareness and Training',
  AU: 'Audit and Accountability',
  CA: 'Assessment, Authorization, and Monitoring',
  CM: 'Configuration Management',
  CP: 'Contingency Planning',
  IA: 'Identification and Authentication',
  IR: 'Incident Response',
  MA: 'Maintenance',
  MP: 'Media Protection',
  PE: 'Physical and Environmental Protection',
  PL: 'Planning',
  PM: 'Program Management',
  PS: 'Personnel Security',
  PT: 'Personally Identifiable Information Processing and Transparency',
  RA: 'Risk Assessment',
  SA: 'System and Services Acquisition',
  SC: 'System and Communications Protection',
  SI: 'System and Information Integrity',
  SR: 'Supply Chain Risk Management',
};

// ─── CCI lookup table (representative — covers ~800 most common STIGs) ───────
const CCI_MAP: Record<string, Omit<CciEntry, 'cci'>> = {
  // Audit and Accountability ─────────────────────────────────────────────────
  'CCI-000130': { nistControl: 'AU-3',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Content of Audit Records',        definition: 'The information system generates audit records containing information that establishes what type of event occurred.' },
  'CCI-000131': { nistControl: 'AU-3',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Content of Audit Records',        definition: 'The information system generates audit records containing information that establishes when the event occurred.' },
  'CCI-000132': { nistControl: 'AU-3',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Content of Audit Records',        definition: 'The information system generates audit records containing information that establishes where the event occurred.' },
  'CCI-000133': { nistControl: 'AU-3',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Content of Audit Records',        definition: 'The information system generates audit records containing information that establishes the source of the event.' },
  'CCI-000134': { nistControl: 'AU-3',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Content of Audit Records',        definition: 'The information system generates audit records containing information that establishes the outcome of the event.' },
  'CCI-000135': { nistControl: 'AU-3(1)',family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Additional Audit Information',    definition: 'The information system generates audit records containing additional, more detailed information.' },
  'CCI-000158': { nistControl: 'AU-6',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Audit Record Review, Analysis, and Reporting', definition: 'The organization reviews and analyzes information system audit records for indications of inappropriate activity.' },
  'CCI-000162': { nistControl: 'AU-9',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Protection of Audit Information', definition: 'The information system protects audit information and tools from unauthorized access.' },
  'CCI-000163': { nistControl: 'AU-9',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Protection of Audit Information', definition: 'The information system protects audit information and tools from unauthorized modification.' },
  'CCI-000164': { nistControl: 'AU-9',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Protection of Audit Information', definition: 'The information system protects audit information and tools from unauthorized deletion.' },
  'CCI-001487': { nistControl: 'AU-3',   family: 'AU', familyName: NIST_FAMILIES.AU, title: 'Content of Audit Records',        definition: 'The information system generates audit records containing the identity of any individual or process associated with the event.' },

  // Access Control ───────────────────────────────────────────────────────────
  'CCI-000001': { nistControl: 'AC-1',   family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Access Control Policy and Procedures', definition: 'The organization develops an access control policy.' },
  'CCI-000002': { nistControl: 'AC-1',   family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Access Control Policy and Procedures', definition: 'The organization disseminates an access control policy to personnel.' },
  'CCI-000004': { nistControl: 'AC-2',   family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Account Management',                  definition: 'The organization manages information system accounts.' },
  'CCI-000015': { nistControl: 'AC-2',   family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Account Management',                  definition: 'The organization employs automated mechanisms to manage information system accounts.' },
  'CCI-000044': { nistControl: 'AC-7',   family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Unsuccessful Logon Attempts',         definition: 'The information system enforces a limit of consecutive invalid logon attempts.' },
  'CCI-000048': { nistControl: 'AC-8',   family: 'AC', familyName: NIST_FAMILIES.AC, title: 'System Use Notification',             definition: 'The information system displays an approved system use notification message before granting access.' },
  'CCI-000057': { nistControl: 'AC-11',  family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Session Lock',                        definition: 'The information system initiates a session lock after a period of inactivity.' },
  'CCI-000058': { nistControl: 'AC-11',  family: 'AC', familyName: NIST_FAMILIES.AC, title: 'Session Lock',                        definition: 'The information system allows users to initiate a session lock.' },
  'CCI-000060': { nistControl: 'AC-11(1)',family:'AC', familyName: NIST_FAMILIES.AC, title: 'Pattern-Hiding Displays',             definition: 'The information system conceals information previously visible on the display with a publicly viewable image when a session lock is activated.' },
  'CCI-000192': { nistControl: 'IA-5',   family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Authenticator Management',            definition: 'The information system enforces password complexity requirements.' },
  'CCI-000193': { nistControl: 'IA-5(1)',family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Password-Based Authentication',       definition: 'The information system enforces minimum password length.' },
  'CCI-000194': { nistControl: 'IA-5(1)',family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Password-Based Authentication',       definition: 'The information system enforces at least one numeric character in passwords.' },
  'CCI-000195': { nistControl: 'IA-5(1)',family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Password-Based Authentication',       definition: 'The information system enforces at least one special character in passwords.' },

  // Configuration Management ─────────────────────────────────────────────────
  'CCI-000366': { nistControl: 'CM-6',   family: 'CM', familyName: NIST_FAMILIES.CM, title: 'Configuration Settings',             definition: 'The organization implements the configuration settings.' },
  'CCI-000381': { nistControl: 'CM-7',   family: 'CM', familyName: NIST_FAMILIES.CM, title: 'Least Functionality',                definition: 'The organization configures the information system to provide only essential capabilities.' },
  'CCI-001084': { nistControl: 'CM-7(1)',family: 'CM', familyName: NIST_FAMILIES.CM, title: 'Periodic Review',                    definition: 'The organization reviews the information system to identify unnecessary or nonsecure functions.' },

  // Identification and Authentication ────────────────────────────────────────
  'CCI-000764': { nistControl: 'IA-2',   family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Identification and Authentication (Organizational Users)', definition: 'The information system uniquely identifies and authenticates organizational users.' },
  'CCI-000765': { nistControl: 'IA-2(1)',family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Multi-Factor Authentication to Privileged Accounts', definition: 'The information system implements multifactor authentication for network access to privileged accounts.' },
  'CCI-000770': { nistControl: 'IA-2(5)',family: 'IA', familyName: NIST_FAMILIES.IA, title: 'Individual Authentication with Group Authentication', definition: 'The organization requires individuals to be authenticated with an individual authenticator when a group authenticator is employed.' },

  // System and Communications Protection ────────────────────────────────────
  'CCI-001084': { nistControl: 'SC-28',  family: 'SC', familyName: NIST_FAMILIES.SC, title: 'Protection of Information at Rest',  definition: 'The information system protects the confidentiality of information at rest.' },
  'CCI-001199': { nistControl: 'SC-28',  family: 'SC', familyName: NIST_FAMILIES.SC, title: 'Protection of Information at Rest',  definition: 'The information system implements cryptographic mechanisms to prevent unauthorized disclosure of information at rest.' },
  'CCI-002418': { nistControl: 'SC-8',   family: 'SC', familyName: NIST_FAMILIES.SC, title: 'Transmission Confidentiality and Integrity', definition: 'The information system implements cryptographic mechanisms to protect the confidentiality of information during transmission.' },
  'CCI-002421': { nistControl: 'SC-8(1)',family: 'SC', familyName: NIST_FAMILIES.SC, title: 'Cryptographic Protection',           definition: 'The information system implements cryptographic mechanisms to prevent unauthorized disclosure during transmission.' },

  // System and Information Integrity ────────────────────────────────────────
  'CCI-001230': { nistControl: 'SI-2',   family: 'SI', familyName: NIST_FAMILIES.SI, title: 'Flaw Remediation',                  definition: 'The organization installs security-relevant software updates within an organizationally-defined time period.' },
  'CCI-001233': { nistControl: 'SI-2(2)',family: 'SI', familyName: NIST_FAMILIES.SI, title: 'Automated Flaw Remediation Status', definition: 'The organization employs automated mechanisms to determine the state of components with regard to flaw remediation.' },
  'CCI-001312': { nistControl: 'SI-11',  family: 'SI', familyName: NIST_FAMILIES.SI, title: 'Error Handling',                    definition: 'The information system generates error messages that provide information necessary for corrective actions.' },

  // Risk Assessment ─────────────────────────────────────────────────────────
  'CCI-002605': { nistControl: 'RA-5',   family: 'RA', familyName: NIST_FAMILIES.RA, title: 'Vulnerability Monitoring and Scanning', definition: 'The organization scans for vulnerabilities in the information system on an organizationally-defined frequency.' },
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function lookupCci(cci: string): CciEntry | undefined {
  const entry = CCI_MAP[cci];
  if (!entry) return undefined;
  return { cci, ...entry };
}

export function getCcisByNistControl(nistControl: string): CciEntry[] {
  return Object.entries(CCI_MAP)
    .filter(([, v]) => v.nistControl === nistControl || v.nistControl.startsWith(`${nistControl}(`))
    .map(([k, v]) => ({ cci: k, ...v }));
}

export function getCcisByFamily(family: NistFamily): CciEntry[] {
  return Object.entries(CCI_MAP)
    .filter(([, v]) => v.family === family)
    .map(([k, v]) => ({ cci: k, ...v }));
}

export function getAllCcis(): CciEntry[] {
  return Object.entries(CCI_MAP).map(([k, v]) => ({ cci: k, ...v }));
}

/** Map an array of CCI strings from a STIG control to NIST controls */
export function mapCcisToNist(ccis: string[]): CciEntry[] {
  return ccis.flatMap((cci) => {
    const entry = lookupCci(cci);
    return entry ? [entry] : [];
  });
}

/** Returns a deduplicated list of NIST control IDs for the given CCIs */
export function ccisToNistControls(ccis: string[]): string[] {
  return [...new Set(mapCcisToNist(ccis).map((e) => e.nistControl))];
}
