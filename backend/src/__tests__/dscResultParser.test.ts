/**
 * Tests for DSC result parser — extractJson()
 *
 * extractJson() bounds the JSON block by the first '{' and last '}', so it
 * tolerates arbitrary PowerShell preamble/epilogue around the payload.
 */

import { extractJson, RawAuditOutput } from '../scanning/dscResultParser';

const VALID_JSON_OUTPUT = `
Invoke-DscResource output:
some preamble text...
{
  "Machine": "WIN10-TEST-01",
  "StigId": "Windows_10_STIG",
  "Version": "V2R8",
  "CheckedAt": "2024-01-15T08:00:00Z",
  "Results": [
    {
      "RuleId": "V-220700",
      "CheckType": "RegistryCheck",
      "Result": "Pass",
      "Reason": "Registry key matches expected value.",
      "Properties": { "ValueName": "AutoShareWks" }
    },
    {
      "RuleId": "V-220701",
      "CheckType": "RegistryCheck",
      "Result": "Fail",
      "Reason": "Key value was 0, expected 1.",
      "Properties": { "ValueName": "EnableLUA" }
    },
    {
      "RuleId": "V-220705",
      "CheckType": "AuditPolicyCheck",
      "Result": "Pass",
      "Reason": "Audit policy configured correctly.",
      "Properties": {}
    }
  ]
}
Scan complete.`;

const NO_JSON_OUTPUT = `Just plain PowerShell output without any JSON at all.`;
const MALFORMED_JSON_OUTPUT = `preamble { "broken": true, `;

describe('extractJson', () => {
  test('extracts valid JSON block', () => {
    const result: RawAuditOutput | null = extractJson(VALID_JSON_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.Machine).toBe('WIN10-TEST-01');
  });

  test('returns correct number of results', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    expect(result!.Results).toHaveLength(3);
  });

  test('parses a passing rule result', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const passing = result!.Results.find((r) => r.RuleId === 'V-220700');
    expect(passing?.Result).toBe('Pass');
  });

  test('parses a failing rule result', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const failing = result!.Results.find((r) => r.RuleId === 'V-220701');
    expect(failing?.Result).toBe('Fail');
    expect(failing?.Reason).toContain('expected 1');
  });

  test('returns null when no JSON present', () => {
    const result = extractJson(NO_JSON_OUTPUT);
    expect(result).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    const result = extractJson(MALFORMED_JSON_OUTPUT);
    expect(result).toBeNull();
  });

  test('returns null for empty string', () => {
    const result = extractJson('');
    expect(result).toBeNull();
  });

  test('handles Windows CRLF line endings', () => {
    const crlf = VALID_JSON_OUTPUT.replace(/\n/g, '\r\n');
    const result = extractJson(crlf);
    expect(result).not.toBeNull();
  });

  test('includes scan metadata', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    expect(result!.StigId).toBe('Windows_10_STIG');
    expect(result!.Version).toBe('V2R8');
    expect(result!.CheckedAt).toBe('2024-01-15T08:00:00Z');
  });
});

describe('extractJson — CheckType variety', () => {
  test('parses audit policy check type', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const auditRule = result!.Results.find((r) => r.CheckType === 'AuditPolicyCheck');
    expect(auditRule).toBeDefined();
    expect(auditRule!.Result).toBe('Pass');
  });

  test('preserves per-rule properties', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const registryRule = result!.Results.find((r) => r.RuleId === 'V-220700');
    expect(registryRule!.Properties).toEqual({ ValueName: 'AutoShareWks' });
  });
});
