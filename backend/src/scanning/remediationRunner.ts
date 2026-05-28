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
  if (job.approvalRequired && !job.approved) {
    logger.warn(`[RemediationRunner] Job ${jobId} is not approved; skipping execution`);
    return;
  }
  if (job.status !== 'pending') {
    logger.warn(`[RemediationRunner] Job ${jobId} is in status=${job.status}; expected pending`);
    return;
  }

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

// ─── Input hardening ──────────────────────────────────────────────────────────
// checkParameters originates from imported STIG content. Even though imports are
// gated to admin/operator, these values are interpolated into PowerShell that
// runs as SYSTEM on every managed machine, so we treat them as untrusted:
// validate against strict allowlists and emit only single-quoted literals
// (which suppress PowerShell variable/subexpression expansion).

/** Quote an arbitrary string as a PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Throw unless `value` is a non-empty string matching `pattern`. */
function requireMatch(name: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || !pattern.test(value)) {
    throw new Error(`Remediation: invalid ${name} (must match ${pattern})`);
  }
  return value;
}

/** Throw unless `value` is one of the allowed tokens (case-insensitive). */
function requireEnum(name: string, value: unknown, allowed: string[], fallback?: string): string {
  const v = value === undefined || value === null ? fallback : String(value);
  const match = v !== undefined && allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (!match) {
    throw new Error(`Remediation: invalid ${name} "${String(value)}" (allowed: ${allowed.join(', ')})`);
  }
  return match;
}

// Registry path: drive-qualified hive path, e.g. HKLM:\SOFTWARE\... — letters,
// digits, spaces, and common punctuation only; no quotes, $, ;, |, &, backtick.
const REGISTRY_PATH = /^[A-Za-z]+:\\[A-Za-z0-9 _.\-\\(){}]+$/;
const REGISTRY_VALUE_NAME = /^[A-Za-z0-9 _.\-()]+$/;
const REGISTRY_TYPES = ['String', 'ExpandString', 'Binary', 'DWord', 'MultiString', 'QWord', 'None'];
const SERVICE_NAME = /^[A-Za-z0-9 _.\-()]+$/;
const SERVICE_STARTUP = ['Automatic', 'Manual', 'Disabled'];
const AUDIT_SUBCATEGORY = /^[A-Za-z0-9 \-/]+$/;
const SECEDIT_POLICY_NAME = /^[A-Za-z0-9_]+$/;
const SECEDIT_POLICY_VALUE = /^[A-Za-z0-9_,"\-. ]+$/;

function buildRegistryScript(params: Record<string, any>): string {
  const keyPath   = requireMatch('keyPath', params.keyPath, REGISTRY_PATH);
  const valueName = requireMatch('valueName', params.valueName, REGISTRY_VALUE_NAME);
  const valueType = requireEnum('valueType', params.valueType, REGISTRY_TYPES, 'DWord');

  // valueData may be a string or a finite number; everything else is rejected.
  let expectedExpr: string;
  if (typeof params.valueData === 'number' && Number.isFinite(params.valueData)) {
    expectedExpr = String(params.valueData);
  } else if (typeof params.valueData === 'string') {
    expectedExpr = psLiteral(params.valueData);
  } else {
    throw new Error('Remediation: invalid valueData (must be a string or finite number)');
  }

  return `
$regPath = ${psLiteral(keyPath)}
$valueName = ${psLiteral(valueName)}
$expected = ${expectedExpr}
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
$current = Get-ItemProperty -Path $regPath -Name $valueName -ErrorAction SilentlyContinue
if ($current.$valueName -ne $expected) {
  Set-ItemProperty -Path $regPath -Name $valueName -Value $expected -Type ${valueType}
  Write-Output "Set $regPath\\$valueName = $expected"
} else {
  Write-Output "Already compliant: $regPath\\$valueName = $expected"
}`.trim();
}

function buildAuditPolicyScript(params: Record<string, any>): string {
  const subcategory = requireMatch('subcategory', params.subcategory, AUDIT_SUBCATEGORY);
  const flags = [
    params.successRequired && '/success:enable',
    params.failureRequired && '/failure:enable',
  ].filter(Boolean).join(' ');
  return `auditpol /set /subcategory:${psLiteral(subcategory)} ${flags}`;
}

function buildSecPolicyScript(params: Record<string, any>): string {
  const policyName  = requireMatch('PolicyName', params.PolicyName, SECEDIT_POLICY_NAME);
  const policyValue = requireMatch('PolicyValue', params.PolicyValue, SECEDIT_POLICY_VALUE);
  return `
$tmpInf = "$env:TEMP\\stig_secedit.inf"
secedit /export /cfg $tmpInf /quiet
$policyName = ${psLiteral(policyName)}
$policyValue = ${psLiteral(policyValue)}
(Get-Content $tmpInf) -replace ("^" + [regex]::Escape($policyName) + " = .*"), "$policyName = $policyValue" | Set-Content $tmpInf
secedit /configure /cfg $tmpInf /db "$env:TEMP\\stig_secedit.sdb" /quiet
Write-Output "Applied $policyName = $policyValue"`.trim();
}

function buildServiceScript(params: Record<string, any>): string {
  const serviceName = requireMatch('ServiceName', params.ServiceName, SERVICE_NAME);
  const startupType = requireEnum('StartupType', params.StartupType, SERVICE_STARTUP, 'Disabled');
  return `
$svc = Get-Service -Name ${psLiteral(serviceName)} -ErrorAction SilentlyContinue
if ($svc) {
  Set-Service -Name ${psLiteral(serviceName)} -StartupType ${startupType}
  if ($svc.Status -eq 'Running') { Stop-Service -Name ${psLiteral(serviceName)} -Force }
  Write-Output "Service $($svc.Name) set to ${startupType}"
} else {
  Write-Output "Service not found — skipping"
}`.trim();
}

// ─── Azure execution ──────────────────────────────────────────────────────────

async function executeScript(machine: MachineEntity, script: string, _strategy: string): Promise<string> {
  const credential = new DefaultAzureCredential();
  const isArc = (machine as any).isArcConnected === true || !machine.subscriptionId;

  if (isArc) {
    const client = new HybridComputeManagementClient(credential, machine.subscriptionId);
    const result = await (client.machines as any).beginRunCommandAndWait(
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
