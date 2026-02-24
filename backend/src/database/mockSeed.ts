/**
 * Mock seed data used when MOCK_MODE=true.
 * This populates the in-memory store so the app works without a real DB or Azure subscription.
 */

import { v4 as uuidv4 } from 'uuid';

export function seedMock(store: any): void {
  // ── Controls (STIG rules) ──────────────────────────────────────────────────
  store.controls = [
    {
      id: 'V-220700',
      stigId: 'WN10-AU-000005',
      title: 'Windows 10 must be configured to audit Account Logon Logoff - Logon failures.',
      severity: 'medium',
      description: 'Maintaining an audit trail of system activity logs can help identify configuration errors, troubleshoot service disruptions, and analyze compromises that have occurred, as well as detect attacks.',
      checkContent: 'Security Option "Audit: Force audit policy subcategory settings (Windows Vista or later) to override audit policy category settings" must be set to "Enabled".',
      fixText: 'Configure the policy value for Computer Configuration >> Windows Settings >> Security Settings >> Advanced Audit Policy Configuration >> System Audit Policies >> Logon/Logoff >> Audit Logon to include "Failure".',
      azurePolicyId: '/providers/Microsoft.Authorization/policyDefinitions/audit-vm-logon',
      defenderRuleId: 'MDFC-001',
    },
    {
      id: 'V-220701',
      stigId: 'WN10-AC-000005',
      title: 'The built-in administrator account must be disabled.',
      severity: 'high',
      description: 'Windows 10 contains a built-in administrator account that, unlike domain accounts, cannot be locked out. An adversary could use this to brute force access to the system.',
      checkContent: 'Open "Computer Management". Navigate to Local Users and Groups >> Users. Double-click on built-in "Administrator" account. Verify "Account is disabled" is checked.',
      fixText: 'Configure the policy value for Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> Security Options >> "Accounts: Administrator account status" to "Disabled".',
      azurePolicyId: '/providers/Microsoft.Authorization/policyDefinitions/disable-builtin-admin',
      defenderRuleId: 'MDFC-002',
    },
    {
      id: 'V-220702',
      stigId: 'WN10-CC-000010',
      title: 'Camera access from the lock screen must be disabled.',
      severity: 'medium',
      description: 'Enabling camera access from the lock screen could allow for unauthorized data collection.',
      checkContent: 'If the registry value does not exist or is not configured as specified, this is a finding. HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization NoLockScreenCamera = 1',
      fixText: 'Configure Computer Configuration >> Administrative Templates >> Control Panel >> Personalization >> "Prevent enabling lock screen camera" to "Enabled".',
      azurePolicyId: '/providers/Microsoft.Authorization/policyDefinitions/camera-lock-screen',
      defenderRuleId: null,
    },
    {
      id: 'V-220703',
      stigId: 'WN10-SO-000030',
      title: 'Anonymous enumeration of SAM accounts must not be allowed.',
      severity: 'high',
      description: 'Anonymous enumeration of SAM accounts allows anonymous logon users to list all accounts names, thus providing a list of potential points to attack.',
      checkContent: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\RestrictAnonymousSAM = 1',
      fixText: 'Configure the policy value for Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> Security Options >> "Network access: Do not allow anonymous enumeration of SAM accounts" to "Enabled".',
      azurePolicyId: '/providers/Microsoft.Authorization/policyDefinitions/restrict-anon-sam',
      defenderRuleId: 'MDFC-004',
    },
    {
      id: 'V-220704',
      stigId: 'WN10-CC-000052',
      title: 'Windows 10 must be configured to prevent users from receiving suggestions for third-party or additional applications.',
      severity: 'low',
      description: 'Should third-party applications be installed without the knowledge of the system administrators or not meet the organization software standards, this could create a vulnerability on the system.',
      checkContent: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager DisableWindowsConsumerFeatures = 1',
      fixText: 'Configure the policy value for Computer Configuration >> Administrative Templates >> Windows Components >> Cloud Content >> "Turn off Microsoft consumer experiences" to "Enabled".',
      azurePolicyId: null,
      defenderRuleId: null,
    },
  ];

  // ── Machines ───────────────────────────────────────────────────────────────
  store.machines = [
    {
      id: 'machine-001',
      name: 'WIN10-WORKSTATION-01',
      resourceId: '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/WIN10-WORKSTATION-01',
      subscriptionId: '00000000-0000-0000-0000-000000000001',
      subscriptionName: 'Demo Subscription',
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
      subscriptionId: '00000000-0000-0000-0000-000000000001',
      subscriptionName: 'Demo Subscription',
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
      subscriptionId: '00000000-0000-0000-0000-000000000001',
      subscriptionName: 'Demo Subscription',
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
      subscriptionId: '00000000-0000-0000-0000-000000000001',
      subscriptionName: 'Demo Subscription',
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
        controlId: control.id,
        status,
        severity: control.severity,
        comments: status === 'not_a_finding'
          ? 'Verified compliant via automated check.'
          : status === 'open'
          ? 'Finding confirmed — remediation required.'
          : '',
        findingDetails: status === 'open'
          ? `Control ${control.stigId} failed automated evaluation. Azure Policy reported non-compliant state.`
          : '',
        sourceType: 'azure-policy',
        evidence: status !== 'not_a_finding'
          ? null
          : { policyState: 'Compliant', evaluatedAt: new Date().toISOString() },
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
}
