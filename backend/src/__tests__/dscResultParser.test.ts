/**
 * Tests for DSC result parser — extractJson() + status mapping
 */

import { extractJson, RawAuditOutput } from '../../scanning/dscResultParser';

const VALID_JSON_OUTPUT = `
Invoke-DscResource output:
some preamble text...
###JSON_BEGIN###
{
  "ComputerName": "WIN10-TEST-01",
  "ScanDate": "2024-01-15T08:00:00Z",
  "DSCVersion": "2.1.0",
  "Results": [
    {
      "ResourceId": "[Registry]V-220700",
      "VulnNum": "V-220700",
      "Result": "True",
      "InDesiredState": true,
      "CheckType": "RegistryCheck",
      "Details": "Registry key matches expected value."
    },
    {
      "ResourceId": "[Registry]V-220701",
      "VulnNum": "V-220701",
      "Result": "False",
      "InDesiredState": false,
      "CheckType": "RegistryCheck",
      "Details": "Key value was 0, expected 1."
    },
    {
      "ResourceId": "[AuditPolicy]V-220705",
      "VulnNum": "V-220705",
      "Result": "True",
      "InDesiredState": true,
      "CheckType": "AuditPolicyCheck",
      "Details": "Audit policy configured correctly."
    }
  ]
}
###JSON_END###
Scan complete.`;

const NO_MARKERS_OUTPUT = `Just plain PowerShell output without any markers at all.`;
const MALFORMED_JSON_OUTPUT = `###JSON_BEGIN###{ "broken": true, ###JSON_END###`;

describe('extractJson', () => {
  test('extracts valid JSON block', () => {
    const result: RawAuditOutput | null = extractJson(VALID_JSON_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.ComputerName).toBe('WIN10-TEST-01');
  });

  test('returns correct number of results', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    expect(result!.Results).toHaveLength(3);
  });

  test('parses InDesiredState=true as not_a_finding indicator', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const passing = result!.Results.find((r) => r.VulnNum === 'V-220700');
    expect(passing?.InDesiredState).toBe(true);
  });

  test('parses InDesiredState=false as open indicator', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const failing = result!.Results.find((r) => r.VulnNum === 'V-220701');
    expect(failing?.InDesiredState).toBe(false);
  });

  test('returns null when no JSON markers present', () => {
    const result = extractJson(NO_MARKERS_OUTPUT);
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
    expect(result!.ScanDate).toBe('2024-01-15T08:00:00Z');
    expect(result!.DSCVersion).toBe('2.1.0');
  });
});

describe('extractJson — CheckType variety', () => {
  test('parses audit policy check type', () => {
    const result = extractJson(VALID_JSON_OUTPUT);
    const auditRule = result!.Results.find((r) => r.CheckType === 'AuditPolicyCheck');
    expect(auditRule).toBeDefined();
    expect(auditRule!.InDesiredState).toBe(true);
  });
});
