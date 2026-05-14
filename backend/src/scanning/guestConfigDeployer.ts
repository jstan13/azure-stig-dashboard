/**
 * Azure Guest Configuration Deployer
 *
 * Manages Azure Policy Guest Configuration assignments for fleet-wide
 * continuous STIG compliance monitoring — an alternative to per-machine
 * Run Commands that scales to thousands of VMs and Arc machines.
 *
 * Architecture:
 *   1. Guest Configuration packages are authored from XCCDF STIG content
 *      and stored in an Azure Blob Storage container.
 *   2. Azure Policy initiatives assign GC packages to scopes (subscriptions,
 *      management groups) with DeployIfNotExists + AuditIfNotExists effects.
 *   3. Compliance results flow back through Azure Policy compliance API.
 *   4. This module reads those compliance results and syncs them to our DB.
 *
 * Required Azure RBAC:
 *   - Guest Configuration Resource Contributor
 *   - Policy Contributor  (for initiative assignments)
 *   - Reader on all resources in scope
 *
 * Required env vars:
 *   AZURE_SUBSCRIPTION_ID
 *   GC_STORAGE_ACCOUNT        (storage account for GC packages)
 *   GC_STORAGE_CONTAINER      (blob container, default: stig-gc-packages)
 *   GC_RESOURCE_GROUP         (RG where GC assignments live)
 */

import { GuestConfigurationClient } from '@azure/arm-guestconfiguration';
import { PolicyClient } from '@azure/arm-policy';
import { DefaultAzureCredential } from '@azure/identity';
import { DataSource } from 'typeorm';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { logger } from '../utils/logger';

const GC_STORAGE_CONTAINER = process.env.GC_STORAGE_CONTAINER ?? 'stig-gc-packages';
const GC_RESOURCE_GROUP    = process.env.GC_RESOURCE_GROUP ?? 'stig-tracker-rg';

export interface GcDeployOptions {
  subscriptionId: string;
  resourceGroupName?: string;
  /** Scope for policy assignment — defaults to subscription scope */
  assignmentScope?: string;
  benchmarkId: string;
  stigVersion: string;
  /** Storage Account URL where GC package is uploaded */
  packageStorageUri: string;
}

export interface GcComplianceSummary {
  assignmentName: string;
  compliant: number;
  nonCompliant: number;
  unknown: number;
  total: number;
}

const gcClients  = new Map<string, GuestConfigurationClient>();
const polClients = new Map<string, PolicyClient>();

function getGcClient(subId: string): GuestConfigurationClient {
  if (!gcClients.has(subId)) {
    gcClients.set(subId, new GuestConfigurationClient(new DefaultAzureCredential(), subId));
  }
  return gcClients.get(subId)!;
}

function getPolicyClient(subId: string): PolicyClient {
  if (!polClients.has(subId)) {
    polClients.set(subId, new PolicyClient(new DefaultAzureCredential(), subId));
  }
  return polClients.get(subId)!;
}

/**
 * List all Guest Configuration assignments under a subscription.
 * Returns assignments whose name starts with "stig-" to filter ours.
 */
export async function listStigGcAssignments(subscriptionId: string): Promise<string[]> {
  const client = getGcClient(subscriptionId);
  const assignments: string[] = [];

  try {
    const pages = (client.guestConfigurationAssignments as any).subscriptionList
      ? (client.guestConfigurationAssignments as any).subscriptionList(subscriptionId)
      : (client.guestConfigurationAssignments as any).listSubscriptionList
      ? (client.guestConfigurationAssignments as any).listSubscriptionList(subscriptionId)
      : [];
    for await (const page of pages) {
      if (page.name?.startsWith('stig-')) {
        assignments.push(page.name);
      }
    }
  } catch (err: any) {
    logger.warn(`[GcDeployer] Could not list GC assignments: ${err.message}`);
  }

  return assignments;
}

/**
 * Assign a Guest Configuration package to a VM.
 * Creates or updates the GuestConfigurationAssignment.
 *
 * @param subscriptionId  Azure subscription
 * @param resourceGroup   VM resource group
 * @param vmName          VM name
 * @param assignmentName  e.g. "stig-windows10-v2r8"
 * @param packageUri      Blob Storage URI of the compiled GC package (.zip)
 * @param packageHash     SHA-256 of the package for integrity verification
 */
export async function assignGcToVm(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
  assignmentName: string,
  packageUri: string,
  packageHash: string,
): Promise<void> {
  const client = getGcClient(subscriptionId);

  logger.info(`[GcDeployer] Assigning GC "${assignmentName}" to VM ${vmName}`);

  await client.guestConfigurationAssignments.createOrUpdate(
    resourceGroup,
    assignmentName,
    vmName,
    {
      name: assignmentName,
      properties: {
        guestConfiguration: {
          name:         assignmentName,
          contentUri:   packageUri,
          contentHash:  packageHash,
          assignmentType: 'Audit',
        },
      },
    },
  );
}

/**
 * Assign a Guest Configuration package to an Arc-connected machine.
 */
export async function assignGcToArcMachine(
  subscriptionId: string,
  resourceGroup: string,
  machineName: string,
  assignmentName: string,
  packageUri: string,
  packageHash: string,
): Promise<void> {
  const client = getGcClient(subscriptionId);

  logger.info(`[GcDeployer] Assigning GC "${assignmentName}" to Arc machine ${machineName}`);

  // Arc machines use the same assignment API but routed differently
  await (client.guestConfigurationHcrpAssignments as any).createOrUpdate(
    resourceGroup,
    assignmentName,
    machineName,
    {
      name: assignmentName,
      properties: {
        guestConfiguration: {
          name:         assignmentName,
          contentUri:   packageUri,
          contentHash:  packageHash,
          assignmentType: 'Audit',
        },
      },
    },
  );
}

/**
 * Retrieve Guest Configuration assignment compliance reports for a VM.
 * Returns the latest report for the given assignment.
 */
export async function getVmGcComplianceReport(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
  assignmentName: string,
): Promise<GcAssignmentReport | null> {
  const client = getGcClient(subscriptionId);

  try {
    const reportsResult: any = await ((client.guestConfigurationAssignmentReports as any).list(
      resourceGroup,
      assignmentName,
      vmName,
    ));
    const reports: any[] = reportsResult?.value ?? reportsResult ?? [];

    let latest: any = null;
    for (const report of reports) {
      if (!latest || new Date(report.properties?.startTime ?? 0) > new Date(latest.properties?.startTime ?? 0)) {
        latest = report;
      }
    }

    if (!latest) return null;

    return mapReportToInternal(latest);
  } catch (err: any) {
    logger.warn(`[GcDeployer] Could not get GC report for ${vmName}/${assignmentName}: ${err.message}`);
    return null;
  }
}

export interface GcAssignmentReport {
  reportId: string;
  complianceStatus: 'Compliant' | 'NonCompliant' | 'Pending' | 'Unknown';
  startTime: Date;
  endTime?: Date;
  resources: GcResourceCompliance[];
}

export interface GcResourceCompliance {
  resourceId: string;
  complianceStatus: 'Compliant' | 'NonCompliant' | 'Pending';
  reasons: string[];
}

function mapReportToInternal(raw: any): GcAssignmentReport {
  const resources: GcResourceCompliance[] = (raw.properties?.resources ?? []).map((r: any) => ({
    resourceId:       r.resourceId ?? r.properties?.resourceId ?? '',
    complianceStatus: r.properties?.complianceStatus ?? 'Pending',
    reasons:          (r.properties?.reasons ?? []).map((reason: any) => reason.phrase ?? ''),
  }));

  return {
    reportId:         raw.id ?? raw.name ?? '',
    complianceStatus: raw.properties?.complianceStatus ?? 'Unknown',
    startTime:        new Date(raw.properties?.startTime ?? Date.now()),
    endTime:          raw.properties?.endTime ? new Date(raw.properties.endTime) : undefined,
    resources,
  };
}

/**
 * Sync compliance results from a GC report into the database.
 * Maps each GC resource (DSC resource instance) back to a Finding.
 *
 * GC resource IDs follow the pattern:
 *   "[<ModuleName>]<ResourceName>/<VulnId>"
 * e.g.: "[RegistryPolicyFile]RegistryPolicyFile/V-220700"
 */
export async function syncGcReportToDb(
  report: GcAssignmentReport,
  machineId: string,
  stigVersionId: string,
  dataSource: DataSource,
): Promise<{ updated: number; skipped: number }> {
  const findingRepo = dataSource.getRepository(FindingEntity);
  const controlRepo = dataSource.getRepository(ControlEntity);

  let updated = 0;
  let skipped = 0;

  for (const resource of report.resources) {
    // Extract vulnId from resource ID (last segment after '/')
    const vulnId = resource.resourceId.split('/').pop();
    if (!vulnId || !vulnId.startsWith('V-')) {
      skipped++;
      continue;
    }

    const control = await controlRepo.findOne({ where: { stigVersionId, vulnId } });
    if (!control) {
      skipped++;
      continue;
    }

    const status: FindingEntity['status'] =
      resource.complianceStatus === 'Compliant'    ? 'not_a_finding'
      : resource.complianceStatus === 'NonCompliant' ? 'open'
      : 'not_reviewed';

    const existing = await findingRepo.findOne({ where: { machineId, controlId: control.id } });

    if (existing) {
      existing.status     = status;
      existing.reviewedAt = report.startTime;
      if (resource.reasons.length > 0) {
        existing.comments = resource.reasons.join('; ');
      }
      await findingRepo.save(existing);
      updated++;
    } else {
      await findingRepo.save(
        findingRepo.create({
          machineId,
          controlId:  control.id,
          status,
          severity:   control.severity,
          comments:   resource.reasons.join('; ') || null,
          reviewedAt: report.startTime,
        } as any),
      );
      updated++;
    }
  }

  logger.info(`[GcDeployer] Synced GC report: ${updated} updated, ${skipped} skipped`);
  return { updated, skipped };
}

/**
 * Build the GC assignment name from benchmark + version.
 * Must be lowercase, max 64 chars.
 */
export function buildAssignmentName(benchmarkId: string, version: string): string {
  return `stig-${benchmarkId.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${version.toLowerCase()}`
    .slice(0, 64);
}
