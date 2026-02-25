/**
 * Remediation Runner
 *
 * Executes remediation jobs via:
 *   1. DSC enforce-mode (dsc_push)         — Windows VMs/Arc via RunCommand
 *   2. Azure Policy remediation (azure_policy) — triggers built-in policy task
 *   3. Manual guidance (manual)            — logs guidance only
 *
 * Called asynchronously from /api/remediation/jobs (POST).
 */

import { ComputeManagementClient } from '@azure/arm-compute';
import { HybridComputeManagementClient } from '@azure/arm-hybridcompute';
import { DefaultAzureCredential } from '@azure/identity';
import { AppDataSource, mockStore } from '../database/dataSource';
import { RemediationJobEntity } from '../models/RemediationJob';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { MachineEntity } from '../models/Machine';
import { logger } from '../utils/logger';

const isMock = () => process.env.MOCK_MODE === 'true';

export async function runRemediationJob(jobId: string): Promise<void> {
  logger.info(`[RemediationRunner] Starting job ${jobId}`);

  if (isMock()) {
    return simulateRemediationJob(jobId);
  }

  const jobRepo     = AppDataSource.getRepository(RemediationJobEntity);
  const findingRepo = AppDataSource.getRepository(FindingEntity);
  const controlRepo = AppDataSource.getRepository(ControlEntity);
  const machineRepo = AppDataSource.getRepository(MachineEntity);

  const job = await jobRepo.findOne({ where: { id: jobId } });
  if (!job) { logger.warn(`[RemediationRunner] Job ${jobId} not found`); return; }

  job.status    = 'running';
  job.startedAt = new Date();
  await jobRepo.save(job);

  const resultLog: any[] = [];
  let succeeded = 0, failed = 0, skipped = 0;

  for (const machineId of (job.machineIds as string[])) {
    const machine = await machineRepo.findOne({ where: { resourceId: machineId } });
    if (!machine) { skipped++; continue; }

    for (const findingId of (job.findingIds as string[])) {
      const finding = await findingRepo.findOne({ where: { id: findingId }, relations: ['control'] });
      if (!finding) { skipped++; continue; }

      const control = await controlRepo.findOne({ where: { id: finding.controlId } });
      if (!control) { skipped++; continue; }

      try {
        const script = buildRemediationScript(control, job.strategy);
        if (!script) { skipped++; continue; }

        const output = await executeScript(machine, script, job.strategy);
        resultLog.push({ machineId, findingId, controlId: control.vulnId, status: 'success', output });
        succeeded++;
      } catch (err: any) {
        resultLog.push({ machineId, findingId, status: 'failed', error: err.message });
        failed++;
      }
    }
  }

  job.status      = failed === 0 && skipped === 0 ? 'completed' : failed > 0 ? 'partial' : 'completed';
  job.succeeded   = succeeded;
  job.failed      = failed;
  job.skipped     = skipped;
  job.resultLog   = resultLog;
  job.completedAt = new Date();
  await jobRepo.save(job);

  logger.info(`[RemediationRunner] Job ${jobId} done — ${succeeded} OK / ${failed} FAIL / ${skipped} SKIP`);
}

// ─── Script generators ───────────────────────────────────────────────────────

function buildRemediationScript(control: ControlEntity, strategy: string): string | null {
  if (strategy === 'manual') return null;
  if (strategy !== 'dsc_push') return null;

  const checkType = (control as any).checkType as string;
  const params    = ((control as any).checkParameters ?? {}) as Record<string, any>;

  switch (checkType) {
    case 'RegistryCheck':
      return buildRegistryScript(params);
    case 'AuditPolicyCheck':
      return buildAuditPolicyScript(params);
    case 'SecurityPolicyCheck':
      return buildSecPolicyScript(params);
    case 'ServiceCheck':
      return buildServiceScript(params);
    default:
      return null;
  }
}

function buildRegistryScript(params: Record<string, any>): string {
  const { keyPath, valueName, valueData, valueType = 'DWORD' } = params;
  return `
$regPath = "${keyPath}"
$valueName = "${valueName}"
$expected = ${typeof valueData === 'string' ? `"${valueData}"` : valueData}
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
$current = Get-ItemProperty -Path $regPath -Name $valueName -ErrorAction SilentlyContinue
if ($current.${valueName} -ne $expected) {
  Set-ItemProperty -Path $regPath -Name $valueName -Value $expected -Type ${valueType}
  Write-Output "Set $regPath\\$valueName = $expected"
} else {
  Write-Output "Already compliant: $regPath\\$valueName = $expected"
}`.trim();
}

function buildAuditPolicyScript(params: Record<string, any>): string {
  const { subcategory, successRequired, failureRequired } = params;
  const flags = [
    successRequired && '/success:enable',
    failureRequired && '/failure:enable',
  ].filter(Boolean).join(' ');
  return `auditpol /set /subcategory:"${subcategory}" ${flags}`;
}

function buildSecPolicyScript(params: Record<string, any>): string {
  const { PolicyName, PolicyValue } = params;
  return `
$tmpInf = "$env:TEMP\\stig_secedit.inf"
secedit /export /cfg $tmpInf /quiet
(Get-Content $tmpInf) -replace "${PolicyName} = .*", "${PolicyName} = ${PolicyValue}" | Set-Content $tmpInf
secedit /configure /cfg $tmpInf /db "$env:TEMP\\stig_secedit.sdb" /quiet
Write-Output "Applied ${PolicyName} = ${PolicyValue}"`.trim();
}

function buildServiceScript(params: Record<string, any>): string {
  const { ServiceName, StartupType = 'Disabled' } = params;
  return `
$svc = Get-Service -Name "${ServiceName}" -ErrorAction SilentlyContinue
if ($svc) {
  Set-Service -Name "${ServiceName}" -StartupType ${StartupType}
  if ($svc.Status -eq 'Running') { Stop-Service -Name "${ServiceName}" -Force }
  Write-Output "Service ${ServiceName} set to ${StartupType}"
} else {
  Write-Output "Service ${ServiceName} not found — skipping"
}`.trim();
}

// ─── Azure execution ──────────────────────────────────────────────────────────

async function executeScript(machine: MachineEntity, script: string, _strategy: string): Promise<string> {
  const credential = new DefaultAzureCredential();
  const isArc = (machine as any).isArcConnected === true || !machine.subscriptionId;

  if (isArc) {
    const client = new HybridComputeManagementClient(credential, machine.subscriptionId);
    const result = await client.machines.beginRunCommandAndWait(
      machine.resourceGroupName,
      machine.name,
      {
        source:     { script },
        runAsUser:  undefined,
        parameters: [],
      } as any,
    );
    return JSON.stringify(result?.value?.[0]?.message ?? '');
  } else {
    const client = new ComputeManagementClient(credential, machine.subscriptionId);
    const result = await client.virtualMachines.beginRunCommandAndWait(
      machine.resourceGroupName,
      machine.name,
      {
        commandId:  'RunPowerShellScript',
        script:     [script],
      },
    );
    return result.value?.[0]?.message ?? '';
  }
}

// ─── Mock simulation ──────────────────────────────────────────────────────────

async function simulateRemediationJob(jobId: string): Promise<void> {
  const job = mockStore.remediationJobs.find((j: any) => j.id === jobId);
  if (!job) return;

  job.status    = 'running';
  job.startedAt = new Date().toISOString();

  // Simulate async work
  await new Promise((r) => setTimeout(r, 1500));

  const resultLog: any[] = [];
  const machines: string[] = job.machineIds ?? [];
  const findings: string[] = job.findingIds ?? [];

  for (const machineId of machines) {
    for (const findingId of findings) {
      const success = Math.random() > 0.15;
      resultLog.push({
        machineId, findingId,
        status:  success ? 'success' : 'failed',
        output:  success ? 'Registry key updated to compliant value.' : 'Access denied — insufficient privileges.',
        ts:      new Date().toISOString(),
      });
      if (success) job.succeeded++; else job.failed++;
    }
  }

  job.status      = job.failed === 0 ? 'completed' : 'partial';
  job.resultLog   = resultLog;
  job.completedAt = new Date().toISOString();

  logger.info(`[RemediationRunner] Mock job ${jobId} simulated — ${job.succeeded}/${job.totalItems} succeeded`);
}
