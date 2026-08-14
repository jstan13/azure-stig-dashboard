/**
 * Check Type Parser
 *
 * Analyses the free-text checkContent from an XCCDF Rule and attempts to extract
 * structured, machine-readable parameters that PowerSTIG DSC resources can execute.
 *
 * PowerSTIG maps STIG rules to DSC resources by check type:
 *   Registry               → xRegistry DSC resource
 *   AuditPolicy            → auditpol.exe / xAuditPolicy
 *   UserRightsAssignment   → xUserRightsAssignment
 *   SecurityOption         → xSecurityOption (local security policy)
 *   AccountPolicy          → xAccountPolicy (password/lockout policy)
 *   Service                → xService
 *   WinEventLog            → xWinEventLog
 *   FileContent            → xFileContent
 *   IisLogging             → xWebConfigKeyValue
 *   DnsServer              → DnsServerRootHint etc.
 *   Manual                 → no automated check available
 *
 * This parser uses regex heuristics on the XCCDF checkContent text.
 * Real SCAP OVAL content provides structured checks directly; this is a
 * best-effort approximation for STIGs that only include manual check text.
 */

export interface CheckParseResult {
  checkType: string;
  checkParameters: Record<string, any>;
}

// ── Registry check patterns ───────────────────────────────────────────────

const REGISTRY_PATTERNS = [
  /HKLM\\[^\s"]+/gi,
  /HKCU\\[^\s"]+/gi,
  /HKEY_LOCAL_MACHINE\\[^\s"]+/gi,
  /HKEY_CURRENT_USER\\[^\s"]+/gi,
];

const VALUE_NAME_PATTERN = /Value\s+Name:\s*([^\n\r]+)/i;
const VALUE_DATA_PATTERN = /(?:Value|Data|Setting):\s*([^\n\r]+)/i;
const VALUE_TYPE_PATTERN = /(REG_DWORD|REG_SZ|REG_BINARY|REG_MULTI_SZ|REG_QWORD)/i;

// ── Audit policy patterns ─────────────────────────────────────────────────

const AUDIT_SUBCATEGORY_PATTERN = /(?:Audit\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})\s*[-–]\s*(Success|Failure|Success and Failure|No Auditing)/gi;
const AUDIT_ALL_PATTERN = /Advanced Audit Policy Configuration\s*>+\s*([^>]+)\s*>+\s*([^\n]+)/gi;

// ── User rights patterns ──────────────────────────────────────────────────

const USER_RIGHTS_PATTERN = /(?:policy|right|privilege)\s+["']?([A-Z][^\n"']{5,50})["']?\s+(?:must|should)\s+(?:only\s+)?(?:be\s+)?(?:assigned|include|contain|grant)/i;
const SECEDIT_PATTERN = /SE[A-Z_]+PRIVILEGE/g;

// ── Service patterns ──────────────────────────────────────────────────────

const SERVICE_NAME_PATTERN = /(?:service\s+["']([^"']+)["']|["']([^"']+)["']\s+service)\s+(?:must|should)\s+(?:be\s+)?(?:disabled|not\s+running)/i;

// ── Account / security policy patterns ────────────────────────────────────

const PASSWORD_POLICY_PHRASES = [
  'maximum password age', 'minimum password age', 'minimum password length',
  'password history', 'password complexity', 'account lockout',
  'lockout duration', 'lockout threshold',
];

const SECURITY_OPTION_PHRASES = [
  'network access:', 'network security:', 'accounts:', 'audit:', 'dcom:',
  'domain controller:', 'domain member:', 'interactive logon:', 'microsoft network',
  'recovery console:', 'shutdown:', 'system cryptography:', 'system objects:',
  'system settings:', 'user account control:', 'uac:',
];

// ── Main entry point ──────────────────────────────────────────────────────

export function parseCheckContent(
  checkContent: string,
  ruleTitle: string,
): CheckParseResult {
  if (!checkContent) return { checkType: 'Manual', checkParameters: {} };

  const text = checkContent;
  const titleLower = ruleTitle.toLowerCase();

  // Registry
  for (const pattern of REGISTRY_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return parseRegistryCheck(text, match[0]);
    }
  }

  // Audit policy
  if (
    /advanced audit policy/i.test(text) ||
    /audit subcategory/i.test(text) ||
    AUDIT_SUBCATEGORY_PATTERN.test(text)
  ) {
    return parseAuditPolicyCheck(text);
  }

  // User rights assignment
  if (SECEDIT_PATTERN.test(text) || /user rights/i.test(titleLower)) {
    return parseUserRightsCheck(text);
  }

  // Security option (local security policy)
  if (SECURITY_OPTION_PHRASES.some((p) => text.toLowerCase().includes(p))) {
    return parseSecurityOptionCheck(text);
  }

  // Account policy
  if (PASSWORD_POLICY_PHRASES.some((p) => text.toLowerCase().includes(p))) {
    return parseAccountPolicyCheck(text);
  }

  // Service
  if (/\bservice\b/i.test(text) && /disabled|not\s+running|startup/i.test(text)) {
    return parseServiceCheck(text);
  }

  // Windows Event Log size
  if (/event\s+log/i.test(titleLower) && /maximum.*size|maxsize/i.test(text)) {
    return parseWinEventLogCheck(text, ruleTitle);
  }

  // Default — no automated check available
  return { checkType: 'Manual', checkParameters: { rawCheckContent: text.substring(0, 500) } };
}

// ── Per-type parsers ──────────────────────────────────────────────────────

function parseRegistryCheck(text: string, keyMatch: string): CheckParseResult {
  // Normalise registry path
  const key = keyMatch
    .replace(/HKEY_LOCAL_MACHINE/gi, 'HKLM:')
    .replace(/HKEY_CURRENT_USER/gi, 'HKCU:')
    .replace(/HKLM\\/gi, 'HKLM:\\')
    .replace(/HKCU\\/gi, 'HKCU:\\')
    .replace(/\\\\/g, '\\');

  const valueName = (text.match(VALUE_NAME_PATTERN)?.[1] || '').trim();
  const valueType = (text.match(VALUE_TYPE_PATTERN)?.[1] || 'REG_DWORD').toUpperCase();

  // Try to extract the expected value
  const dataMatch = text.match(VALUE_DATA_PATTERN);
  let valueData = (dataMatch?.[1] || '').trim().replace(/^["']|["']$/g, '');

  // Parse decimal/hex numbers
  const hexMatch = valueData.match(/0x([0-9a-fA-F]+)/);
  if (hexMatch) valueData = String(parseInt(hexMatch[1], 16));

  // Determine operator from surrounding context
  let operator = 'Equals';
  if (/greater\s+than\s+or\s+equal|at\s+least|minimum/i.test(text)) operator = 'GreaterThanOrEqual';
  else if (/greater\s+than/i.test(text)) operator = 'GreaterThan';
  else if (/less\s+than\s+or\s+equal|at\s+most|maximum/i.test(text)) operator = 'LessThanOrEqual';
  else if (/less\s+than/i.test(text)) operator = 'LessThan';
  else if (/not\s+equal|must\s+not\s+be/i.test(text)) operator = 'NotEquals';

  return {
    checkType: 'Registry',
    checkParameters: { key, valueName, valueType, valueData, operator },
  };
}

function parseAuditPolicyCheck(text: string): CheckParseResult {
  const results: Array<{ subcategory: string; auditFlag: string }> = [];

  // Reset lastIndex for global regex
  AUDIT_SUBCATEGORY_PATTERN.lastIndex = 0;
  let m = AUDIT_SUBCATEGORY_PATTERN.exec(text);
  while (m) {
    results.push({ subcategory: m[1].trim(), auditFlag: m[2].trim() });
    m = AUDIT_SUBCATEGORY_PATTERN.exec(text);
  }

  if (results.length === 0) {
    // Try to extract from plain text
    const lines = text.split('\n').filter((l) => /audit/i.test(l));
    for (const line of lines) {
      const parts = line.match(/["""](.*?)["""]/g);
      if (parts) results.push({ subcategory: parts[0].replace(/["""]/g, ''), auditFlag: 'Success and Failure' });
    }
  }

  return {
    checkType: 'AuditPolicy',
    checkParameters: { subcategories: results },
  };
}

function parseUserRightsCheck(text: string): CheckParseResult {
  const privileges = [...new Set((text.match(SECEDIT_PATTERN) || []))];
  const allowed: string[] = [];

  // Try to extract which accounts are allowed
  const accountsMatch = text.match(/must\s+(?:only\s+)?(?:be\s+)?assigned\s+to\s+(.+?)(?:\.|$)/i);
  if (accountsMatch) {
    const raw = accountsMatch[1];
    allowed.push(...raw.split(/,|and/).map((s: string) => s.trim()).filter(Boolean));
  }

  return {
    checkType: 'UserRightsAssignment',
    checkParameters: { privileges, allowedPrincipals: allowed },
  };
}

function parseSecurityOptionCheck(text: string): CheckParseResult {
  // Find the policy name from the first matching phrase
  const firstLine = text.split('\n').find((l) =>
    SECURITY_OPTION_PHRASES.some((p) => l.toLowerCase().includes(p)),
  ) || '';
  const policyName = firstLine.trim();
  const settingMatch = text.match(/(?:must\s+be\s+set\s+to|value\s+of)\s+"?([^".\n]+)"?/i);
  const expectedValue = settingMatch?.[1]?.trim() || '';

  return {
    checkType: 'SecurityOption',
    checkParameters: { policyName, expectedValue },
  };
}

function parseAccountPolicyCheck(text: string): CheckParseResult {
  const policyType = PASSWORD_POLICY_PHRASES.find((p) => text.toLowerCase().includes(p)) || 'AccountPolicy';
  const valueMatch = text.match(/(?:must\s+be\s+(?:set\s+to\s+)?(?:configured\s+to\s+)?|value\s+of\s+)(\d+)/i);
  const expectedValue = valueMatch?.[1] || '';

  return {
    checkType: 'AccountPolicy',
    checkParameters: { policyType, expectedValue },
  };
}

function parseServiceCheck(text: string): CheckParseResult {
  const nameMatch = text.match(SERVICE_NAME_PATTERN);
  const serviceName = nameMatch?.[1] || nameMatch?.[2] || '';
  const startupType = /disabled/i.test(text) ? 'Disabled' : 'Manual';

  return {
    checkType: 'Service',
    checkParameters: { serviceName, startupType },
  };
}

function parseWinEventLogCheck(text: string, ruleTitle: string): CheckParseResult {
  const logName = /security/i.test(ruleTitle) ? 'Security'
    : /application/i.test(ruleTitle) ? 'Application'
    : /system/i.test(ruleTitle) ? 'System' : 'Security';
  const sizeMatch = text.match(/(\d+)\s*[kK][bB]/);
  const minSizeKB = sizeMatch ? parseInt(sizeMatch[1]) : 32768;

  return {
    checkType: 'WinEventLog',
    checkParameters: { logName, minSizeKB, operator: 'GreaterThanOrEqual' },
  };
}
