/**
 * eMASS REST API connector
 *
 * Wraps the DoD Enterprise Mission Assurance Support Service (eMASS) v3 REST
 * API so this dashboard can push POA&Ms, controls, and `.cklb` artifacts to
 * eMASS without manual file uploads.
 *
 * Auth: eMASS requires mutual TLS (mTLS) with a DoD-issued PKI certificate
 * plus an api-key header. Both are sourced from environment / Key Vault:
 *   EMASS_BASE_URL          e.g. https://mitigation.emass.apps.mil/api
 *   EMASS_API_KEY           Issued by eMASS administrator
 *   EMASS_USER_UID          eMASS user UID (rfc4514 distinguished name)
 *   EMASS_CERT_PEM          PEM-encoded client certificate (multi-line)
 *   EMASS_KEY_PEM           PEM-encoded private key (multi-line)
 *   EMASS_CA_PEM            (optional) DoD root CA bundle for verification
 *
 * If any of these are missing the connector raises a typed `EmassNotConfigured`
 * error so callers can surface a clear "configure eMASS first" UI hint.
 *
 * In MOCK_MODE the connector returns canned responses — useful for demos and
 * the integration tests in /e2e.
 */

import https from 'https';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from '../utils/logger';

export class EmassNotConfigured extends Error {
  constructor(missing: string[]) {
    super(`eMASS connector not configured. Missing env vars: ${missing.join(', ')}`);
    this.name = 'EmassNotConfigured';
  }
}

export interface EmassPoamPayload {
  externalUid?: string;       // our POA-YYYY-NNNN id
  controlAcronym: string;     // e.g. "AC-2"
  cci?: string;
  status: 'Ongoing' | 'Risk Accepted' | 'Completed' | 'Not Applicable';
  vulnerabilityDescription: string;
  sourceIdentifyingControl?: string;
  pocOrganization?: string;
  pocFirstName?: string;
  pocLastName?: string;
  pocEmail?: string;
  pocPhoneNumber?: string;
  resources?: string;
  identifiedInCFOAuditOrOtherReview?: 'Yes' | 'No';
  scheduledCompletionDate?: number; // epoch seconds (eMASS convention)
  milestones?: { description: string; scheduledCompletionDate: number }[];
  reviewStatus?: 'Not Approved' | 'Under Review' | 'Approved';
  severity?: 'CAT I' | 'CAT II' | 'CAT III';
  rawSeverity?: 'I' | 'II' | 'III';
  relevanceOfThreat?: 'Very Low' | 'Low' | 'Moderate' | 'High' | 'Very High';
  likelihood?: 'Very Low' | 'Low' | 'Moderate' | 'High' | 'Very High';
  impact?: 'Very Low' | 'Low' | 'Moderate' | 'High' | 'Very High';
  residualRiskLevel?: 'Very Low' | 'Low' | 'Moderate' | 'High' | 'Very High';
  recommendations?: string;
  mitigation?: string;
}

export interface EmassSystem {
  systemId: number;
  name: string;
  acronym: string;
  policy?: string;
  rmfActivity?: string;
  registrationType?: string;
}

interface EmassConfig {
  baseUrl:  string;
  apiKey:   string;
  userUid:  string;
  certPem:  string;
  keyPem:   string;
  caPem?:   string;
}

function loadConfig(): EmassConfig {
  const required = ['EMASS_BASE_URL', 'EMASS_API_KEY', 'EMASS_USER_UID', 'EMASS_CERT_PEM', 'EMASS_KEY_PEM'] as const;
  const missing = required.filter((k) => !process.env[k] || !process.env[k]!.trim());
  if (missing.length) throw new EmassNotConfigured(missing);
  return {
    baseUrl: process.env.EMASS_BASE_URL!.replace(/\/$/, ''),
    apiKey:  process.env.EMASS_API_KEY!,
    userUid: process.env.EMASS_USER_UID!,
    certPem: process.env.EMASS_CERT_PEM!,
    keyPem:  process.env.EMASS_KEY_PEM!,
    caPem:   process.env.EMASS_CA_PEM,
  };
}

let cachedClient: AxiosInstance | null = null;

function buildClient(cfg: EmassConfig): AxiosInstance {
  if (cachedClient) return cachedClient;
  // Never allow disabling eMASS server-certificate validation in production —
  // this connects to a DoD authoritative system over mTLS.
  if (process.env.EMASS_TLS_INSECURE === 'true' && process.env.NODE_ENV === 'production') {
    throw new Error('EMASS_TLS_INSECURE=true is forbidden when NODE_ENV=production');
  }
  const httpsAgent = new https.Agent({
    cert: cfg.certPem,
    key:  cfg.keyPem,
    ca:   cfg.caPem,
    // Strict TLS by default. Override only via env (NEVER for production).
    rejectUnauthorized: process.env.EMASS_TLS_INSECURE !== 'true',
    minVersion: 'TLSv1.2',
  });
  cachedClient = axios.create({
    baseURL: cfg.baseUrl,
    httpsAgent,
    timeout: 30_000,
    headers: {
      'api-key':  cfg.apiKey,
      'user-uid': cfg.userUid,
      'Accept':   'application/json',
      'Content-Type': 'application/json',
    },
  });
  return cachedClient;
}

export function isConfigured(): boolean {
  try { loadConfig(); return true; } catch { return false; }
}

export function isMock(): boolean {
  return process.env.MOCK_MODE === 'true';
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function ping(): Promise<{ ok: boolean; mode: 'mock' | 'live'; serverVersion?: string; error?: string }> {
  if (isMock()) return { ok: true, mode: 'mock', serverVersion: 'mock-3.20' };
  try {
    const client = buildClient(loadConfig());
    const res = await safeGet(client, '/api');
    return { ok: true, mode: 'live', serverVersion: res?.meta?.epmassApiVersion };
  } catch (e: any) {
    return { ok: false, mode: 'live', error: e?.message || String(e) };
  }
}

export async function listSystems(): Promise<EmassSystem[]> {
  if (isMock()) {
    return [
      { systemId: 1001, name: 'Contoso Production',  acronym: 'CTSP', policy: 'RMF', registrationType: 'Assess and Authorize' },
      { systemId: 1002, name: 'Fabrikam US Gov Apps', acronym: 'FBRG', policy: 'RMF', registrationType: 'Assess and Authorize' },
    ];
  }
  const client = buildClient(loadConfig());
  const res = await safeGet(client, '/api/systems');
  return (res?.data || []).map((s: any) => ({
    systemId: s.systemId,
    name: s.name,
    acronym: s.acronym,
    policy: s.policy,
    rmfActivity: s.rmfActivity,
    registrationType: s.registrationType,
  }));
}

export async function pushPoams(systemId: number, poams: EmassPoamPayload[]): Promise<{ submitted: number; emassIds: number[]; warnings: string[] }> {
  if (!poams.length) return { submitted: 0, emassIds: [], warnings: [] };

  if (isMock()) {
    logger.info(`[eMASS mock] would push ${poams.length} POA&M(s) to system ${systemId}`);
    return {
      submitted: poams.length,
      emassIds:  poams.map((_, i) => 90000 + i),
      warnings:  [],
    };
  }

  const client = buildClient(loadConfig());
  const body = poams.map((p) => ({ ...p }));
  const res = await safePost(client, `/api/systems/${systemId}/poams`, body);
  const emassIds = (res?.data || []).map((d: any) => d.poamId).filter((id: any) => typeof id === 'number');
  const warnings = (res?.meta?.warnings || []) as string[];
  return { submitted: emassIds.length, emassIds, warnings };
}

export async function uploadCklb(systemId: number, cklbBuffer: Buffer, filename: string): Promise<{ uploaded: boolean; cklbId?: number }> {
  if (isMock()) {
    logger.info(`[eMASS mock] would upload ${filename} (${cklbBuffer.length} bytes) to system ${systemId}`);
    return { uploaded: true, cklbId: Math.floor(Math.random() * 100000) };
  }
  // eMASS multipart upload — wrapped in a function so the cert agent stays loaded.
  const client = buildClient(loadConfig());
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', cklbBuffer, { filename, contentType: 'application/json' });
  const res = await client.post(`/api/systems/${systemId}/cklb`, form, {
    headers: { ...form.getHeaders() },
    maxBodyLength: 50 * 1024 * 1024,
  });
  return { uploaded: true, cklbId: res.data?.data?.[0]?.cklbId };
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

async function safeGet(client: AxiosInstance, path: string, opts?: AxiosRequestConfig) {
  try { return (await client.get(path, opts)).data; }
  catch (e: any) { throw rewrap(e, 'GET', path); }
}
async function safePost(client: AxiosInstance, path: string, body: unknown, opts?: AxiosRequestConfig) {
  try { return (await client.post(path, body, opts)).data; }
  catch (e: any) { throw rewrap(e, 'POST', path); }
}
function rewrap(e: any, method: string, path: string): Error {
  const status = e?.response?.status;
  const data   = e?.response?.data;
  const msg    = data?.errors?.[0]?.message || data?.message || e?.message || String(e);
  const err    = new Error(`eMASS ${method} ${path} failed${status ? ` (${status})` : ''}: ${msg}`);
  (err as any).status = status;
  (err as any).body   = data;
  return err;
}
