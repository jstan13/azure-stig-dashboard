/**
 * Tests for check type classifier — parseCheckContent()
 */

import { parseCheckContent, CheckParseResult } from '../stigs/checkTypeParser';

describe('parseCheckContent — Registry', () => {
  test('detects HKLM registry key', () => {
    const text = `Verify this setting.
Navigate to HKLM\\System\\CurrentControlSet\\Services\\LanmanServer\\Parameters
Value Name: AutoShareWks
Value: 0 (REG_DWORD)`;
    const result: CheckParseResult = parseCheckContent(text, '');
    expect(result.checkType).toBe('Registry');
    expect(result.checkParameters.key).toContain('HKLM');
    expect(result.checkParameters.valueName).toBe('AutoShareWks');
    expect(result.checkParameters.valueData).toBeDefined();
  });

  test('detects HKEY_LOCAL_MACHINE prefix', () => {
    const text = `Registry path: HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon
Value Name: ScreenSaverGracePeriod
Value: 5`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('Registry');
    expect(result.checkParameters.valueName).toBe('ScreenSaverGracePeriod');
  });

  test('extracts REG_DWORD type', () => {
    const text = `HKLM\\SOFTWARE\\Microsoft\\Internet Explorer\\Main
Value Name: DisableFirstRunCustomize
Value: 1
Type: REG_DWORD`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('Registry');
    expect(result.checkParameters.valueType).toBe('REG_DWORD');
  });
});

describe('parseCheckContent — AuditPolicy', () => {
  test('detects audit policy success/failure', () => {
    const text = `Verify the effective setting in Local Group Policy Editor.
Computer Configuration >> Windows Settings >> Security Settings >>
Advanced Audit Policy Configuration >> System Audit Policies >> Logon/Logoff
  Audit Logon - Success and Failure`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('AuditPolicy');
    expect(result.checkParameters.subcategories.length).toBeGreaterThan(0);
    expect(result.checkParameters.subcategories[0].subcategory).toBeDefined();
  });

  test('detects failure-only audit', () => {
    const text = `Advanced Audit Policy Configuration >> Audit Account Management
  Audit User Account Management - Failure`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('AuditPolicy');
    expect(result.checkParameters.subcategories.some((s: any) => s.auditFlag === 'Failure')).toBe(true);
  });
});

describe('parseCheckContent — AccountPolicy', () => {
  test('detects minimum password length', () => {
    const text = `Verify the effective password policy settings:
The minimum password length must be 14 characters.
Navigate to Local Computer Policy >> Computer Configuration >> Windows Settings >>
Security Settings >> Account Policies >> Password Policy`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('AccountPolicy');
    expect(result.checkParameters.expectedValue).toBe('14');
  });

  test('detects lockout count', () => {
    const text = `Verify the number of allowed bad logon attempts is 3 or less.
Account lockout threshold must be 3 or less.`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('AccountPolicy');
    expect(parseInt(result.checkParameters.expectedValue)).toBeLessThanOrEqual(3);
  });
});

describe('parseCheckContent — Service', () => {
  test('detects disabled service check', () => {
    const text = `Verify the Bluetooth Support Service is disabled.
This applies to Windows 10 systems.
Services | Bluetooth Support Service must be set to Disabled.`;
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('Service');
    expect(result.checkParameters.startupType).toBe('Disabled');
  });
});

describe('parseCheckContent — Manual fallback', () => {
  test('returns Manual for unrecognized text', () => {
    const text = 'Interview the system administrator. Verify that the policy is followed.';
    const result = parseCheckContent(text, '');
    expect(result.checkType).toBe('Manual');
  });

  test('handles empty string', () => {
    const result = parseCheckContent('', '');
    expect(result.checkType).toBe('Manual');
    expect(result.checkParameters).toBeDefined();
  });
});
