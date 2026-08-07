/**
 * STIG Viewer Checklist (.ckl) Exporter
 *
 * Generates a STIG Viewer–compatible XML checklist file from a machine's findings.
 *
 * Format reference:
 *   STIG Viewer 2.x / 3.x uses an XML schema where each VULN element corresponds
 *   to one STIG check.  The required structure is:
 *
 *   <CHECKLIST>
 *     <ASSET>...</ASSET>
 *     <STIGS>
 *       <iSTIG>
 *         <STIG_INFO>...</STIG_INFO>
 *         <VULN>
 *           <STIG_DATA>  (multiple, key–value metadata)
 *           <STATUS>     (Open | NotAFinding | Not_Applicable | Not_Reviewed)
 *           <FINDING_DETAILS>
 *           <COMMENTS>
 *           <SEVERITY_OVERRIDE>
 *           <SEVERITY_JUSTIFICATION>
 *         </VULN>
 *       </iSTIG>
 *     </STIGS>
 *   </CHECKLIST>
 */

import { Builder } from 'xml2js';

export interface CKLExportOptions {
  machineId: string;
  machineName: string;
  osType?: string;
  osVersion?: string;
  hostFQDN?: string;
  findings: CKLFinding[];
  stigName?: string;
  stigVersion?: string;
  stigRelease?: string;
}

export interface CKLFinding {
  vulnId: string;       // e.g. V-220700
  ruleId?: string;      // e.g. SV-220700r869972_rule
  stigRef?: string;     // e.g. WN10-AU-000005
  title?: string;
  severity: string;     // high | medium | low
  status: string;       // open | not_a_finding | not_applicable | not_reviewed
  findingDetails?: string;
  comments?: string;
  severityOverride?: string;
  severityJustification?: string;
  checkContent?: string;
  fixText?: string;
  ccis?: string[];      // e.g. ["CCI-000130", "CCI-000135"]
}

/** Maps internal status strings to STIG Viewer status values */
function mapStatus(status: string): string {
  switch (status?.toLowerCase()) {
    case 'open':             return 'Open';
    case 'not_a_finding':    return 'NotAFinding';
    case 'not_applicable':   return 'Not_Applicable';
    default:                 return 'Not_Reviewed';
  }
}

/** Maps severity strings to STIG severity codes */
function mapSeverity(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'high':          return 'high';
    case 'medium':        return 'medium';
    case 'low':           return 'low';
    case 'informational': return 'informational';
    default:              return 'medium';
  }
}

export function generateCKL(options: CKLExportOptions): string {
  const {
    machineName,
    osType = 'Windows',
    osVersion = 'Windows 10',
    hostFQDN = machineName,
    findings,
    stigName = 'Microsoft Windows 10 Security Technical Implementation Guide',
    stigVersion = 'Version 2',
    stigRelease = 'Release 9',
  } = options;

  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  // Build VULN elements. xml2js renders an array under a single key as
  // repeated sibling elements, so `VULN` must be an array of VULN bodies —
  // not an array of `{ VULN: ... }` wrappers spread into the parent object
  // (that would produce invalid numeric element names).
  const vulns = findings.map((f) => ({
    STIG_DATA: [
      buildStigData('Vuln_Num',     f.vulnId),
      buildStigData('Severity',     mapSeverity(f.severity)),
      buildStigData('Group_Title',  `Group ID ${f.vulnId}`),
      buildStigData('Rule_ID',      f.ruleId || `${f.vulnId}_rule`),
      buildStigData('Rule_Ver',     f.stigRef || f.vulnId),
      buildStigData('Rule_Title',   f.title || ''),
      buildStigData('Vuln_Discuss', f.title || ''),
      buildStigData('Check_Content', f.checkContent || ''),
      buildStigData('Fix_Text',     f.fixText || ''),
      // One CCI_REF per Control Correlation Identifier (STIG Viewer allows
      // repeated CCI_REF entries). Emitted from the control's real `ccis`
      // list so NIST 800-53 traceability is preserved in the export.
      ...(f.ccis ?? [])
        .filter((cci) => typeof cci === 'string' && cci.trim().length > 0)
        .map((cci) => buildStigData('CCI_REF', cci.trim())),
    ],
    STATUS:               mapStatus(f.status),
    FINDING_DETAILS:      f.findingDetails || '',
    COMMENTS:             f.comments || '',
    SEVERITY_OVERRIDE:    f.severityOverride || '',
    SEVERITY_JUSTIFICATION: f.severityJustification || '',
  }));

  const checklistObj = {
    CHECKLIST: {
      ASSET: {
        ROLE:           'Workstation',
        ASSET_TYPE:     osType === 'Windows' ? 'Computing' : 'Computing',
        HOST_NAME:      machineName,
        HOST_IP:        '',
        HOST_MAC:       '',
        HOST_FQDN:      hostFQDN,
        TARGET_COMMENT: '',
        TECH_AREA:      '',
        TARGET_KEY:     machineName,
        WEB_OR_DATABASE: 'false',
        WEB_DB_SITE:    '',
        WEB_DB_INSTANCE: '',
      },
      STIGS: {
        iSTIG: {
          STIG_INFO: {
            SI_DATA: [
              buildSiData('version',      '2'),
              buildSiData('classification', 'UNCLASSIFIED'),
              buildSiData('customname',   ''),
              buildSiData('stigid',       stigName),
              buildSiData('description',  `${stigName} ${stigVersion} ${stigRelease}`),
              buildSiData('filename',     'U_MS_Windows-10_STIG_V2R9_Manual-xccdf.xml'),
              buildSiData('releaseinfo',  `${stigVersion} ${stigRelease} Benchmark Date: ${now}`),
              buildSiData('title',        stigName),
              buildSiData('uuid',         generateUUID()),
              buildSiData('notice',       'terms-of-use'),
              buildSiData('source',       'STIG.DOD.MIL'),
            ],
          },
          VULN: vulns,
        },
      },
    },
  };

  const builder = new Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8', standalone: false },
    renderOpts: { pretty: true, indent: '  ', newline: '\n' },
    headless: false,
  });

  return builder.buildObject(checklistObj);
}

function buildStigData(attribute: string, data: string) {
  return { ATTRIBUTE_NAME: attribute, ATTRIBUTE_DATA: data };
}

function buildSiData(name: string, data: string) {
  return { SID_NAME: name, SID_DATA: data };
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
