import { benchmarkAppliesToMachine, isOperatingSystemBenchmark } from '../services/stigAssessmentService';
import {
  buildAuditScript,
  isPowerStigVersionSupported,
  powerStigBenchmarkKey,
  resolvePowerStigBenchmark,
} from '../scanning/powerStigRunner';

const machine = (osVersion: string, isArcConnected = false) => ({
  osType: osVersion.includes('Ubuntu') ? 'Linux' : 'Windows',
  osVersion,
  isArcConnected,
});

const benchmark = (benchmarkId: string, title: string, category = 'Operating System', platform = 'Windows') => ({
  benchmarkId, title, category, platform,
});

describe('STIG applicability', () => {
  it('matches Windows Server 2022 only to Server 2022', () => {
    const server2022 = benchmark('Windows_Server_2022_STIG', 'Microsoft Windows Server 2022 STIG');
    expect(benchmarkAppliesToMachine(machine('Windows Server 2022 Datacenter'), server2022)).toBe(true);
    expect(benchmarkAppliesToMachine(machine('2022-datacenter-azure-edition'), server2022)).toBe(true);
    expect(benchmarkAppliesToMachine(machine('Windows Server 2019 Datacenter'), server2022)).toBe(false);
    expect(benchmarkAppliesToMachine(machine('Windows 10 Enterprise'), server2022)).toBe(false);
  });

  it('does not infer application STIG applicability from the operating system', () => {
    const edge = benchmark('MS_Edge_STIG', 'Microsoft Edge STIG', 'Browser');
    expect(isOperatingSystemBenchmark(edge)).toBe(false);
    expect(benchmarkAppliesToMachine(machine('Windows Server 2022 Datacenter'), edge)).toBe(false);
  });

  it('matches an Arc Ubuntu host to the same Ubuntu release', () => {
    const ubuntu22 = benchmark('Ubuntu_22_STIG', 'Canonical Ubuntu 22.04 LTS STIG', 'Operating System', 'Linux');
    expect(benchmarkAppliesToMachine(machine('Ubuntu 22.04 LTS', true), ubuntu22)).toBe(true);
    expect(benchmarkAppliesToMachine(machine('Ubuntu 24.04 LTS', true), ubuntu22)).toBe(false);
    expect(benchmarkAppliesToMachine(machine('Ubuntu 22.04 LTS', false), ubuntu22)).toBe(false);
  });

  it('rejects Windows benchmarks that PowerSTIG cannot audit', () => {
    const apache = benchmark('Apache_Server_2-4_Windows_Server_STIG', 'Apache Server 2.4 Windows STIG');
    const dns = benchmark('MS_Windows_Server_2022_DNS_STIG', 'Windows Server 2022 DNS STIG');

    expect(benchmarkAppliesToMachine(machine('Windows Server 2022 Datacenter'), apache)).toBe(false);
    expect(benchmarkAppliesToMachine(machine('Windows Server 2022 Datacenter'), dns)).toBe(false);
  });
});

describe('PowerSTIG audit script', () => {
  it('maps server benchmarks to supported PowerSTIG parameters', () => {
    expect(resolvePowerStigBenchmark('MS_Windows_Server_2022_STIG')).toEqual({
      resource: 'WindowsServer',
      osVersion: '2022',
      osRole: 'MS',
    });
    expect(resolvePowerStigBenchmark('MS_Windows_Server_2022_DNS_STIG')).toBeNull();
    expect(isPowerStigVersionSupported('MS_Windows_Server_2022_STIG', 'V2R8')).toBe(true);
    expect(isPowerStigVersionSupported('MS_Windows_Server_2022_STIG', 'V2R10')).toBe(false);
    expect(powerStigBenchmarkKey('MS_Windows_Server_2022_STIG')).toBe(
      powerStigBenchmarkKey('Windows_Server_2022_STIG'),
    );
    expect(resolvePowerStigBenchmark('Apache_Server_2-4_Windows_Server_STIG')).toBeNull();
  });

  it('generates a DSC reference audit without direct PowerShell class usage', () => {
    const script = buildAuditScript({
      machineId: 'machine-id',
      machineName: 'server-01',
      resourceGroupName: 'rg',
      subscriptionId: 'subscription-id',
      benchmarkId: 'MS_Windows_Server_2022_STIG',
      stigVersion: 'V2R8',
      osType: 'Windows',
      isArcConnected: false,
      targetRuleIds: ['V-254253'],
    });

    expect(script).toContain('configuration StigTrackerAudit');
    expect(script).toContain('Import-Module PowerSTIG -RequiredVersion 4.30.0');
    expect(script).toContain("Import-DscResource -ModuleName @{ModuleName='PowerSTIG'; RequiredVersion='4.30.0'}");
    expect(script).toContain('Invoke-Expression $configurationSource');
    expect(script).toContain('$audit = Get-DscConfigurationStatus -All');
    expect(script).toContain('Sort-Object StartDate -Descending');
    expect(script).toContain("OsVersion = '2022'");
    expect(script).toContain("OsRole = 'MS'");
    expect(script).toContain("StigVersion = '2.8'");
    expect(script).toContain("$results = $results | Where-Object { $_.RuleId -in @('V-254253') }");
    expect(script).not.toContain('[STIG]::');
    expect(script).not.toContain('Get-DscResourceFromStig');
  });

  it('rejects malformed versions before generating PowerShell', () => {
    expect(() => buildAuditScript({
      machineId: 'machine-id',
      machineName: 'server-01',
      resourceGroupName: 'rg',
      subscriptionId: 'subscription-id',
      benchmarkId: 'MS_Windows_Server_2022_STIG',
      stigVersion: "2.8'@; Write-Host injected",
      osType: 'Windows',
      isArcConnected: false,
    })).toThrow('Invalid PowerSTIG version');
  });
});