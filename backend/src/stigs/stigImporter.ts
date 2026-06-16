/**
 * STIG Importer
 *
 * Orchestrates the full pipeline: catalog lookup → download → parse → upsert to DB.
 * Used both on initial install and for quarterly updates.
 *
 * In MOCK_MODE it loads STIG content from the bundled docs/example-mapping.json
 * rather than calling DISA.
 */

import { DataSource } from 'typeorm';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import { StigVersionEntity } from '../models/StigVersion';
import { ControlEntity } from '../models/Control';
import { AuditLogEntity } from '../models/AuditLog';
import { downloadStigZip } from './xccdfDownloader';
import { parseXccdf, ParsedBenchmark } from './xccdfParser';
import { fetchStigCatalog, filterCatalog, normaliseVersionString } from './stigCatalog';
import { rebuildControlMappings } from '../data/controlMappingSeeder';
import { logger } from '../utils/logger';

export interface ImportOptions {
  /** Which benchmark titles to import (substring-matched against DISA catalog). */
  benchmarkTitles?: string[];
  /** Force re-import even if the same version is already installed. */
  force?: boolean;
  /** Parse only; do not write to the database. */
  dryRun?: boolean;
  /** Data source to write to. If omitted, import is parsed only (dry run). */
  dataSource?: DataSource;
}

export interface ImportResult {
  benchmarkId: string;
  title: string;
  version: string;
  controlsImported: number;
  controlsUpdated: number;
  skipped: boolean;
  error?: string;
}

/**
 * Default benchmark titles to auto-import on first install.
 * These match DISA's catalog titles via case-insensitive substring.
 */
export const DEFAULT_BENCHMARKS = [
  'Windows 10',
  'Windows 11',
  'Windows Server 2019',
  'Windows Server 2022',
  'Microsoft Edge',
  'Google Chrome',
  'Mozilla Firefox',
  'Internet Explorer 11',
  'Office 2019',
  'Office 365 ProPlus',
  'IIS 10.0 Site',
  'IIS 10.0 Server',
  'SQL Server 2019',
  'Active Directory Domain',
  'Windows DNS Server',
];

export async function importStigs(options: ImportOptions = {}): Promise<ImportResult[]> {
  const titles = options.benchmarkTitles || DEFAULT_BENCHMARKS;
  const results: ImportResult[] = [];

  logger.info(`[STIGImporter] Starting import for ${titles.length} benchmark(s)`);

  // 1. Fetch catalog
  const catalog = await fetchStigCatalog();
  const matching = filterCatalog(catalog, titles);

  if (matching.length === 0) {
    logger.warn('[STIGImporter] No matching benchmarks found in DISA catalog');
    return results;
  }

  logger.info(`[STIGImporter] Found ${matching.length} matching benchmarks`);

  // 2. For each match, download + parse + persist
  for (const entry of matching) {
    const version = normaliseVersionString(entry.version);
    try {
      const result = await importOneBenchmark(entry, version, options);
      results.push(result);
    } catch (err: any) {
      logger.error(`[STIGImporter] Failed to import "${entry.title}": ${err.message}`);
      results.push({
        benchmarkId: '',
        title: entry.title,
        version,
        controlsImported: 0,
        controlsUpdated: 0,
        skipped: false,
        error: err.message,
      });
    }
  }

  logger.info(`[STIGImporter] Import complete. ${results.filter((r) => !r.skipped && !r.error).length} benchmarks updated.`);
  return results;
}

async function importOneBenchmark(
  entry: { title: string; downloadUrl: string; filename: string },
  version: string,
  options: ImportOptions,
): Promise<ImportResult> {
  const ds = options.dataSource;

  // Check if already installed
  if (ds) {
    const benchmarkRepo = ds.getRepository(StigBenchmarkEntity);
    const existing = await benchmarkRepo.findOne({
      where: { title: entry.title },
      relations: ['versions'],
    });

    if (existing && !options.force) {
      const alreadyHave = existing.versions?.find((v) => v.version === version);
      if (alreadyHave && alreadyHave.status === 'active') {
        logger.info(`[STIGImporter] Skipping "${entry.title}" ${version} — already active`);
        return {
          benchmarkId: existing.benchmarkId,
          title: entry.title,
          version,
          controlsImported: 0,
          controlsUpdated: 0,
          skipped: true,
        };
      }
    }
  }

  // Download + parse
  const { xccdfXml, sha256, filename } = await downloadStigZip(entry.downloadUrl);
  const parsed = parseXccdf(xccdfXml);

  if (!ds) {
    // Dry run
    return {
      benchmarkId: parsed.benchmarkId,
      title: parsed.title,
      version: parsed.version,
      controlsImported: parsed.controls.length,
      controlsUpdated: 0,
      skipped: false,
    };
  }

  return persistParsedBenchmark(parsed, sha256, filename, ds);
}

async function persistParsedBenchmark(
  parsed: ParsedBenchmark,
  sha256: string,
  filename: string,
  ds: DataSource,
): Promise<ImportResult> {
  const benchmarkRepo = ds.getRepository(StigBenchmarkEntity);
  const versionRepo = ds.getRepository(StigVersionEntity);
  const controlRepo = ds.getRepository(ControlEntity);
  const auditRepo = ds.getRepository(AuditLogEntity);

  // Upsert benchmark
  let benchmark = await benchmarkRepo.findOne({ where: { benchmarkId: parsed.benchmarkId } });
  if (!benchmark) {
    benchmark = benchmarkRepo.create({
      benchmarkId: parsed.benchmarkId,
      title: parsed.title,
      lastContentUpdate: new Date(),
    });
  }
  benchmark.title = parsed.title;
  benchmark.latestInstalledVersion = parsed.version;
  benchmark.lastContentUpdate = new Date();
  await benchmarkRepo.save(benchmark);

  // Create version record
  let versionRecord = await versionRepo.findOne({
    where: { benchmarkId: benchmark.id, version: parsed.version },
  });
  if (!versionRecord) {
    versionRecord = versionRepo.create({
      benchmarkId: benchmark.id,
      version: parsed.version,
      releaseInfo: parsed.releaseInfo,
      benchmarkDate: parsed.benchmarkDate,
      sourceFilename: filename,
      sourceHash: sha256,
      status: 'parsing',
    });
  } else {
    versionRecord.status = 'parsing';
  }
  await versionRepo.save(versionRecord);

  // Upsert controls
  let imported = 0;
  let updated = 0;
  const BATCH_SIZE = 100;

  for (let i = 0; i < parsed.controls.length; i += BATCH_SIZE) {
    const batch = parsed.controls.slice(i, i + BATCH_SIZE);
    for (const c of batch) {
      const existing = await controlRepo.findOne({ where: { id: c.id } });
      if (existing) {
        Object.assign(existing, {
          vulnId: c.vulnId,
          ruleId: c.ruleId,
          stigId: c.stigId,
          groupId: c.groupId,
          title: c.title,
          severity: c.severity,
          description: c.description,
          checkContent: c.checkContent,
          fixText: c.fixText,
          checkType: c.checkType,
          checkParameters: c.checkParameters,
          ccis: c.ccis,
          stigName: c.stigName,
          stigVersionId: versionRecord!.id,
        });
        await controlRepo.save(existing);
        updated++;
      } else {
        await controlRepo.save(
          controlRepo.create({
            ...c,
            stigVersionId: versionRecord!.id,
          }),
        );
        imported++;
      }
    }
  }

  // Mark version active and update counts
  versionRecord.status = 'active';
  versionRecord.ruleCount = parsed.controls.length;
  versionRecord.catICount = parsed.controls.filter((c) => c.severity === 'high').length;
  versionRecord.catIICount = parsed.controls.filter((c) => c.severity === 'medium').length;
  versionRecord.catIIICount = parsed.controls.filter((c) => c.severity === 'low').length;
  await versionRepo.save(versionRecord);

  // Mark previous versions superseded
  const allVersions = await versionRepo.find({ where: { benchmarkId: benchmark.id } });
  for (const v of allVersions) {
    if (v.id !== versionRecord.id && v.status === 'active') {
      v.status = 'superseded';
      await versionRepo.save(v);
    }
  }

  // Audit log
  await auditRepo.save(
    auditRepo.create({
      action: 'stig.imported',
      actor: 'system',
      targetId: benchmark.id,
      targetType: 'stig_benchmark',
      details: {
        version: parsed.version,
        controlsImported: imported,
        controlsUpdated: updated,
        totalControls: parsed.controls.length,
      },
    } as any),
  );

  logger.info(`[STIGImporter] "${parsed.title}" ${parsed.version}: ${imported} new, ${updated} updated controls`);

  // Build out Azure Policy / Defender control mappings for the freshly imported
  // version: direct mappings from the curated file + per-control columns, then
  // transitive expansion across shared NIST 800-53 controls (CCI-derived).
  try {
    const coverage = await rebuildControlMappings(ds, versionRecord.id);
    logger.info(
      `[STIGImporter] Control mappings for "${parsed.title}" ${parsed.version}: ` +
        `${coverage.controlsMapped}/${coverage.controlsTotal} controls (${coverage.coveragePercent}%)`,
    );
  } catch (mapErr: any) {
    logger.warn(`[STIGImporter] Control mapping build-out failed: ${mapErr?.message}`);
  }

  return {
    benchmarkId: parsed.benchmarkId,
    title: parsed.title,
    version: parsed.version,
    controlsImported: imported,
    controlsUpdated: updated,
    skipped: false,
  };
}
