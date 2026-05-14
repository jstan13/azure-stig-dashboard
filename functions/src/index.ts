/**
 * Azure Functions entry point.
 *
 * Exposes two scheduled functions:
 *   - scheduledScan       — runs nightly at 06:00 UTC, calls /api/scan/trigger
 *                           and /api/vulnerabilities/sync on the dashboard's
 *                           backend App Service.
 *   - complianceDriftCheck — runs every 6 hours, queries hierarchy KPIs and
 *                           posts a Teams/email alert when CAT I open findings
 *                           rise above the threshold env var
 *                           DRIFT_CAT1_THRESHOLD (default 0).
 *
 * Authentication: uses a managed-identity bearer token issued for the backend
 * App Service's API audience (set BACKEND_API_AUDIENCE env var in the Function
 * App configuration). Falls back to a static FUNCTION_API_KEY header if the
 * backend is configured to accept it (NOT recommended for prod).
 */

import { app, InvocationContext, Timer } from '@azure/functions';
import axios from 'axios';

const BACKEND_BASE_URL  = (process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
const BACKEND_API_AUD   = process.env.BACKEND_API_AUDIENCE || '';
const FUNCTION_API_KEY  = process.env.FUNCTION_API_KEY || '';
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';
const DRIFT_CAT1_THRESH = Number(process.env.DRIFT_CAT1_THRESHOLD || 0);

async function backendHeaders(): Promise<Record<string, string>> {
  if (FUNCTION_API_KEY) return { 'X-Function-Key': FUNCTION_API_KEY };
  if (!BACKEND_API_AUD) throw new Error('BACKEND_API_AUDIENCE or FUNCTION_API_KEY must be set');
  // Lazy-load so Functions cold-start stays fast in mock/dev environments.
  const { DefaultAzureCredential } = await import('@azure/identity');
  const cred = new DefaultAzureCredential();
  const token = await cred.getToken(`${BACKEND_API_AUD}/.default`);
  if (!token) throw new Error('Unable to acquire managed-identity token');
  return { Authorization: `Bearer ${token.token}` };
}

async function postJson(path: string, body: unknown, ctx: InvocationContext): Promise<void> {
  if (!BACKEND_BASE_URL) {
    ctx.warn(`[functions] BACKEND_BASE_URL not set; skipping ${path}`);
    return;
  }
  const headers = await backendHeaders();
  const res = await axios.post(`${BACKEND_BASE_URL}${path}`, body, { headers, timeout: 60_000 });
  ctx.log(`[functions] POST ${path} -> ${res.status}`);
}

async function getJson<T = any>(path: string, ctx: InvocationContext): Promise<T | null> {
  if (!BACKEND_BASE_URL) { ctx.warn(`[functions] BACKEND_BASE_URL not set; skipping ${path}`); return null; }
  const headers = await backendHeaders();
  const res = await axios.get(`${BACKEND_BASE_URL}${path}`, { headers, timeout: 30_000 });
  return res.data as T;
}

// ── Scheduled scan: every night at 06:00 UTC ───────────────────────────────
app.timer('scheduledScan', {
  schedule: '0 0 6 * * *',
  handler: async (_t: Timer, ctx: InvocationContext) => {
    ctx.log('[scheduledScan] starting nightly scan');
    try {
      await postJson('/api/scan/trigger', { scanType: 'full' }, ctx);
      await postJson('/api/vulnerabilities/sync', {}, ctx);
      await postJson('/api/compliance-history/snapshot', {}, ctx);
      ctx.log('[scheduledScan] complete');
    } catch (e: any) {
      ctx.error(`[scheduledScan] failed: ${e.message}`);
      throw e;
    }
  },
});

// ── Drift alert: every 6 hours ──────────────────────────────────────────────
app.timer('complianceDriftCheck', {
  schedule: '0 0 */6 * * *',
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      const kpis: any = await getJson('/api/hierarchy/kpis', ctx);
      const vulns: any = await getJson('/api/vulnerabilities/summary', ctx);
      if (!kpis) return;

      const cat1   = kpis.rollup?.catIOpen ?? 0;
      const crits  = vulns?.critical ?? 0;
      const expl   = vulns?.exploitable ?? 0;
      const breach = cat1 > DRIFT_CAT1_THRESH || crits > 0 || expl > 0;
      if (!breach) {
        ctx.log(`[drift] no breach (catI=${cat1}, critCVE=${crits})`);
        return;
      }

      const text =
        `**STIG Dashboard compliance alert**\n` +
        `- CAT I open findings: **${cat1}** (threshold ${DRIFT_CAT1_THRESH})\n` +
        `- Critical CVEs:       **${crits}**\n` +
        `- Actively-exploited:  **${expl}**\n` +
        `- Avg compliance:      **${kpis.avgComplianceScore}%**\n` +
        `- Tenants:             ${kpis.tenantCount}\n` +
        `- Machines:            ${kpis.machineCount}`;

      if (TEAMS_WEBHOOK_URL) {
        await axios.post(TEAMS_WEBHOOK_URL, { text }, { timeout: 10_000 });
        ctx.log('[drift] Teams alert sent');
      } else {
        ctx.warn(`[drift] breach detected but no TEAMS_WEBHOOK_URL configured. Payload: ${text}`);
      }
    } catch (e: any) {
      ctx.error(`[drift] failed: ${e.message}`);
    }
  },
});
