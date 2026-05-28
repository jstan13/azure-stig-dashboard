/**
 * Linux OpenSCAP Scanner
 *
 * Runs an SCAP/XCCDF evaluation on Linux Arc-connected machines using
 * Azure Arc RunExtension with the following shell command sequence:
 *
 *   1. Install oscap-scanner if missing  (dnf/apt)
 *   2. Download the XCCDF content from DISA
 *   3. Run: oscap xccdf eval --profile stig --results-arf /tmp/arf.xml <content>
 *   4. Upload /tmp/arf.xml to Azure Blob Storage
 *   5. Store the blob URL in PowerStigResult for downstream parsing
 *
 * Called from scan orchestrator when machine.osType === 'Linux'.
 */

import { HybridComputeManagementClient } from '@azure/arm-hybridcompute';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { DataSource } from 'typeorm';
import { MachineEntity } from '../models/Machine';
import { ScanEntity } from '../models/Scan';
import { PowerStigResultEntity } from '../models/PowerStigResult';
import { logger } from '../utils/logger';

export interface OpenScapScanOptions {
  benchmarkXccdfUrl: string;
  profileName: string;
  dataStream?: string;
}

// Known STIG profiles per benchmark ID
const STIG_PROFILES: Record<string, string> = {
  'RHEL_9_STIG':  'xccdf_mil.disa.stig_profile_CAT_I_II_III',
  'RHEL_8_STIG':  'xccdf_mil.disa.stig_profile_CAT_I_II_III',
  'Ubuntu_20_STIG':'xccdf_mil.disa.stig_profile_CAT_I_II_III',
  'Ubuntu_22_STIG':'xccdf_mil.disa.stig_profile_CAT_I_II_III',
};

export async function runOpenScapScan(
  machine: MachineEntity,
  scan: ScanEntity,
  opts: OpenScapScanOptions,
  dataSource: DataSource,
): Promise<void> {
  logger.info(`[OpenSCAP] Starting scan on ${machine.name}`);

  const script = buildScapScript(opts);
  const runOutput = await executeOnArcLinux(machine, script);

  // Parse embedded ARF XML from the output (base64 encoded block between markers)
  const arfXml = extractArfFromOutput(runOutput);
  if (!arfXml) {
    logger.warn(`[OpenSCAP] No ARF results extracted from ${machine.name}`);
    return;
  }

  // Persist result XML to blob storage and record in DB
  const blobUrl = await uploadResultBlob(machine.name, scan.id, arfXml);

  const repo = dataSource.getRepository(PowerStigResultEntity);
  const result = repo.create({
    machineId:    machine.id,
    scanId:       scan.id,
    benchmarkId:  opts.dataStream ?? 'linux-oscap',
    rawJson:      { arfBlobUrl: blobUrl, arfXmlLength: arfXml.length },
    scannedAt:    new Date(),
    exitCode:     0,
  } as any);
  await repo.save(result);

  // Now parse findings
  const { parseScapResults } = await import('./scapResultParser');
  await parseScapResults(arfXml, machine, scan, dataSource);

  logger.info(`[OpenSCAP] Scan complete for ${machine.name}`);
}

// ─── Script builder ───────────────────────────────────────────────────────────

function buildScapScript(opts: OpenScapScanOptions): string {
  const { benchmarkXccdfUrl, profileName } = opts;
  const contentPath = '/tmp/stig_content.zip';
  const xccdfPath   = '/tmp/stig_xccdf.xml';
  const arfPath     = '/tmp/stig_arf.xml';

  // ── Audit #10: validate inputs before composing the bash script ───────────
  // benchmarkXccdfUrl must be HTTPS, on a known DISA / NIST / mil host, and
  // contain no shell metacharacters.
  const allowedHostPattern = /^https:\/\/(public\.cyber\.mil|ncp\.nist\.gov|csrc\.nist\.gov|dl\.dod\.cyber\.mil)\//;
  if (!allowedHostPattern.test(benchmarkXccdfUrl)) {
    throw new Error(`OpenSCAP: refusing benchmarkXccdfUrl "${benchmarkXccdfUrl}" \u2014 must match ${allowedHostPattern}`);
  }
  if (/[\s"'`$\\;|&<>(){}]/.test(benchmarkXccdfUrl)) {
    throw new Error('OpenSCAP: benchmarkXccdfUrl contains forbidden shell metacharacters');
  }
  // profileName: alphanumeric + - _ . : / only (matches XCCDF profile id syntax)
  if (!/^[A-Za-z0-9_\-:./]+$/.test(profileName)) {
    throw new Error(`OpenSCAP: refusing profileName "${profileName}" \u2014 must match /^[A-Za-z0-9_\\-:./]+$/`);
  }

  return `#!/bin/bash
set -euo pipefail

# ── Install oscap if needed ──────────────────────────────────────────────────
if ! command -v oscap &>/dev/null; then
  if command -v dnf &>/dev/null; then
    dnf install -y openscap-scanner 2>&1
  elif command -v apt-get &>/dev/null; then
    apt-get install -y libopenscap8 2>&1
  else
    echo "ERROR: Cannot determine package manager"; exit 1
  fi
fi

# ── Download STIG content ────────────────────────────────────────────────────
curl -sSL "${benchmarkXccdfUrl}" -o "${contentPath}"
if file "${contentPath}" | grep -q "Zip"; then
  cd /tmp && unzip -o stig_content.zip -d stig_content/
  XCCDF=$(find /tmp/stig_content -name "*xccdf.xml" | head -1)
else
  XCCDF="${contentPath}"
fi

# ── Run SCAP evaluation ──────────────────────────────────────────────────────
oscap xccdf eval \\
  --profile "${profileName}" \\
  --results-arf "${arfPath}" \\
  --report /tmp/stig_report.html \\
  "$XCCDF" || EXIT=$?  # oscap exits 2 on non-compliant — tolerate it

# ── Encode ARF XML for extraction ───────────────────────────────────────────
if [ -f "${arfPath}" ]; then
  echo "===ARF_BEGIN==="
  base64 -w 0 "${arfPath}"
  echo ""
  echo "===ARF_END==="
  echo "OSCAP_EXIT=\${EXIT:-0}"
else
  echo "ERROR: ${arfPath} not found"
  exit 1
fi`;
}

// ─── Azure Arc execution ─────────────────────────────────────────────────────

async function executeOnArcLinux(machine: MachineEntity, script: string): Promise<string> {
  const credential = new DefaultAzureCredential();
  const client     = new HybridComputeManagementClient(credential, machine.subscriptionId);

  const result = await (client.machines as any).beginRunCommandAndWait(
    machine.resourceGroupName,
    machine.name,
    {
      source:     { script },
      parameters: [],
    } as any,
  );
  return result?.value?.[0]?.message ?? '';
}

// ─── ARF extraction ───────────────────────────────────────────────────────────

function extractArfFromOutput(output: string): string | null {
  const match = output.match(/===ARF_BEGIN===\r?\n([\s\S]+?)\r?\n===ARF_END===/);
  if (!match) return null;
  try {
    return Buffer.from(match[1].trim(), 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

// ─── Blob upload ──────────────────────────────────────────────────────────────

async function uploadResultBlob(machineName: string, scanId: string, xml: string): Promise<string> {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    logger.warn('[OpenSCAP] AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload');
    return '';
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  const containerClient   = blobServiceClient.getContainerClient('stig-scan-results');
  // Private container (no `access` option) — scan results contain sensitive
  // compliance/vulnerability data and must never be anonymously readable.
  await containerClient.createIfNotExists();

  const blobName   = `oscap/${machineName}/${scanId}/arf.xml`;
  const blockBlob  = containerClient.getBlockBlobClient(blobName);
  await blockBlob.upload(xml, Buffer.byteLength(xml, 'utf-8'), {
    blobHTTPHeaders: { blobContentType: 'application/xml' },
  });

  return blockBlob.url;
}

// ─── Mock helper ──────────────────────────────────────────────────────────────

export function isMockMode(): boolean {
  return process.env.MOCK_MODE === 'true';
}
