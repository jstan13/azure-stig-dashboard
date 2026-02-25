/**
 * STIG Catalog — queries the DISA public.cyber.mil API to discover available
 * STIG benchmarks and their latest versions.
 *
 * DISA publishes STIG content at:
 *   https://public.cyber.mil/stigs/downloads/
 *
 * The unofficial JSON API used here returns the same data as the downloads page.
 * If DISA changes the API, update CATALOG_URL below.
 */

import axios from 'axios';
import { logger } from '../utils/logger';

const CATALOG_URL = 'https://public.cyber.mil/stigs/api/downloads/';

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

export async function fetchStigCatalog(): Promise<CatalogResult> {
  try {
    logger.info('[STIGCatalog] Fetching DISA STIG catalog from public.cyber.mil');
    const response = await axios.get(CATALOG_URL, {
      timeout: 30000,
      headers: { 'User-Agent': 'azure-stig-dashboard/1.0' },
    });

    const raw: any[] = response.data?.data || response.data || [];
    const entries: CatalogEntry[] = raw
      .filter((item: any) => item.type === 'STIG' || !item.type)
      .map((item: any) => ({
        title: item.title || item.name || '',
        version: item.version || '',
        releaseDate: item.releaseDate || item.date || '',
        downloadUrl: item.url || item.downloadUrl || '',
        filename: item.filename || (item.url || '').split('/').pop() || '',
        type: 'STIG',
      }))
      .filter((e) => e.downloadUrl);

    logger.info(`[STIGCatalog] Found ${entries.length} STIG entries`);
    return { entries, fetchedAt: new Date() };
  } catch (err: any) {
    logger.error('[STIGCatalog] Failed to fetch catalog:', err.message);
    // Return empty catalog — caller decides whether to retry or use cached data.
    return { entries: [], fetchedAt: new Date() };
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
  const m = raw.match(/[Vv]ersion\s*(\d+)[,\s]+[Rr]elease\s*(\d+)/);
  if (m) return `V${m[1]}R${m[2]}`;
  // Already normalised, e.g. "V2R8"
  const m2 = raw.match(/V(\d+)R(\d+)/i);
  if (m2) return `V${m2[1]}R${m2[2]}`;
  return raw.trim();
}
