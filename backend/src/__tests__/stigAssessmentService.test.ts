import { benchmarkAppliesToMachine, isOperatingSystemBenchmark } from '../services/stigAssessmentService';

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
});