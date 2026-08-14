/**
 * Mock seed data used when MOCK_MODE=true.
 * This populates the in-memory store so the app works without a real DB or Azure subscription.
 */

import { randomUUID as uuidv4 } from 'crypto';

export function seedMock(store: any): void {
  // ── STIG Benchmarks ────────────────────────────────────────────────────────
  store.stigBenchmarks = [
    {
      benchmarkId:           'Windows_10_STIG',
      title:                 'Microsoft Windows 10 Security Technical Implementation Guide',
      category:              'Operating System',
      platform:              'Windows',
      latestInstalledVersion:'V2R8',
      latestAvailableVersion:'V2R9',
      sourceUrl:             'https://public.cyber.mil/stigs/downloads/',
      lastContentUpdate:     new Date('2024-01-15'),
      active:                true,
    },
    {
      benchmarkId:           'Windows_Server_2022_STIG',
      title:                 'Microsoft Windows Server 2022 Security Technical Implementation Guide',
      category:              'Operating System',
      platform:              'Windows',
      latestInstalledVersion:'V2R2',
      latestAvailableVersion:'V2R2',
      sourceUrl:             'https://public.cyber.mil/stigs/downloads/',
      lastContentUpdate:     new Date('2023-10-25'),
      active:                true,
    },
    {
      benchmarkId:           'MS_Edge_STIG',
      title:                 'Microsoft Edge Security Technical Implementation Guide',
      category:              'Browser',
      platform:              'Windows',
      latestInstalledVersion:'V2R1',
      latestAvailableVersion:'V2R1',
      sourceUrl:             'https://public.cyber.mil/stigs/downloads/',
      lastContentUpdate:     new Date('2023-07-24'),
      active:                true,
    },
  ];

  store.stigVersions = [
    {
      id:            'Windows_10_STIG-V2R9',
      benchmarkId:   'Windows_10_STIG',
      version:       'V2R9',
      releaseInfo:   'Release: 9 Benchmark Date: 25 Jan 2024',
      benchmarkDate: new Date('2024-01-25'),
      ruleCount:     276,
      catICount:     5,
      catIICount:    248,
      catIIICount:   23,
      status:        'active',
    },
    {
      id:            'Windows_10_STIG-V2R8',
      benchmarkId:   'Windows_10_STIG',
      version:       'V2R8',
      releaseInfo:   'Release: 8 Benchmark Date: 25 Oct 2023',
      benchmarkDate: new Date('2023-10-25'),
      ruleCount:     275,
      catICount:     5,
      catIICount:    247,
      catIIICount:   23,
      status:        'superseded',
    },
    {
      id:            'Windows_Server_2022_STIG-V2R2',
      benchmarkId:   'Windows_Server_2022_STIG',
      version:       'V2R2',
      releaseInfo:   'Release: 2 Benchmark Date: 25 Oct 2023',
      benchmarkDate: new Date('2023-10-25'),
      ruleCount:     291,
      catICount:     6,
      catIICount:    254,
      catIIICount:   31,
      status:        'active',
    },
  ];

  // ── Controls (STIG rules) ──────────────────────────────────────────────────
  store.controls = [
    {
      id:             'Windows_10_STIG|V-220700',
      vulnId:         'V-220700',
      ruleId:         'SV-220700r849121_rule',
      stigId:         'WN10-AU-000005',
      title:          'Windows 10 must be configured to audit Account Logon Logoff - Logon failures.',
      severity:       'medium',
      checkType:      'AuditPolicy',
      checkParameters:{ type: 'AuditPolicy', subcategories: ['Logon'] },
      ccis:           ['CCI-000172', 'CCI-002234'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Maintaining an audit trail of system activity logs can help identify configuration errors.',
      checkContent:   'Security Option "Audit: Force audit policy subcategory settings" must be set to "Enabled". Verify the effective audit policy for "Logon" includes "Failure".',
      fixText:        'Configure Computer Configuration >> Windows Settings >> Security Settings >> Advanced Audit Policy Configuration >> Logon/Logoff >> Audit Logon to include "Failure".',
    },
    {
      id:             'Windows_10_STIG|V-220701',
      vulnId:         'V-220701',
      ruleId:         'SV-220701r849124_rule',
      stigId:         'WN10-AC-000005',
      title:          'The built-in administrator account must be disabled.',
      severity:       'high',
      checkType:      'SecurityOption',
      checkParameters:{ type: 'SecurityOption', name: 'Accounts_Administrator_account_status', value: 'Disabled' },
      ccis:           ['CCI-000764'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Windows 10 contains a built-in administrator account that cannot be locked out.',
      checkContent:   'Open "Computer Management". Navigate to Local Users and Groups >> Users. Double-click on built-in "Administrator". Verify "Account is disabled" is checked.',
      fixText:        'Configure Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> Security Options >> "Accounts: Administrator account status" to "Disabled".',
    },
    {
      id:             'Windows_10_STIG|V-220702',
      vulnId:         'V-220702',
      ruleId:         'SV-220702r849127_rule',
      stigId:         'WN10-CC-000010',
      title:          'Camera access from the lock screen must be disabled.',
      severity:       'medium',
      checkType:      'Registry',
      checkParameters:{ type: 'Registry', key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization', valueName: 'NoLockScreenCamera', valueType: 'DWORD', valueData: 1 },
      ccis:           ['CCI-000381'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Enabling camera access from the lock screen could allow for unauthorized data collection.',
      checkContent:   'If the registry value does not exist or is not configured as specified, this is a finding.\nHKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization NoLockScreenCamera = 1',
      fixText:        'Configure Computer Configuration >> Administrative Templates >> Control Panel >> Personalization >> "Prevent enabling lock screen camera" to "Enabled".',
    },
    {
      id:             'Windows_10_STIG|V-220703',
      vulnId:         'V-220703',
      ruleId:         'SV-220703r849130_rule',
      stigId:         'WN10-SO-000030',
      title:          'Anonymous enumeration of SAM accounts must not be allowed.',
      severity:       'high',
      checkType:      'Registry',
      checkParameters:{ type: 'Registry', key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa', valueName: 'RestrictAnonymousSAM', valueType: 'DWORD', valueData: 1 },
      ccis:           ['CCI-001090'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Anonymous enumeration of SAM accounts allows anonymous logon users to list all account names.',
      checkContent:   'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\RestrictAnonymousSAM = 1',
      fixText:        'Configure Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> Security Options >> "Network access: Do not allow anonymous enumeration of SAM accounts" to "Enabled".',
    },
    {
      id:             'Windows_10_STIG|V-220704',
      vulnId:         'V-220704',
      ruleId:         'SV-220704r849133_rule',
      stigId:         'WN10-CC-000052',
      title:          'Windows 10 must be configured to prevent users from receiving suggestions for third-party applications.',
      severity:       'low',
      checkType:      'Registry',
      checkParameters:{ type: 'Registry', key: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', valueName: 'DisableWindowsConsumerFeatures', valueType: 'DWORD', valueData: 1 },
      ccis:           ['CCI-000381'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Should third-party applications be installed without knowledge of system administrators...',
      checkContent:   'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager DisableWindowsConsumerFeatures = 1',
      fixText:        'Configure Computer Configuration >> Administrative Templates >> Windows Components >> Cloud Content >> "Turn off Microsoft consumer experiences" to "Enabled".',
    },
    {
      id:             'Windows_10_STIG|V-220705',
      vulnId:         'V-220705',
      ruleId:         'SV-220705r849136_rule',
      stigId:         'WN10-UR-000015',
      title:          'The "Create a token object" user right must not be assigned to any groups or accounts.',
      severity:       'high',
      checkType:      'UserRightsAssignment',
      checkParameters:{ type: 'UserRightsAssignment', privilege: 'SeCreateTokenPrivilege', identity: [] },
      ccis:           ['CCI-002235'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Inappropriate granting of user rights can provide system, administrative, and other high-level capabilities.',
      checkContent:   'Verify the effective setting in Local Group Policy Editor. Run "gpedit.msc". Navigate to Local Computer Policy >> Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> User Rights Assignment >> "Create a token object".',
      fixText:        'Configure the policy value for Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> User Rights Assignment >> "Create a token object" to be defined but containing no entries (blank).',
    },
    {
      id:             'Windows_10_STIG|V-220706',
      vulnId:         'V-220706',
      ruleId:         'SV-220706r849139_rule',
      stigId:         'WN10-SV-000020',
      title:          'The Windows Remote Management (WinRM) service must not store RunAs credentials.',
      severity:       'high',
      checkType:      'Registry',
      checkParameters:{ type: 'Registry', key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WinRM\\Service', valueName: 'DisableRunAs', valueType: 'DWORD', valueData: 1 },
      ccis:           ['CCI-002038'],
      benchmarkId:    'Windows_10_STIG',
      stigVersionId:  'Windows_10_STIG-V2R9',
      description:    'Storage of administrative credentials could allow unauthorized access.',
      checkContent:   'If the registry value is not 0x00000001 (1), this is a finding.',
      fixText:        'Configure Computer Configuration >> Administrative Templates >> Windows Components >> Windows Remote Management (WinRM) >> WinRM Service >> "Disallow WinRM from storing RunAs credentials" to "Enabled".',
    },
  ];

  // ── Machines ───────────────────────────────────────────────────────────────
  // Two tenants, four subscriptions, multiple resource groups so the
  // hierarchy explorer has something interesting to show.
  const TENANT_A_ID = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
  const TENANT_B_ID = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
  const SUB_PROD = '00000000-0000-0000-0000-000000000001';
  const SUB_DEV  = '00000000-0000-0000-0000-000000000002';
  const SUB_MGMT = '00000000-0000-0000-0000-000000000003';
  const SUB_GOV  = '11111111-1111-1111-1111-111111111111';
  store.machines = [
    {
      id: 'machine-001',
      name: 'WIN10-WORKSTATION-01',
      resourceId: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/WIN10-WORKSTATION-01',
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_PROD,
      subscriptionName: 'Contoso Production',
      resourceGroupName: 'rg-demo',
      location: 'eastus',
      osType: 'Windows',
      osVersion: 'Windows 10 Enterprise 22H2',
      tags: { Environment: 'Demo', Owner: 'IT-Security' },
      complianceScore: 78,
      lastScanDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    {
      id: 'machine-002',
      name: 'WIN10-WORKSTATION-02',
      resourceId: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/WIN10-WORKSTATION-02',
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_PROD,
      subscriptionName: 'Contoso Production',
      resourceGroupName: 'rg-demo',
      location: 'eastus',
      osType: 'Windows',
      osVersion: 'Windows 10 Enterprise 21H2',
      tags: { Environment: 'Demo', Owner: 'IT-Security' },
      complianceScore: 64,
      lastScanDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    {
      id: 'machine-003',
      name: 'WIN10-WORKSTATION-03',
      resourceId: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/WIN10-WORKSTATION-03',
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_PROD,
      subscriptionName: 'Contoso Production',
      resourceGroupName: 'rg-prod',
      location: 'westus2',
      osType: 'Windows',
      osVersion: 'Windows 11 Enterprise 23H2',
      tags: { Environment: 'Production', Owner: 'IT-Security' },
      complianceScore: 91,
      lastScanDate: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    // Azure Arc-connected on-premises server — demonstrates Arc support.
    // resourceId uses the HybridCompute provider so connectors can identify it
    // as an Arc machine and use the appropriate SDK/persona.
    {
      id: 'machine-004',
      name: 'ARC-ONPREM-01',
      resourceId: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-arc/providers/Microsoft.HybridCompute/machines/ARC-ONPREM-01',
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_PROD,
      subscriptionName: 'Contoso Production',
      resourceGroupName: 'rg-arc',
      location: 'eastus',
      osType: 'Windows',
      osVersion: 'Windows Server 2022 Datacenter',
      tags: { Environment: 'OnPremises', Owner: 'IT-Security', ArcEnrolled: 'true' },
      complianceScore: 55,
      lastScanDate: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      status: 'online',
      arcAgentVersion: '1.38.02849.1547',
    },
    // ── Tenant A — Dev subscription ────────────────────────────────────────
    {
      id: 'machine-005',
      name: 'DEV-WEB-01',
      resourceId: `/subscriptions/${SUB_DEV}/resourceGroups/rg-web/providers/Microsoft.Compute/virtualMachines/DEV-WEB-01`,
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_DEV,
      subscriptionName: 'Contoso Dev/Test',
      resourceGroupName: 'rg-web',
      location: 'eastus2',
      osType: 'Linux',
      osVersion: 'Ubuntu 22.04 LTS',
      tags: { Environment: 'Dev', Owner: 'WebApp-Team' },
      complianceScore: 82,
      lastScanDate: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    {
      id: 'machine-006',
      name: 'DEV-DB-01',
      resourceId: `/subscriptions/${SUB_DEV}/resourceGroups/rg-data/providers/Microsoft.Compute/virtualMachines/DEV-DB-01`,
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_DEV,
      subscriptionName: 'Contoso Dev/Test',
      resourceGroupName: 'rg-data',
      location: 'eastus2',
      osType: 'Linux',
      osVersion: 'RHEL 9.2',
      tags: { Environment: 'Dev', Owner: 'Data-Team' },
      complianceScore: 71,
      lastScanDate: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    // ── Tenant A — Management subscription ─────────────────────────────────
    {
      id: 'machine-007',
      name: 'MGMT-JUMP-01',
      resourceId: `/subscriptions/${SUB_MGMT}/resourceGroups/rg-bastion/providers/Microsoft.Compute/virtualMachines/MGMT-JUMP-01`,
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_MGMT,
      subscriptionName: 'Contoso Management',
      resourceGroupName: 'rg-bastion',
      location: 'centralus',
      osType: 'Windows',
      osVersion: 'Windows Server 2022 Datacenter',
      tags: { Environment: 'Mgmt', Owner: 'Platform' },
      complianceScore: 94,
      lastScanDate: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    {
      id: 'machine-008',
      name: 'MGMT-MONITOR-01',
      resourceId: `/subscriptions/${SUB_MGMT}/resourceGroups/rg-monitor/providers/Microsoft.Compute/virtualMachines/MGMT-MONITOR-01`,
      tenantId: TENANT_A_ID,
      tenantName: 'Contoso (Commercial)',
      subscriptionId: SUB_MGMT,
      subscriptionName: 'Contoso Management',
      resourceGroupName: 'rg-monitor',
      location: 'centralus',
      osType: 'Linux',
      osVersion: 'Ubuntu 24.04 LTS',
      tags: { Environment: 'Mgmt', Owner: 'Platform' },
      complianceScore: 88,
      lastScanDate: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
    // ── Tenant B — separate Azure AD tenant (e.g. Gov) ─────────────────────
    {
      id: 'machine-009',
      name: 'GOV-APP-01',
      resourceId: `/subscriptions/${SUB_GOV}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/GOV-APP-01`,
      tenantId: TENANT_B_ID,
      tenantName: 'Fabrikam-Gov (US Gov)',
      subscriptionId: SUB_GOV,
      subscriptionName: 'Fabrikam-Gov Production',
      resourceGroupName: 'rg-app',
      location: 'usgovvirginia',
      osType: 'Windows',
      osVersion: 'Windows Server 2022 Datacenter',
      tags: { Environment: 'Production', Owner: 'Mission-System', Classification: 'Controlled' },
      complianceScore: 97,
      lastScanDate: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      status: 'online',
    },
    {
      id: 'machine-010',
      name: 'GOV-DB-01',
      resourceId: `/subscriptions/${SUB_GOV}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/GOV-DB-01`,
      tenantId: TENANT_B_ID,
      tenantName: 'Fabrikam-Gov (US Gov)',
      subscriptionId: SUB_GOV,
      subscriptionName: 'Fabrikam-Gov Production',
      resourceGroupName: 'rg-app',
      location: 'usgovvirginia',
      osType: 'Linux',
      osVersion: 'RHEL 8.10',
      tags: { Environment: 'Production', Owner: 'Mission-System', Classification: 'Controlled' },
      complianceScore: 89,
      lastScanDate: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      status: 'online',
    },
    {
      id: 'machine-011',
      name: 'GOV-DC-01',
      resourceId: `/subscriptions/${SUB_GOV}/resourceGroups/rg-identity/providers/Microsoft.Compute/virtualMachines/GOV-DC-01`,
      tenantId: TENANT_B_ID,
      tenantName: 'Fabrikam-Gov (US Gov)',
      subscriptionId: SUB_GOV,
      subscriptionName: 'Fabrikam-Gov Production',
      resourceGroupName: 'rg-identity',
      location: 'usgovtexas',
      osType: 'Windows',
      osVersion: 'Windows Server 2022 Datacenter',
      tags: { Environment: 'Production', Owner: 'Identity-Team', Classification: 'Controlled' },
      complianceScore: 76,
      lastScanDate: new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString(),
      status: 'online',
    },
  ];

  // ── Findings ───────────────────────────────────────────────────────────────
  const statuses = ['open', 'not_a_finding', 'not_applicable', 'not_reviewed'];
  store.findings = [];

  for (const machine of store.machines) {
    for (const control of store.controls) {
      const rand = Math.random();
      const status = rand < 0.3 ? 'open' : rand < 0.7 ? 'not_a_finding' : rand < 0.85 ? 'not_applicable' : 'not_reviewed';
      store.findings.push({
        id: uuidv4(),
        machineId: machine.id,
        controlId: control.id,          // now "Windows_10_STIG|V-220700"
        status,
        severity: control.severity,
        comments: status === 'not_a_finding'
          ? 'Verified compliant via automated check.'
          : status === 'open'
          ? 'Finding confirmed — remediation required.'
          : '',
        findingDetails: status === 'open'
          ? `Control ${control.vulnId ?? control.id} failed automated evaluation.`
          : '',
        sourceType: 'powerstig',
        evidence: status !== 'not_a_finding'
          ? null
          : { checkType: control.checkType, evaluatedAt: new Date().toISOString() },
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  // ── Scans ──────────────────────────────────────────────────────────────────
  store.scans = store.machines.map((m: any, idx: number) => ({
    id: uuidv4(),
    machineId: m.id,
    machineName: m.name,
    subscriptionId: m.subscriptionId,
    resourceGroupName: m.resourceGroupName,
    triggeredBy: 'system-scheduler',
    scanType: 'full',
    status: 'completed',
    startedAt: new Date(Date.now() - (idx + 1) * 3600 * 1000).toISOString(),
    completedAt: new Date(Date.now() - (idx + 1) * 3600 * 1000 + 300000).toISOString(),
    totalControls: store.controls.length,
    openFindings: store.findings.filter((f: any) => f.machineId === m.id && f.status === 'open').length,
    compliantControls: store.findings.filter((f: any) => f.machineId === m.id && f.status === 'not_a_finding').length,
  }));

  // ── Checklists ─────────────────────────────────────────────────────────────
  store.checklists = [];

  // ── Audit logs ────────────────────────────────────────────────────────────
  store.auditLogs = [
    { id: uuidv4(), action: 'scan.triggered', actor: 'system', targetId: store.machines[0].id, targetType: 'machine', timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), details: { scanType: 'full' } },
    { id: uuidv4(), action: 'scan.completed', actor: 'system', targetId: store.machines[0].id, targetType: 'machine', timestamp: new Date(Date.now() - 2 * 3600 * 1000 + 300000).toISOString(), details: { scanType: 'full', openFindings: 2 } },
    { id: uuidv4(), action: 'checklist.exported', actor: 'admin@demo.onmicrosoft.com', targetId: store.machines[0].id, targetType: 'machine', timestamp: new Date(Date.now() - 3600 * 1000).toISOString(), details: { format: 'ckl' } },
  ];

  // ── Vulnerabilities (CVE-class data from MDC Servers Plan 2) ──────────────
  const now = new Date().toISOString();
  store.vulnerabilities = [
    { id: uuidv4(), machineId: store.machines[0].id, cve: 'CVE-2024-3094', sourceId: 'sa-xz', title: 'xz-utils backdoor (XZ Utils malicious code)', description: 'Backdoor in upstream xz/liblzma 5.6.0/5.6.1 (CISA KEV).', severity: 'critical', cvssScore: 10.0, exploitAvailable: true, status: 'open', productName: 'xz-utils', productVendor: 'tukaani', productVersion: '5.6.0', remediation: 'Downgrade to xz-utils 5.4.x or apply distro patch.', firstDetectedAt: now, lastDetectedAt: now, createdAt: now, updatedAt: now },
    { id: uuidv4(), machineId: store.machines[1].id, cve: 'CVE-2024-21412', sourceId: 'sa-smartscreen', title: 'Microsoft SmartScreen Bypass', description: 'Internet shortcut SmartScreen security feature bypass.', severity: 'high', cvssScore: 8.1, exploitAvailable: true, status: 'open', productName: 'Windows', productVendor: 'Microsoft', productVersion: '10.0.20348', remediation: 'Apply Feb 2024 cumulative update.', firstDetectedAt: now, lastDetectedAt: now, createdAt: now, updatedAt: now },
    { id: uuidv4(), machineId: store.machines[4].id, cve: 'CVE-2023-44487', sourceId: 'sa-h2-rapid', title: 'HTTP/2 Rapid Reset DoS', description: 'Rapid stream reset DoS in HTTP/2 implementations.', severity: 'high', cvssScore: 7.5, exploitAvailable: true, status: 'open', productName: 'nginx', productVendor: 'F5', productVersion: '1.22.1', remediation: 'Upgrade nginx to >=1.25.3.', firstDetectedAt: now, lastDetectedAt: now, createdAt: now, updatedAt: now },
    { id: uuidv4(), machineId: store.machines[8].id, cve: 'CVE-2024-0204', sourceId: 'sa-goanywhere', title: 'Fortra GoAnywhere MFT auth bypass', description: 'Authentication bypass in Fortra GoAnywhere MFT admin portal.', severity: 'medium', cvssScore: 5.8, exploitAvailable: false, status: 'open', productName: 'GoAnywhere MFT', productVendor: 'Fortra', productVersion: '7.4.0', remediation: 'Upgrade to 7.4.1.', firstDetectedAt: now, lastDetectedAt: now, createdAt: now, updatedAt: now },
    { id: uuidv4(), machineId: store.machines[2].id, cve: 'CVE-2023-23397', sourceId: 'sa-outlook', title: 'Microsoft Outlook EoP', description: 'NTLM relay via crafted appointment in Outlook.', severity: 'high', cvssScore: 9.8, exploitAvailable: true, status: 'mitigated', productName: 'Outlook', productVendor: 'Microsoft', productVersion: '2019', remediation: 'Apply March 2023 cumulative update.', firstDetectedAt: now, lastDetectedAt: now, createdAt: now, updatedAt: now },
  ];
}
