/**
 * PowerSTIG Runner
 *
 * Executes STIG compliance checks on Azure VMs and Arc-connected machines using
 * PowerSTIG DSC configurations delivered via:
 *
 *   - Azure VMs:          Azure VM Run Command (POST .../runCommand)
 *   - Arc-connected:      Azure Arc Run Extension (HybridCompute/machines/.../runCommand)
 *
 * Flow:
 *   1. Generate a PowerSTIG audit script for the target machine's OS/STIG
 *   2. Submit the script via the appropriate Run Command API
 *   3. Poll for completion (async job)
 *   4. Retrieve and return the stdout output (JSON result from PowerSTIG)
 *
 * PowerSTIG must be installed on the target machine.  The installer script
 * in scripts/Install-PowerSTIG.ps1 handles that via DSC bootstrap on first run.
 *
 * Required Azure RBAC on calling identity:
 *   - Microsoft.Compute/virtualMachines/{read,runCommand/action}
 *   - Microsoft.HybridCompute/machines/read and machines/runcommands/{read,write}
 */

import { ComputeManagementClient } from '@azure/arm-compute';
import { HybridComputeManagementClient } from '@azure/arm-hybridcompute';
import { logger } from '../utils/logger';
import { azureCredential } from '../connectors/azureClientOptions';

export interface PowerStigRunOptions {
  machineId: string;
  machineName: string;
  resourceGroupName: string;
  subscriptionId: string;
  benchmarkId: string;   // e.g. "Windows_10_STIG"
  stigVersion: string;   // e.g. "V2R8"
  osType: string;        // "Windows" | "Linux"
  isArcConnected: boolean;
  /** Optional: only check these specific Vuln IDs */
  targetRuleIds?: string[];
}

export interface PowerStigRunResult {
  jobId: string;
  status: 'submitted' | 'running' | 'succeeded' | 'failed' | 'timeout';
  rawOutput?: string;
  error?: string;
  submittedAt: Date;
}

/** Maximum seconds to wait for a Run Command job to complete */
const POLL_TIMEOUT_SEC = 600;
const POLL_INTERVAL_SEC = 15;

const computeClients = new Map<string, ComputeManagementClient>();
const hybridClients = new Map<string, HybridComputeManagementClient>();

function getComputeClient(subId: string): ComputeManagementClient {
  if (!computeClients.has(subId)) {
    computeClients.set(subId, new ComputeManagementClient(azureCredential(), subId));
  }
  return computeClients.get(subId)!;
}

function getHybridClient(subId: string): HybridComputeManagementClient {
  if (!hybridClients.has(subId)) {
    hybridClients.set(subId, new HybridComputeManagementClient(azureCredential(), subId));
  }
  return hybridClients.get(subId)!;
}

/**
 * Submit a PowerSTIG audit run to a machine and wait for results.
 */
export async function runPowerStigAudit(opts: PowerStigRunOptions): Promise<PowerStigRunResult> {
  const submittedAt = new Date();
  const script = buildAuditScript(opts);

  logger.info(`[PowerSTIGRunner] Submitting audit to ${opts.machineName} (${opts.isArcConnected ? 'Arc' : 'VM'})`);

  try {
    if (opts.isArcConnected) {
      return await runArcCommand(opts, script, submittedAt);
    } else {
      return await runVmCommand(opts, script, submittedAt);
    }
  } catch (err: any) {
    logger.error(`[PowerSTIGRunner] Failed for ${opts.machineName}: ${err.message}`);
    return {
      jobId: '',
      status: 'failed',
      error: err.message,
      submittedAt,
    };
  }
}

async function runVmCommand(
  opts: PowerStigRunOptions,
  script: string,
  submittedAt: Date,
): Promise<PowerStigRunResult> {
  const client = getComputeClient(opts.subscriptionId);

  const poller = await client.virtualMachines.beginRunCommand(
    opts.resourceGroupName,
    opts.machineName,
    {
      commandId: 'RunPowerShellScript',
      script: [script],
    },
  );

  const jobId = `vm-runcmd-${opts.machineName}-${Date.now()}`;
  logger.debug(`[PowerSTIGRunner] Run Command submitted for VM ${opts.machineName}, waiting for result`);

  // Poll with timeout
  let elapsed = 0;
  while (!poller.isDone() && elapsed < POLL_TIMEOUT_SEC) {
    await sleep(POLL_INTERVAL_SEC * 1000);
    elapsed += POLL_INTERVAL_SEC;
    await poller.poll();
  }

  if (!poller.isDone()) {
    return { jobId, status: 'timeout', error: 'Run Command timed out', submittedAt };
  }

  const result = poller.getResult();
  const output = result?.value?.[0]?.message || '';
  const exitCode = result?.value?.[1]?.message;

  if (exitCode && exitCode !== '0') {
    return { jobId, status: 'failed', rawOutput: output, error: `Exit code: ${exitCode}`, submittedAt };
  }

  return { jobId, status: 'succeeded', rawOutput: output, submittedAt };
}

async function runArcCommand(
  opts: PowerStigRunOptions,
  script: string,
  submittedAt: Date,
): Promise<PowerStigRunResult> {
  const client = getHybridClient(opts.subscriptionId);

  const poller = await (client.machines as any).beginRunCommand(
    opts.resourceGroupName,
    opts.machineName,
    {
      commandId: 'RunPowerShellScript',
      script: [script],
    } as any,
  );

  const jobId = `arc-runcmd-${opts.machineName}-${Date.now()}`;

  let elapsed = 0;
  while (!poller.isDone() && elapsed < POLL_TIMEOUT_SEC) {
    await sleep(POLL_INTERVAL_SEC * 1000);
    elapsed += POLL_INTERVAL_SEC;
    await poller.poll();
  }

  if (!poller.isDone()) {
    return { jobId, status: 'timeout', error: 'Arc Run Command timed out', submittedAt };
  }

  const result = (poller as any).getResult?.() || {};
  const output = result?.value?.[0]?.message || '';

  return { jobId, status: 'succeeded', rawOutput: output, submittedAt };
}

/**
 * Build the PowerShell script that installs/runs PowerSTIG on the target machine.
 *
 * The script:
 *   1. Ensures PowerSTIG is installed (from PSGallery, with -SkipPublisherCheck).
 *   2. Builds a DSC configuration for the specified STIG.
 *   3. Runs Test-DscConfiguration in audit mode.
 *   4. Outputs results as JSON for the result parser.
 */
/** Quote a string as a PowerShell single-quoted literal (escapes embedded quotes). */
function psSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build the `Where-Object` rule filter. Rule IDs are validated against a strict
 * STIG identifier pattern and quoted as PowerShell literals so a hostile rule ID
 * cannot inject arbitrary commands into the Run Command payload (runs as SYSTEM).
 */
function buildRuleFilter(targetRuleIds?: string[]): string {
  if (!targetRuleIds?.length) return '';
  const valid = targetRuleIds.filter(
    (id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id),
  );
  if (!valid.length) return '';
  const list = valid.map(psSingleQuote).join(',');
  return `$results = $results | Where-Object { $_.RuleId -in @(${list}) }`;
}

type PowerStigBenchmark =
  | { resource: 'WindowsServer'; osVersion: string; osRole: 'MS' | 'DC' }
  | { resource: 'WindowsClient'; osVersion: '10' | '11' };

export function resolvePowerStigBenchmark(benchmarkId: string): PowerStigBenchmark | null {
  const normalized = benchmarkId.toLowerCase().replace(/[_-]+/g, ' ');
  const serverVersion = normalized.match(/windows server (2012 r2|2012|2016|2019|2022)/)?.[1];
  if (!serverVersion || normalized.includes('dns') || normalized.includes('domain name system')) {
    const clientVersion = normalized.match(/windows (10|11)(?:\s|$)/)?.[1] as '10' | '11' | undefined;
    return clientVersion ? { resource: 'WindowsClient', osVersion: clientVersion } : null;
  }

  return {
    resource: 'WindowsServer',
    osVersion: serverVersion.replace(/\s+/g, ''),
    osRole: normalized.includes('domain controller') || /(?:^|\s)dc(?:\s|$)/.test(normalized) ? 'DC' : 'MS',
  };
}

export function isPowerStigVersionSupported(benchmarkId: string, stigVersion: string): boolean {
  const benchmark = resolvePowerStigBenchmark(benchmarkId);
  const normalizedVersion = stigVersion.trim().toUpperCase();
  if (!benchmark || !/^V\d+R\d+$/.test(normalizedVersion)) return false;

  if (benchmark.resource === 'WindowsServer' && benchmark.osVersion === '2022') {
    return normalizedVersion === 'V2R8';
  }

  return true;
}

export function powerStigBenchmarkKey(benchmarkId: string): string | null {
  const benchmark = resolvePowerStigBenchmark(benchmarkId);
  return benchmark ? JSON.stringify(benchmark) : null;
}

function normalizePowerStigVersion(version: string): string {
  const disaVersion = version.match(/^V(\d+)R(\d+)$/i);
  const normalized = disaVersion ? `${disaVersion[1]}.${disaVersion[2]}` : version;
  if (!/^\d+\.\d+$/.test(normalized)) {
    throw new Error(`Invalid PowerSTIG version ${version}`);
  }
  return normalized;
}

export function buildAuditScript(opts: PowerStigRunOptions): string {
  const moduleVersion = '4.30.0';
  const benchmark = resolvePowerStigBenchmark(opts.benchmarkId);
  if (!benchmark) {
    throw new Error(`PowerSTIG does not support benchmark ${opts.benchmarkId}`);
  }

  const stigVersion = normalizePowerStigVersion(opts.stigVersion);
  const resourceParameters = benchmark.resource === 'WindowsServer'
    ? `            OsVersion = ${psSingleQuote(benchmark.osVersion)}\n            OsRole = ${psSingleQuote(benchmark.osRole)}`
    : `            OsVersion = ${psSingleQuote(benchmark.osVersion)}`;
  const ruleFilter = buildRuleFilter(opts.targetRuleIds);

  return `
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

# ── 1. Ensure PowerSTIG is installed ─────────────────────────────────────────
if (-not (Get-Module -ListAvailable -Name PowerSTIG | Where-Object { $_.Version -ge '${moduleVersion}' })) {
    Write-Host "Installing PowerSTIG ${moduleVersion}..."
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    Install-Module -Name PowerSTIG -RequiredVersion ${moduleVersion} -Force -SkipPublisherCheck -Scope AllUsers
}
Import-Module PowerSTIG -RequiredVersion ${moduleVersion} -Force

# ── 2. Compile an audit-only DSC reference configuration ──────────────────────
$configurationSource = @'
configuration StigTrackerAudit {
  Import-DscResource -ModuleName @{ModuleName='PowerSTIG'; RequiredVersion='${moduleVersion}'}
  Node localhost {
    ${benchmark.resource} Baseline {
${resourceParameters}
      StigVersion = ${psSingleQuote(stigVersion)}
    }
  }
}
'@
Invoke-Expression $configurationSource

$auditPath = Join-Path $env:TEMP ('stig-tracker-' + [guid]::NewGuid().ToString('N'))
StigTrackerAudit -OutputPath $auditPath | Out-Null
$null = Test-DscConfiguration -ReferenceConfiguration (Join-Path $auditPath 'localhost.mof')
$audit = Get-DscConfigurationStatus -All |
  Sort-Object StartDate -Descending |
  Select-Object -First 1

# ── 3. Translate DSC resource state into rule results ─────────────────────────
$results = @()
foreach ($resource in @($audit.ResourcesInDesiredState)) {
  $ruleId = [regex]::Match($resource.ResourceId, 'V-\\d+').Value
  if (-not $ruleId) { continue }
  $results += [pscustomobject]@{
    RuleId = $ruleId
    CheckType = [regex]::Match($resource.ResourceId, '^\\[([^]]+)\\]').Groups[1].Value
    Result = 'Pass'
    Reason = 'Configuration matches STIG requirement'
    Properties = @{ ResourceId = $resource.ResourceId }
    }
}
foreach ($resource in @($audit.ResourcesNotInDesiredState)) {
  $ruleId = [regex]::Match($resource.ResourceId, 'V-\\d+').Value
  if (-not $ruleId) { continue }
  $results += [pscustomobject]@{
    RuleId = $ruleId
    CheckType = [regex]::Match($resource.ResourceId, '^\\[([^]]+)\\]').Groups[1].Value
    Result = 'Fail'
    Reason = 'Configuration does not match STIG requirement'
    Properties = @{ ResourceId = $resource.ResourceId }
    }
}
${ruleFilter}

# ── 4. Output JSON ────────────────────────────────────────────────────────────
$output = [pscustomobject]@{
    Machine    = $env:COMPUTERNAME
  StigId     = ${psSingleQuote(opts.benchmarkId)}
  Version    = ${psSingleQuote(opts.stigVersion)}
    CheckedAt  = (Get-Date -Format 'o')
    Results    = $results
}

$null = Remove-Item -Path $auditPath -Recurse -Force -ErrorAction SilentlyContinue
$json = $output | ConvertTo-Json -Depth 10 -Compress
$jsonBytes = [Text.Encoding]::UTF8.GetBytes($json)
$compressed = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GZipStream($compressed, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($jsonBytes, 0, $jsonBytes.Length)
$gzip.Dispose()
'STIG_GZIP_BASE64:' + [Convert]::ToBase64String($compressed.ToArray())
$compressed.Dispose()
`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
