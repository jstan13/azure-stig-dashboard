/**
 * STIG Catalog — queries the public Cyber.mil document library used by the
 * STIG downloads page to discover current manual benchmark packages.
 */

import axios from 'axios';
import { z } from 'zod';
import { logger } from '../utils/logger';

const CATALOG_URL = 'https://www.cyber.mil/webruntime/api/apex/execute?language=en-US&asGuest=true&htmlEncode=false';
const CATALOG_REQUEST = {
  namespace: '',
  classname: '@udd/01pRw0000002mOj',
  method: 'getCyberDocumentCatalogByDocumentLibrary',
  isContinuation: false,
  params: { documentLibrary: 'STIGs' },
  cacheable: false,
};

const catalogResponseSchema = z.object({
  returnValue: z.array(z.object({
    FileName: z.string(),
    UploadDate: z.string(),
    DownloadLink: z.string().url(),
    RawDownloadType: z.string().optional().default(''),
  })),
});

export interface CatalogEntry {
  title: string;
  version: string;
  releaseDate: string;
  downloadUrl: string;
  filename: string;
  type: 'STIG' | 'SRG' | 'Other';
}

export interface CatalogResult {
  entries: CatalogEntry[];
  fetchedAt: Date;
}

export function parseCatalogResponse(data: unknown): CatalogEntry[] {
  const parsed = catalogResponseSchema.parse(data);
  const entries = parsed.returnValue
    .filter((item) => {
      const isZip = item.DownloadLink.toLowerCase().endsWith('.zip');
      const isStig = item.RawDownloadType.split(';').includes('STIGs');
      const isAutomation = /SCAP|Automation|Ansible|Chef|Powershell|Group Policy/i.test(item.RawDownloadType);
      const isRetired = /\bSunset\b/i.test(`${item.FileName} ${item.RawDownloadType}`);
      return isZip && isStig && !isAutomation && !isRetired && /\bSTIG\b/i.test(item.FileName);
    })
    .map((item) => ({
      title: item.FileName.replace(/[\u200B-\u200D\uFEFF]/g, '').trim(),
      version: normaliseVersionString(`${item.FileName} ${item.DownloadLink}`),
      releaseDate: item.UploadDate,
      downloadUrl: item.DownloadLink,
      filename: item.DownloadLink.split('/').pop() || '',
      type: 'STIG' as const,
    }));

  const latestByProduct = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    const product = entry.title
      .replace(/\s+[-\u2013\u2014]?\s*\bVer(?:sion)?\.?\s*\d+.*$/i, '')
      .trim()
      .toLowerCase();
    const current = latestByProduct.get(product);
    if (!current || entry.releaseDate > current.releaseDate) {
      latestByProduct.set(product, entry);
    }
  }
  return [...latestByProduct.values()];
}

export async function fetchStigCatalog(): Promise<CatalogResult> {
  try {
    logger.info('[STIGCatalog] Fetching DISA STIG catalog from cyber.mil');
    const response = await axios.post(CATALOG_URL, CATALOG_REQUEST, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Referer: 'https://www.cyber.mil/stigs/downloads/',
        'User-Agent': 'azure-stig-dashboard/1.0',
      },
    });

    const entries = parseCatalogResponse(response.data);
    if (entries.length === 0) {
      throw new Error('Cyber.mil returned no manual STIG ZIP entries');
    }

    logger.info(`[STIGCatalog] Found ${entries.length} STIG entries`);
    return { entries, fetchedAt: new Date() };
  } catch (err: any) {
    logger.error('[STIGCatalog] Failed to fetch catalog:', err.message);
    throw new Error(`Failed to fetch DISA STIG catalog: ${err.message}`);
  }
}

/**
 * Filter catalog to only STIG entries matching the given benchmark titles.
 * Matching is case-insensitive substring match on title.
 */
export function filterCatalog(catalog: CatalogResult, queries: string[]): CatalogEntry[] {
  const lower = queries.map((q) => q.toLowerCase());
  return catalog.entries.filter((e) =>
    lower.some((q) => e.title.toLowerCase().includes(q)),
  );
}

/**
 * Parse a DISA version string like "Version 2, Release 8" → "V2R8"
 */
export function normaliseVersionString(raw: string): string {
  const m = raw.match(/\b[Vv]er(?:sion)?\.?\s*(\d+)[,\s-]+[Rr]el(?:ease)?\.?\s*(\d+)/);
  if (m) return `V${m[1]}R${m[2]}`;
  // Already normalised, e.g. "V2R8"
  const m2 = raw.match(/V(\d+)R(\d+)/i);
  if (m2) return `V${m2[1]}R${m2[2]}`;
  return raw.trim();
}
