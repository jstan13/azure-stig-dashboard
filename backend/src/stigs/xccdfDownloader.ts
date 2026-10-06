/**
 * XCCDF Downloader
 *
 * Downloads a STIG ZIP file from DISA public.cyber.mil, verifies its SHA-256 hash
 * (if a previous hash is known), extracts the XCCDF XML, and returns the raw XML string
 * ready for parsing.
 *
 * Files are cached in STIG_CACHE_DIR (default: /tmp/stig-cache) so repeated
 * restarts don't re-download.  The cache is keyed by filename + hash.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { unzipSync } from 'fflate';
import { logger } from '../utils/logger';

const CACHE_DIR = process.env.STIG_CACHE_DIR || path.join(process.cwd(), '.stig-cache');
const MAX_XCCDF_BYTES = 50 * 1024 * 1024;

export interface DownloadResult {
  xccdfXml: string;
  filename: string;
  sha256: string;
  /** true if the file was already in cache and not re-downloaded */
  fromCache: boolean;
}

function ensureCache(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface ArchiveDownload {
  filePath: string;
  filename: string;
  sha256: string;
  bytes: number;
  fromCache: boolean;
}

/** Cache-safe filename derived from a download URL basename. */
export function cacheFilenameForUrl(url: string, fallback = 'archive.zip'): string {
  // Strip any path separators or traversal sequences and allow only
  // filename-safe characters so a crafted URL cannot write outside CACHE_DIR.
  const rawName = decodeURIComponent(url.split('/').pop() || fallback);
  return path.basename(rawName).replace(/[^A-Za-z0-9._-]+/g, '_') || fallback;
}

export function cachePath(filename: string): string {
  return path.join(CACHE_DIR, path.basename(filename));
}

/**
 * Downloads a ZIP into the cache, reusing a cached copy only when it matches
 * `knownHash`. `maxBytes` bounds both the advertised and received size.
 */
export async function downloadArchive(
  url: string,
  knownHash?: string,
  maxBytes = 200 * 1024 * 1024,
): Promise<ArchiveDownload> {
  ensureCache();
  const filename = cacheFilenameForUrl(url);
  const zipPath = path.join(CACHE_DIR, filename);

  if (knownHash && fs.existsSync(zipPath)) {
    const cachedHash = sha256File(zipPath);
    if (cachedHash === knownHash) {
      logger.info(`[STIGDownloader] Cache hit for ${filename}`);
      return {
        filePath: zipPath, filename, sha256: cachedHash,
        bytes: fs.statSync(zipPath).size, fromCache: true,
      };
    }
    logger.info(`[STIGDownloader] Cache stale for ${filename}, re-downloading`);
  }

  logger.info(`[STIGDownloader] Downloading ${filename} from DISA`);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 300_000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    headers: { 'User-Agent': 'azure-stig-dashboard/1.0' },
  });
  const data = Buffer.from(response.data);
  if (data.byteLength > maxBytes) {
    throw new Error(`${filename} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB download limit`);
  }
  // Write to a temp name first so a concurrent reader never sees a partial file.
  const tempPath = `${zipPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, zipPath);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  logger.info(`[STIGDownloader] Downloaded ${filename} (${(data.byteLength / 1024).toFixed(0)} KB, sha256=${sha256.substring(0, 12)}…)`);
  return { filePath: zipPath, filename, sha256, bytes: data.byteLength, fromCache: false };
}

/**
 * Download and extract a STIG ZIP from DISA.
 * @param url  Full URL to the .zip file on public.cyber.mil
 * @param knownHash  Previously stored SHA-256 of the ZIP; if it matches the cached
 *                   file, the download is skipped.
 */
export async function downloadStigZip(url: string, knownHash?: string): Promise<DownloadResult> {
  const archive = await downloadArchive(url, knownHash);
  const xccdfXml = extractXccdfArchive(fs.readFileSync(archive.filePath));
  return {
    xccdfXml,
    filename: archive.filename,
    sha256: archive.sha256,
    fromCache: archive.fromCache,
  };
}

/**
 * Extract the XCCDF XML file from a STIG ZIP.
 * DISA ZIPs typically contain one *-xccdf.xml file; some have sub-directories.
 */
export function extractXccdfArchive(zipData: Uint8Array): string {
  const entryNames: string[] = [];
  const oversizedEntries: string[] = [];
  const entries = unzipSync(zipData, {
    filter: (entry) => {
      entryNames.push(entry.name);
      const isXml = entry.name.toLowerCase().endsWith('.xml');
      if (isXml && entry.originalSize > MAX_XCCDF_BYTES) {
        oversizedEntries.push(entry.name);
        return false;
      }
      return isXml;
    },
  });
  const extractedNames = Object.keys(entries);

  // Prefer Manual XCCDF over automated SCAP content
  const xccdfEntryName =
    extractedNames.find((name) => name.endsWith('-xccdf.xml') && name.includes('Manual')) ||
    extractedNames.find((name) => name.endsWith('-xccdf.xml')) ||
    extractedNames.find((name) => name.endsWith('.xml') && !name.includes('cpe'));

  if (!xccdfEntryName) {
    if (oversizedEntries.length) {
      throw new Error(`XCCDF file exceeds the ${MAX_XCCDF_BYTES / 1024 / 1024} MB extraction limit: ${oversizedEntries.join(', ')}`);
    }
    throw new Error(`No XCCDF file found in ZIP. Contents: ${entryNames.join(', ')}`);
  }

  logger.debug(`[STIGDownloader] Extracting XCCDF: ${xccdfEntryName}`);
  return Buffer.from(entries[xccdfEntryName]).toString('utf-8');
}
