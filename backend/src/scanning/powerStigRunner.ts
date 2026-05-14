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
 *   - Virtual Machine Contributor  (for VM run command)
 *   - Azure Connected Machine Resource Administrator  (for Arc run command)
 */

import { ComputeManagementClient } from '@azure/arm-compute';
import { HybridComputeManagementClient } from '@azure/arm-hybridcompute';
import { DefaultAzureCredential } from '@azure/identity';
import { logger } from '../utils/logger';

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
    computeClients.set(subId, new ComputeManagementClient(new DefaultAzureCredential(), subId));
  }
  return computeClients.get(subId)!;
}

function getHybridClient(subId: string): HybridComputeManagementClient {
  if (!hybridClients.has(subId)) {
    hybridClients.set(subId, new HybridComputeManagementClient(new DefaultAzureCredential(), subId));
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
function buildAuditScript(opts: PowerStigRunOptions): string {
  const moduleVersion = '4.22.0'; // pinned PowerSTIG version — update quarterly if needed
  const ruleFilter = opts.targetRuleIds?.length
    ? `$rules = $rules | Where-Object { $_.Id -in @('${opts.targetRuleIds.join("','")}') }`
    : '';

  return `
#Requires -RunAsAdministrator
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

# ── 1. Ensure PowerSTIG is installed ─────────────────────────────────────────
if (-not (Get-Module -ListAvailable -Name PowerSTIG | Where-Object { $_.Version -ge '${moduleVersion}' })) {
    Write-Host "Installing PowerSTIG ${moduleVersion}..."
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    Install-Module -Name PowerSTIG -RequiredVersion ${moduleVersion} -Force -SkipPublisherCheck -Scope AllUsers
}
Import-Module PowerSTIG -Force

# ── 2. Determine OS type for STIG selection ───────────────────────────────────
$osCaption  = (Get-CimInstance Win32_OperatingSystem).Caption
$osType     = if ($osCaption -match 'Server') { 'WindowsServer' } else { 'Windows10' }

# ── 3. Get STIG rules ─────────────────────────────────────────────────────────
$stig  = [STIG]::new($osType, '${opts.stigVersion}')
$rules = $stig.RuleList
${ruleFilter}

# ── 4. Test each rule ─────────────────────────────────────────────────────────
$results = @()

foreach ($rule in $rules) {
    $res = [pscustomobject]@{
        RuleId      = $rule.Id
        CheckType   = $rule.GetType().Name -replace 'Rule$',''
        Result      = 'NotApplicable'
        Reason      = ''
        Properties  = @{}
    }

    try {
        # Build DSC params
        $params = Get-DscResourceFromStig -Rule $rule -ErrorAction Stop

        if ($params) {
            # Test (audit only — no enforcement)
            $testResult = Invoke-DscResource -ModuleName $params.ModuleName \\
                -Name $params.ResourceName \\
                -Property $params.Properties \\
                -Method Test -ErrorAction Stop

            $res.Result     = if ($testResult.InDesiredState) { 'Pass' } else { 'Fail' }
            $res.Properties = $params.Properties
            if (-not $testResult.InDesiredState) {
                $res.Reason = ($testResult.ReasonPhrase -join '; ')
            }
        }
    } catch {
        $res.Result = 'Error'
        $res.Reason = $_.Exception.Message
    }

    $results += $res
}

# ── 5. Output JSON ────────────────────────────────────────────────────────────
$output = [pscustomobject]@{
    Machine    = $env:COMPUTERNAME
    StigId     = '${opts.benchmarkId}'
    Version    = '${opts.stigVersion}'
    CheckedAt  = (Get-Date -Format 'o')
    Results    = $results
}

$output | ConvertTo-Json -Depth 10 -Compress
`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
