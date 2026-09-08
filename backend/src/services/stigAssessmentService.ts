import { DataSource } from 'typeorm';
import { MachineEntity } from '../models/Machine';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import { StigVersionEntity } from '../models/StigVersion';
import { ScanEntity } from '../models/Scan';
import { FindingEntity } from '../models/Finding';
import { runPowerStigAudit } from '../scanning/powerStigRunner';
import { parseStigResults } from '../scanning/dscResultParser';
import { runOpenScapScan } from '../scanning/openScapRunner';
import { logger } from '../utils/logger';

export interface ApplicableStig {
  benchmark: StigBenchmarkEntity;
  version: StigVersionEntity;
}

export interface AssessmentSummary {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
}

function descriptor(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[_-]+/g, ' ');
}

function hasAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

export function isOperatingSystemBenchmark(benchmark: Pick<StigBenchmarkEntity, 'benchmarkId' | 'title' | 'category'>): boolean {
  const category = descriptor(benchmark.category);
  const identity = descriptor(`${benchmark.benchmarkId} ${benchmark.title}`);
  return category === 'operating system' || category === 'os' || hasAny(identity, [
    'windows 10', 'windows 11', 'windows server', 'ubuntu', 'red hat enterprise linux',
    'rhel', 'centos', 'suse linux',
  ]);
}

export function benchmarkAppliesToMachine(
  machine: Pick<MachineEntity, 'osType' | 'osVersion' | 'isArcConnected'>,
  benchmark: Pick<StigBenchmarkEntity, 'benchmarkId' | 'title' | 'category' | 'platform'>,
): boolean {
  if (!isOperatingSystemBenchmark(benchmark)) return false;

  const machineOs = descriptor(`${machine.osType} ${machine.osVersion ?? ''}`);
  const benchmarkOs = descriptor(`${benchmark.benchmarkId} ${benchmark.title} ${benchmark.platform ?? ''}`);
  const machineIsWindows = machineOs.includes('windows');
  const benchmarkIsWindows = benchmarkOs.includes('windows');
  const machineIsLinux = hasAny(machineOs, ['linux', 'ubuntu', 'rhel', 'red hat', 'centos', 'suse']);
  const benchmarkIsLinux = hasAny(benchmarkOs, ['linux', 'ubuntu', 'rhel', 'red hat', 'centos', 'suse']);

  if (benchmarkIsWindows !== machineIsWindows || benchmarkIsLinux !== machineIsLinux) return false;
  if (!machineIsWindows && !machineIsLinux) return false;

  if (machineIsWindows) {
    const machineIsServer = machineOs.includes('server') || /(?:^|\s)20(?:12|16|19|22|25)(?:\s|$)/.test(machineOs);
    const benchmarkIsServer = benchmarkOs.includes('server');
    if (machineIsServer !== benchmarkIsServer) return false;
  }

  if (machineIsWindows) {
    const releases = ['10', '11', '2012', '2016', '2019', '2022', '2025'];
    const benchmarkRelease = releases.find((release) =>
      new RegExp(`(?:^|\\s)${release}(?:\\s|$)`).test(benchmarkOs),
    );
    if (benchmarkRelease && !new RegExp(`(?:^|\\s)${benchmarkRelease}(?:\\s|$)`).test(machineOs)) {
      return false;
    }
  }

  const distros = [
    ['ubuntu', ['ubuntu']],
    ['rhel', ['rhel', 'red hat']],
    ['centos', ['centos']],
    ['suse', ['suse']],
  ] as const;
  const benchmarkDistro = distros.find(([, aliases]) => hasAny(benchmarkOs, [...aliases]));
  if (benchmarkDistro && !hasAny(machineOs, [...benchmarkDistro[1]])) return false;
  if (benchmarkDistro) {
    const distroPattern = benchmarkDistro[1].map((alias) => alias.replace(' ', '\\s+')).join('|');
    const benchmarkRelease = benchmarkOs.match(new RegExp(`(?:${distroPattern})\\s+(\\d{1,2})`))?.[1];
    const machineRelease = machineOs.match(new RegExp(`(?:${distroPattern})\\s+(\\d{1,2})`))?.[1];
    if (benchmarkRelease && machineRelease !== benchmarkRelease) return false;
  }

  // The current OpenSCAP runner executes through Azure Arc Run Command.
  if (machineIsLinux && !machine.isArcConnected) return false;
  return true;
}

export async function resolveApplicableStigs(
  dataSource: DataSource,
  machine: MachineEntity,
  benchmarkId?: string,
  versionName?: string,
): Promise<ApplicableStig[]> {
  const benchmarks = await dataSource.getRepository(StigBenchmarkEntity).find({
    where: { active: true },
    relations: ['versions'],
  });

  return benchmarks.flatMap((benchmark) => {
    if (benchmarkId && benchmark.benchmarkId !== benchmarkId) return [];
    if (!benchmarkAppliesToMachine(machine, benchmark)) return [];
    const version = benchmark.versions
      .filter((candidate) => versionName ? candidate.version === versionName : candidate.status === 'active')
      .sort((left, right) => right.importedAt.getTime() - left.importedAt.getTime())[0];
    return version ? [{ benchmark, version }] : [];
  });
}

async function updateMachineCompliance(dataSource: DataSource, machine: MachineEntity): Promise<void> {
  const findings = await dataSource.getRepository(FindingEntity).find({ where: { machineId: machine.id } });
  const applicable = findings.filter((finding) => finding.status !== 'not_applicable');
  const passing = findings.filter((finding) => finding.status === 'not_a_finding');
  machine.complianceScore = applicable.length ? Math.round((passing.length / applicable.length) * 100) : 0;
  machine.lastScanDate = new Date();
  await dataSource.getRepository(MachineEntity).save(machine);
}

async function assessMachineStig(
  dataSource: DataSource,
  machine: MachineEntity,
  applicable: ApplicableStig,
): Promise<void> {
  const { benchmark, version } = applicable;
  const scanRepo = dataSource.getRepository(ScanEntity);
  const scan = await scanRepo.save(scanRepo.create({
    machineId: machine.id,
    machineName: machine.name,
    subscriptionId: machine.subscriptionId,
    resourceGroupName: machine.resourceGroupName,
    triggeredBy: 'comprehensive-scan',
    scanType: 'stig-assessment',
    status: 'running',
    startedAt: new Date(),
  }));

  try {
    const machineOs = descriptor(`${machine.osType} ${machine.osVersion ?? ''}`);
    if (machineOs.includes('windows')) {
      const result = await runPowerStigAudit({
        machineId: machine.id,
        machineName: machine.name,
        resourceGroupName: machine.resourceGroupName,
        subscriptionId: machine.subscriptionId,
        benchmarkId: benchmark.benchmarkId,
        stigVersion: version.version,
        osType: machine.osType,
        isArcConnected: machine.isArcConnected,
      });
      if (result.status !== 'succeeded' || !result.rawOutput) {
        throw new Error(result.error || `PowerSTIG assessment ${result.status}`);
      }
      const parsed = await parseStigResults({
        rawOutput: result.rawOutput,
        machineId: machine.id,
        stigVersionId: version.id,
        runCommandJobId: result.jobId,
      }, dataSource);
      scan.totalControls = parsed.rulesProcessed;
      scan.openFindings = parsed.failCount;
      scan.compliantControls = parsed.passCount;
    } else {
      if (!benchmark.sourceUrl) throw new Error('Linux STIG has no benchmark content URL');
      await runOpenScapScan(machine, scan, {
        benchmarkXccdfUrl: benchmark.sourceUrl,
        profileName: 'xccdf_mil.disa.stig_profile_CAT_I_II_III',
        dataStream: benchmark.benchmarkId,
      }, dataSource);
    }
    scan.status = 'completed';
  } catch (error: any) {
    scan.status = 'failed';
    scan.errorMessage = String(error?.message ?? error).slice(0, 2000);
    throw error;
  } finally {
    scan.completedAt = new Date();
    await scanRepo.save(scan);
    await updateMachineCompliance(dataSource, machine);
  }
}

export async function assessApplicableStigs(
  dataSource: DataSource,
  machines: MachineEntity[],
  benchmarkId?: string,
  versionName?: string,
): Promise<AssessmentSummary> {
  const summary: AssessmentSummary = { attempted: 0, completed: 0, failed: 0, skipped: 0 };
  for (const machine of machines) {
    const applicableStigs = await resolveApplicableStigs(dataSource, machine, benchmarkId, versionName);
    if (machine.status === 'offline') {
      summary.skipped += applicableStigs.length;
      continue;
    }
    for (const applicable of applicableStigs) {
      summary.attempted++;
      try {
        await assessMachineStig(dataSource, machine, applicable);
        summary.completed++;
      } catch (error: any) {
        summary.failed++;
        logger.error(
          `[STIGAssessment] ${machine.name}/${applicable.benchmark.benchmarkId} failed: ${error?.message ?? error}`,
        );
      }
    }
  }
  return summary;
}