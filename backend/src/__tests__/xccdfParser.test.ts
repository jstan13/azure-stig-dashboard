/**
 * Tests for XCCDF parser — parseXccdf()
 */

import { parseXccdf, ParsedBenchmark } from '../../stigs/xccdfParser';

// Minimal XCCDF fixture matching DISA format
const MINIMAL_XCCDF = `<?xml version="1.0" encoding="utf-8"?>
<Benchmark xmlns="http://checklists.nist.gov/xccdf/1.1"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           id="Windows_10_STIG" resolved="1">
  <title>Windows 10 Security Technical Implementation Guide</title>
  <version>V2R8</version>
  <description>DISA Windows 10 STIG</description>
  <Group id="V-220700">
    <title>SRG-OS-000001</title>
    <Rule id="SV-220700r849121_rule" severity="medium">
      <title>Windows 10 accounts must require passwords.</title>
      <version>WN10-AC-000005</version>
      <description>Account passwords are required.</description>
      <check system="C-49099r735963_chk">
        <check-content>Verify the password policy.
Navigate to:
HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa
Value Name: MinimumPasswordLength
Value: 14</check-content>
      </check>
      <fixtext>Configure the password minimum length.</fixtext>
      <ident system="http://cyber.mil/cci">CCI-000130</ident>
      <ident system="http://cyber.mil/cci">CCI-000192</ident>
    </Rule>
  </Group>
  <Group id="V-220701">
    <title>SRG-OS-000002</title>
    <Rule id="SV-220701r849122_rule" severity="high">
      <title>Audit Policy must log success/failure for Account Logon.</title>
      <version>WN10-AU-000005</version>
      <description>Audit logon events.</description>
      <check system="C-49100r735964_chk">
        <check-content>Verify the audit policy setting.
  Security Settings >> Advanced Audit Policy Configuration >> Logon/Logoff
  Audit Logon - Success and Failure</check-content>
      </check>
      <fixtext>Configure audit policy.</fixtext>
      <ident system="http://cyber.mil/cci">CCI-000158</ident>
    </Rule>
  </Group>
</Benchmark>`;

describe('parseXccdf', () => {
  let result: ParsedBenchmark;

  beforeAll(() => {
    result = parseXccdf(MINIMAL_XCCDF);
  });

  test('parses benchmarkId', () => {
    expect(result.benchmarkId).toBe('Windows_10_STIG');
  });

  test('parses title', () => {
    expect(result.title).toContain('Windows 10');
  });

  test('parses version', () => {
    expect(result.version).toBe('V2R8');
  });

  test('parses controls', () => {
    expect(result.controls.length).toBeGreaterThanOrEqual(2);
  });

  test('parses first control vulnId', () => {
    const ctrl = result.controls.find((c) => c.vulnId === 'V-220700');
    expect(ctrl).toBeDefined();
  });

  test('parses first control severity', () => {
    const ctrl = result.controls.find((c) => c.vulnId === 'V-220700');
    expect(ctrl?.severity).toBe('medium');
  });

  test('parses CCIs', () => {
    const ctrl = result.controls.find((c) => c.vulnId === 'V-220700');
    expect(ctrl?.ccis).toContain('CCI-000130');
    expect(ctrl?.ccis).toContain('CCI-000192');
  });

  test('parses high severity', () => {
    const ctrl = result.controls.find((c) => c.vulnId === 'V-220701');
    expect(ctrl?.severity).toBe('high');
  });

  test('parses ruleId', () => {
    const ctrl = result.controls.find((c) => c.vulnId === 'V-220701');
    expect(ctrl?.ruleId).toBe('SV-220701r849122_rule');
  });

  test('has checkContent for registry rule', () => {
    const ctrl = result.controls.find((c) => c.vulnId === 'V-220700');
    expect(ctrl?.checkContent).toContain('MinimumPasswordLength');
  });

  test('throws on empty XML', () => {
    expect(() => parseXccdf('')).toThrow();
  });

  test('throws on non-XCCDF XML', () => {
    expect(() => parseXccdf('<root><foo/></root>')).toThrow();
  });
});
