import { generateCKL, CKLFinding } from '../exporters/cklExporter';

const sampleFindings: CKLFinding[] = [
  {
    vulnId: 'V-220700',
    ruleId: 'SV-220700r869972_rule',
    stigRef: 'WN10-AU-000005',
    title: 'Windows 10 must audit logon failures.',
    severity: 'medium',
    status: 'open',
    findingDetails: 'Logon failure auditing is not configured.',
    comments: 'Scheduled for patching in next maintenance window.',
  },
  {
    vulnId: 'V-220701',
    ruleId: 'SV-220701r569111_rule',
    stigRef: 'WN10-AC-000005',
    title: 'The built-in administrator account must be disabled.',
    severity: 'high',
    status: 'not_a_finding',
    findingDetails: '',
    comments: 'Verified disabled via GPO.',
  },
  {
    vulnId: 'V-220702',
    stigRef: 'WN10-CC-000010',
    title: 'Camera access from the lock screen must be disabled.',
    severity: 'medium',
    status: 'not_applicable',
    comments: 'Virtual machine — no physical camera attached.',
  },
];

describe('CKL Exporter', () => {
  let cklXml: string;

  beforeAll(() => {
    cklXml = generateCKL({
      machineId: 'machine-001',
      machineName: 'WIN10-WORKSTATION-01',
      osType: 'Windows',
      osVersion: 'Windows 10 Enterprise 22H2',
      hostFQDN: 'WIN10-WORKSTATION-01.domain.local',
      findings: sampleFindings,
    });
  });

  it('should produce a non-empty XML string', () => {
    expect(cklXml).toBeTruthy();
    expect(typeof cklXml).toBe('string');
  });

  it('should include XML declaration', () => {
    expect(cklXml).toContain("<?xml version='1.0'");
  });

  it('should wrap content in CHECKLIST root element', () => {
    expect(cklXml).toContain('<CHECKLIST>');
    expect(cklXml).toContain('</CHECKLIST>');
  });

  it('should include ASSET block with host name', () => {
    expect(cklXml).toContain('<HOST_NAME>WIN10-WORKSTATION-01</HOST_NAME>');
  });

  it('should include STIGS block', () => {
    expect(cklXml).toContain('<STIGS>');
    expect(cklXml).toContain('<iSTIG>');
  });

  it('should include STIG_INFO block', () => {
    expect(cklXml).toContain('<STIG_INFO>');
  });

  it('should include VULN elements for each finding', () => {
    const vulnMatches = cklXml.match(/<VULN>/g) || [];
    expect(vulnMatches.length).toBe(sampleFindings.length);
  });

  it('should map "open" to STATUS Open', () => {
    expect(cklXml).toContain('<STATUS>Open</STATUS>');
  });

  it('should map "not_a_finding" to STATUS NotAFinding', () => {
    expect(cklXml).toContain('<STATUS>NotAFinding</STATUS>');
  });

  it('should map "not_applicable" to STATUS Not_Applicable', () => {
    expect(cklXml).toContain('<STATUS>Not_Applicable</STATUS>');
  });

  it('should include Vuln_Num for each control', () => {
    expect(cklXml).toContain('V-220700');
    expect(cklXml).toContain('V-220701');
  });

  it('should include FINDING_DETAILS', () => {
    expect(cklXml).toContain('Logon failure auditing is not configured.');
  });

  it('should include COMMENTS', () => {
    expect(cklXml).toContain('Scheduled for patching');
  });
});
