import { DataSource, In } from 'typeorm';
import { ControlEntity } from '../models/Control';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import {
  StigReleaseCandidateEntity, StigReleaseDiff,
} from '../models/StigReleaseCandidate';
import { StigVersionEntity } from '../models/StigVersion';
import { logger } from '../utils/logger';
import { CatalogEntry, fetchStigCatalog, normaliseVersionString } from './stigCatalog';
import { downloadStigZip } from './xccdfDownloader';
import { importCatalogEntry, ImportResult } from './stigImporter';
import { parseXccdf, ParsedControl } from './xccdfParser';

export interface StagedReleaseResult {
  benchmarkId: string;
  title: string;
  installedVersion: string;
  availableVersion: string;
  updateAvailable: boolean;
  candidateId?: string;
}

function productKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bsecurity technical implementation guide\b/g, 'stig')
    .replace(/\bver(?:sion)?\.?\s*\d+.*$/i, '')
    .replace(/\bv\d+r\d+\b/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findCatalogEntry(
  benchmark: StigBenchmarkEntity,
  entries: CatalogEntry[],
): CatalogEntry | undefined {
  const installedKey = productKey(benchmark.title);
  return entries.find((entry) => {
    const candidateKey = productKey(entry.title);
    return candidateKey === installedKey
      || candidateKey.includes(installedKey)
      || installedKey.includes(candidateKey);
  });
}

function controlFingerprint(control: ParsedControl | ControlEntity): string {
  return JSON.stringify({
    ruleId: control.ruleId,
    stigId: control.stigId,
    title: control.title,
    severity: control.severity,
    description: control.description,
    checkContent: control.checkContent,
    fixText: control.fixText,
    ccis: control.ccis ?? [],
  });
}

export function compareControls(
  installed: ControlEntity[],
  available: ParsedControl[],
): StigReleaseDiff {
  const oldByVuln = new Map(installed.map((control) => [control.vulnId, control]));
  const newByVuln = new Map(available.map((control) => [control.vulnId, control]));
  const added = [...newByVuln.keys()].filter((id) => !oldByVuln.has(id)).sort();
  const removed = [...oldByVuln.keys()].filter((id) => !newByVuln.has(id)).sort();
  const changed: string[] = [];
  const severityChanged: string[] = [];

  for (const [vulnId, current] of newByVuln) {
    const previous = oldByVuln.get(vulnId);
    if (!previous) continue;
    if (controlFingerprint(previous) !== controlFingerprint(current)) changed.push(vulnId);
    if (previous.severity !== current.severity) severityChanged.push(vulnId);
  }

  return { added, removed, changed: changed.sort(), severityChanged: severityChanged.sort() };
}

export async function stageAvailableReleases(
  dataSource: DataSource,
): Promise<StagedReleaseResult[]> {
  const catalog = await fetchStigCatalog();
  const benchmarkRepo = dataSource.getRepository(StigBenchmarkEntity);
  const versionRepo = dataSource.getRepository(StigVersionEntity);
  const controlRepo = dataSource.getRepository(ControlEntity);
  const candidateRepo = dataSource.getRepository(StigReleaseCandidateEntity);
  const installed = await benchmarkRepo.find({ where: { active: true } });
  const results: StagedReleaseResult[] = [];

  for (const benchmark of installed) {
    const entry = findCatalogEntry(benchmark, catalog.entries);
    if (!entry) continue;
    const availableVersion = normaliseVersionString(entry.version);
    const installedVersion = benchmark.latestInstalledVersion || 'none';
    const updateAvailable = installedVersion !== availableVersion;

    benchmark.latestAvailableVersion = availableVersion;
    await benchmarkRepo.save(benchmark);

    if (!updateAvailable) {
      results.push({
        benchmarkId: benchmark.benchmarkId,
        title: benchmark.title,
        installedVersion,
        availableVersion,
        updateAvailable: false,
      });
      continue;
    }

    let candidate = await candidateRepo.findOne({
      where: { benchmarkId: benchmark.id, version: availableVersion },
    });
    if (!candidate || candidate.status === 'failed') {
      try {
        const download = await downloadStigZip(entry.downloadUrl, candidate?.sourceHash);
        const parsed = parseXccdf(download.xccdfXml);
        if (parsed.benchmarkId !== benchmark.benchmarkId) {
          throw new Error(
            `Catalog match resolved to ${parsed.benchmarkId}, expected ${benchmark.benchmarkId}`,
          );
        }
        const activeVersion = await versionRepo.findOne({
          where: { benchmarkId: benchmark.id, status: 'active' },
        });
        const activeControls = activeVersion
          ? await controlRepo.find({ where: { stigVersionId: activeVersion.id } })
          : [];
        const diff = compareControls(activeControls, parsed.controls);
        candidate = candidateRepo.create({
          ...candidate,
          benchmarkId: benchmark.id,
          title: benchmark.title,
          version: availableVersion,
          releaseDate: entry.releaseDate ? new Date(entry.releaseDate) : null,
          downloadUrl: entry.downloadUrl,
          filename: download.filename,
          sourceHash: download.sha256,
          status: 'ready',
          addedRules: diff.added.length,
          removedRules: diff.removed.length,
          changedRules: diff.changed.length,
          severityChanges: diff.severityChanged.length,
          diff,
          approvedBy: null,
          approvedAt: null,
          appliedAt: null,
          errorMessage: null,
        });
        candidate = await candidateRepo.save(candidate);
      } catch (error: any) {
        logger.error(`[STIGRelease] Could not stage "${benchmark.title}": ${error.message}`);
        if (candidate) {
          candidate.status = 'failed';
          candidate.errorMessage = error.message;
          await candidateRepo.save(candidate);
        }
        continue;
      }
    }

    results.push({
      benchmarkId: benchmark.benchmarkId,
      title: benchmark.title,
      installedVersion,
      availableVersion,
      updateAvailable: true,
      candidateId: candidate.id,
    });
  }

  return results;
}

export async function listReleaseCandidates(
  dataSource: DataSource,
): Promise<StigReleaseCandidateEntity[]> {
  return dataSource.getRepository(StigReleaseCandidateEntity).find({
    where: { status: In(['ready', 'approved', 'importing', 'failed']) },
    order: { discoveredAt: 'DESC' },
  });
}

export async function applyReleaseCandidate(
  dataSource: DataSource,
  candidateId: string,
  actor: string,
): Promise<ImportResult> {
  const repo = dataSource.getRepository(StigReleaseCandidateEntity);
  const candidate = await repo.findOne({ where: { id: candidateId } });
  if (!candidate) throw new Error('Staged STIG release not found');
  if (!['ready', 'approved', 'failed'].includes(candidate.status)) {
    throw new Error(`STIG release is ${candidate.status} and cannot be applied`);
  }

  candidate.status = 'approved';
  candidate.approvedBy = actor;
  candidate.approvedAt = new Date();
  candidate.errorMessage = null;
  await repo.save(candidate);

  candidate.status = 'importing';
  await repo.save(candidate);
  try {
    const result = await importCatalogEntry({
      title: candidate.title,
      version: candidate.version,
      releaseDate: candidate.releaseDate?.toISOString() ?? '',
      downloadUrl: candidate.downloadUrl,
      filename: candidate.filename,
      type: 'STIG',
    }, { dataSource, expectedHash: candidate.sourceHash });
    if (result.error) throw new Error(result.error);
    candidate.status = 'applied';
    candidate.appliedAt = new Date();
    await repo.save(candidate);
    return result;
  } catch (error: any) {
    candidate.status = 'failed';
    candidate.errorMessage = error.message;
    await repo.save(candidate);
    throw error;
  }
}

export async function applyReadyReleases(dataSource: DataSource): Promise<ImportResult[]> {
  const candidates = await dataSource.getRepository(StigReleaseCandidateEntity).find({
    where: { status: 'ready' },
  });
  const results: ImportResult[] = [];
  for (const candidate of candidates) {
    results.push(await applyReleaseCandidate(dataSource, candidate.id, 'scheduler'));
  }
  return results;
}
