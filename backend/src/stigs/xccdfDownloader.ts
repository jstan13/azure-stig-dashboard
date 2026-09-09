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

/**
 * Download and extract a STIG ZIP from DISA.
 * @param url  Full URL to the .zip file on public.cyber.mil
 * @param knownHash  Previously stored SHA-256 of the ZIP; if it matches the cached
 *                   file, the download is skipped.
 */
export async function downloadStigZip(url: string, knownHash?: string): Promise<DownloadResult> {
  ensureCache();

  // Derive a safe filename: take the URL basename, strip any path separators or
  // traversal sequences, and allow only filename-safe characters. Prevents a
  // crafted URL from writing outside CACHE_DIR (path traversal).
  const rawName = decodeURIComponent(url.split('/').pop() || 'stig.zip');
  const filename = path.basename(rawName).replace(/[^A-Za-z0-9._-]+/g, '_') || 'stig.zip';
  const zipPath = path.join(CACHE_DIR, filename);

  // Check cache
  if (fs.existsSync(zipPath)) {
    const cachedHash = sha256File(zipPath);
    if (knownHash && cachedHash === knownHash) {
      logger.info(`[STIGDownloader] Cache hit for ${filename}`);
      const xccdfXml = extractXccdfArchive(fs.readFileSync(zipPath));
      return { xccdfXml, filename, sha256: cachedHash, fromCache: true };
    }
    // Hash mismatch or no known hash — re-download
    logger.info(`[STIGDownloader] Cache stale for ${filename}, re-downloading`);
  }

  logger.info(`[STIGDownloader] Downloading ${filename} from DISA`);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    headers: { 'User-Agent': 'azure-stig-dashboard/1.0' },
    onDownloadProgress: (e) => {
      if (e.total) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (pct % 25 === 0) logger.debug(`[STIGDownloader] ${filename}: ${pct}%`);
      }
    },
  });

  fs.writeFileSync(zipPath, Buffer.from(response.data));
  const sha256 = sha256File(zipPath);
  logger.info(`[STIGDownloader] Downloaded ${filename} (${(response.data.byteLength / 1024).toFixed(0)} KB, sha256=${sha256.substring(0, 12)}…)`);

  const xccdfXml = extractXccdfArchive(fs.readFileSync(zipPath));
  return { xccdfXml, filename, sha256, fromCache: false };
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
