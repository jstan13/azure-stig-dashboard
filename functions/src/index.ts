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
const BUSINESS_HOURS_MODE = String(process.env.BUSINESS_HOURS_MODE || 'false').toLowerCase() === 'true';
const BUSINESS_HOURS_TZ = process.env.BUSINESS_HOURS_TIME_ZONE || 'UTC';
const BUSINESS_HOURS_START = Number(process.env.BUSINESS_HOURS_START_HOUR || 8);
const BUSINESS_HOURS_END = Number(process.env.BUSINESS_HOURS_END_HOUR || 18);
const BUSINESS_HOURS_AUTO_SHUTDOWN = String(process.env.BUSINESS_HOURS_AUTO_SHUTDOWN || 'false').toLowerCase() === 'true';
const ARM_ENDPOINT = (process.env.AZURE_ARM_ENDPOINT || 'https://management.azure.com').replace(/\/$/, '');
const BACKEND_APP_RESOURCE_ID = process.env.BACKEND_APP_RESOURCE_ID || '';
const FRONTEND_APP_RESOURCE_ID = process.env.FRONTEND_APP_RESOURCE_ID || '';
const POSTGRES_SERVER_RESOURCE_ID = process.env.POSTGRES_SERVER_RESOURCE_ID || '';
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
const UPDATE_REPO = process.env.UPDATE_SOURCE_REPO || 'jstan13/azure-stig-dashboard';
const WEB_API_VERSION = '2023-01-01';
// Small deployments get this Function App solely to install updates. Scanning
// stays off there, so the flag is separate from whether the app exists at all.
const SCHEDULED_SCAN_ENABLED = String(process.env.SCHEDULED_SCAN_ENABLED ?? 'true').toLowerCase() !== 'false';

function getBusinessHourNow(date = new Date()): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_HOURS_TZ,
    hour: '2-digit',
    hour12: false,
  }).format(date);

  return Number(formatted);
}

function isWithinBusinessHours(date = new Date()): boolean {
  if (!BUSINESS_HOURS_MODE) return true;
  const hour = getBusinessHourNow(date);

  if (BUSINESS_HOURS_START === BUSINESS_HOURS_END) {
    return true;
  }

  if (BUSINESS_HOURS_START < BUSINESS_HOURS_END) {
    return hour >= BUSINESS_HOURS_START && hour < BUSINESS_HOURS_END;
  }

  return hour >= BUSINESS_HOURS_START || hour < BUSINESS_HOURS_END;
}

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

async function armHeaders(): Promise<Record<string, string>> {
  const { DefaultAzureCredential } = await import('@azure/identity');
  const cred = new DefaultAzureCredential();
  const token = await cred.getToken(`${ARM_ENDPOINT}/.default`);
  if (!token) throw new Error('Unable to acquire ARM token for scheduler operations');
  return { Authorization: `Bearer ${token.token}` };
}

async function callArmAction(resourceId: string, action: 'start' | 'stop', apiVersion: string, ctx: InvocationContext): Promise<void> {
  if (!resourceId) return;
  const headers = await armHeaders();
  const url = `${ARM_ENDPOINT}${resourceId}/${action}?api-version=${apiVersion}`;
  const res = await axios.post(url, {}, { headers, timeout: 60_000 });
  ctx.log(`[functions] ARM ${action} ${resourceId} -> ${res.status}`);
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

async function postJsonForResult<T = any>(
  path: string, body: unknown, ctx: InvocationContext,
): Promise<T | null> {
  if (!BACKEND_BASE_URL) {
    ctx.warn(`[functions] BACKEND_BASE_URL not set; skipping ${path}`);
    return null;
  }
  const headers = await backendHeaders();
  const res = await axios.post(`${BACKEND_BASE_URL}${path}`, body, { headers, timeout: 60_000 });
  ctx.log(`[functions] POST ${path} -> ${res.status}`);
  return res.data as T;
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
    if (!SCHEDULED_SCAN_ENABLED) {
      ctx.log('[scheduledScan] skipped (scheduled scanning is disabled)');
      return;
    }
    if (!isWithinBusinessHours()) {
      const hour = getBusinessHourNow();
      ctx.log(`[scheduledScan] skipped (outside business hours, hour=${hour}, tz=${BUSINESS_HOURS_TZ})`);
      return;
    }

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
    if (!SCHEDULED_SCAN_ENABLED) {
      ctx.log('[drift] skipped (scheduled scanning is disabled)');
      return;
    }
    if (!isWithinBusinessHours()) {
      const hour = getBusinessHourNow();
      ctx.log(`[drift] skipped (outside business hours, hour=${hour}, tz=${BUSINESS_HOURS_TZ})`);
      return;
    }

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

app.timer('businessHoursAutoStart', {
  schedule: '%BUSINESS_HOURS_START_CRON%',
  handler: async (_t: Timer, ctx: InvocationContext) => {
    if (!BUSINESS_HOURS_MODE || !BUSINESS_HOURS_AUTO_SHUTDOWN) {
      ctx.log('[businessHoursAutoStart] disabled');
      return;
    }

    await callArmAction(POSTGRES_SERVER_RESOURCE_ID, 'start', '2023-06-01-preview', ctx);
    await callArmAction(BACKEND_APP_RESOURCE_ID, 'start', '2023-01-01', ctx);
    await callArmAction(FRONTEND_APP_RESOURCE_ID, 'start', '2023-01-01', ctx);
  },
});

app.timer('businessHoursAutoShutdown', {
  schedule: '%BUSINESS_HOURS_STOP_CRON%',
  handler: async (_t: Timer, ctx: InvocationContext) => {
    if (!BUSINESS_HOURS_MODE || !BUSINESS_HOURS_AUTO_SHUTDOWN) {
      ctx.log('[businessHoursAutoShutdown] disabled');
      return;
    }

    await callArmAction(BACKEND_APP_RESOURCE_ID, 'stop', '2023-01-01', ctx);
    await callArmAction(FRONTEND_APP_RESOURCE_ID, 'stop', '2023-01-01', ctx);
    await callArmAction(POSTGRES_SERVER_RESOURCE_ID, 'stop', '2023-06-01-preview', ctx);
  },
});

// ── Auto-update ─────────────────────────────────────────────────────────────
// The backend cannot install its own update: swapping the image kills the
// process mid-flight, leaving nobody to check health or undo the change. This
// runs outside both web apps precisely so it survives to roll them back.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReleaseInfo { version: string; notes: string }

async function latestRelease(ctx: InvocationContext): Promise<ReleaseInfo | null> {
  const res = await axios.get(
    `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
    {
      timeout: 30_000,
      headers: { Accept: 'application/vnd.github+json' },
      validateStatus: (s) => s === 200 || s === 404,
    },
  );
  if (res.status === 404) { ctx.warn('[autoUpdate] no published releases'); return null; }
  const version = String(res.data?.tag_name ?? '');
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    ctx.warn(`[autoUpdate] ignoring unrecognised tag '${version}'`);
    return null;
  }
  return { version, notes: String(res.data?.body ?? '').slice(0, 20_000) };
}

/** Container images a given release pins, read from its published template. */
async function imagesForRelease(
  version: string,
): Promise<{ backend: string; frontend: string }> {
  const url = `https://raw.githubusercontent.com/${UPDATE_REPO}/deploy-templates/${version}/azuredeploy.json`;
  const res = await axios.get(url, { timeout: 30_000 });
  const params = res.data?.parameters ?? {};
  const backend = String(params.backendImage?.defaultValue ?? '');
  const frontend = String(params.frontendImage?.defaultValue ?? '');
  if (!backend || !frontend) throw new Error(`Release ${version} does not pin container images`);
  return { backend, frontend };
}

interface WebAppRuntimeConfig {
  linuxFxVersion: string;
  appCommandLine: string;
}

async function getWebAppRuntimeConfig(resourceId: string): Promise<WebAppRuntimeConfig> {
  const headers = await armHeaders();
  const url = `${ARM_ENDPOINT}${resourceId}/config/web?api-version=${WEB_API_VERSION}`;
  const res = await axios.get(url, { headers, timeout: 60_000 });
  return {
    linuxFxVersion: String(res.data?.properties?.linuxFxVersion ?? ''),
    appCommandLine: String(res.data?.properties?.appCommandLine ?? ''),
  };
}

async function setWebAppRuntimeConfig(
  resourceId: string, config: WebAppRuntimeConfig, ctx: InvocationContext,
): Promise<void> {
  const headers = await armHeaders();
  const url = `${ARM_ENDPOINT}${resourceId}/config/web?api-version=${WEB_API_VERSION}`;
  const res = await axios.patch(
    url, { properties: config }, { headers, timeout: 120_000 },
  );
  ctx.log(`[autoUpdate] set runtime on ${resourceId} -> ${res.status}`);
}

/** Waits for sustained health; one lucky 200 during a swap proves nothing. */
async function waitForHealth(
  url: string, ctx: InvocationContext, timeoutMs = 420_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(url, { timeout: 20_000, validateStatus: () => true });
      if (res.status >= 200 && res.status < 400) {
        if (++consecutive >= 3) return true;
      } else {
        consecutive = 0;
      }
    } catch {
      consecutive = 0;
    }
    await sleep(10_000);
  }
  ctx.warn(`[autoUpdate] ${url} never became healthy`);
  return false;
}

async function reportResult(
  version: string,
  previousVersion: string | null,
  result: 'succeeded' | 'rolled_back' | 'failed',
  detail: string,
  ctx: InvocationContext,
): Promise<void> {
  try {
    await postJson('/api/updates/result', { version, previousVersion, result, detail }, ctx);
  } catch (e: any) {
    ctx.error(`[autoUpdate] could not report '${result}' for ${version}: ${e.message}`);
  }
}

async function installRelease(version: string, ctx: InvocationContext): Promise<void> {
  if (!BACKEND_APP_RESOURCE_ID || !FRONTEND_APP_RESOURCE_ID) {
    ctx.error('[autoUpdate] app resource IDs missing; refusing to update');
    return;
  }

  const previous = {
    backend: await getWebAppRuntimeConfig(BACKEND_APP_RESOURCE_ID),
    frontend: await getWebAppRuntimeConfig(FRONTEND_APP_RESOURCE_ID),
  };
  const previousVersion = process.env.RELEASE_TAG || null;

  // Database migrations are forward-only, so the restore point is a timestamp
  // an operator can rewind to by hand. Rolling the image back is automatic;
  // rolling the schema back never should be.
  const restorePoint = new Date().toISOString();
  ctx.log(`[autoUpdate] installing ${version}; PITR restore point ${restorePoint}`);

  let images: { backend: string; frontend: string };
  try {
    images = await imagesForRelease(version);
  } catch (e: any) {
    await reportResult(version, previousVersion, 'failed', e.message, ctx);
    return;
  }

  try {
    await setWebAppRuntimeConfig(BACKEND_APP_RESOURCE_ID, {
      linuxFxVersion: `DOCKER|${images.backend}`,
      appCommandLine: '',
    }, ctx);
    await setWebAppRuntimeConfig(FRONTEND_APP_RESOURCE_ID, {
      linuxFxVersion: `DOCKER|${images.frontend}`,
      appCommandLine: '',
    }, ctx);
  } catch (e: any) {
    ctx.error(`[autoUpdate] swap failed: ${e.message}`);
    await rollback(previous, version, previousVersion, `swap failed: ${e.message}`, ctx);
    return;
  }

  // App Service reports the old container healthy for a few seconds after the
  // PATCH, so settle before believing anything.
  await sleep(45_000);

  const backendOk = await waitForHealth(`${BACKEND_BASE_URL}/health`, ctx);
  const frontendOk = backendOk && FRONTEND_BASE_URL
    ? await waitForHealth(`${FRONTEND_BASE_URL}/`, ctx)
    : backendOk;

  if (backendOk && frontendOk) {
    ctx.log(`[autoUpdate] ${version} healthy`);
    await reportResult(
      version, previousVersion, 'succeeded',
      `Installed ${version}. PITR restore point ${restorePoint}.`, ctx,
    );
    return;
  }

  await rollback(
    previous, version, previousVersion,
    `health checks failed after installing ${version}; PITR restore point ${restorePoint}`,
    ctx,
  );
}

async function rollback(
  previous: { backend: WebAppRuntimeConfig; frontend: WebAppRuntimeConfig },
  version: string,
  previousVersion: string | null,
  detail: string,
  ctx: InvocationContext,
): Promise<void> {
  ctx.error(`[autoUpdate] rolling back: ${detail}`);
  try {
    if (previous.backend.linuxFxVersion) {
      await setWebAppRuntimeConfig(BACKEND_APP_RESOURCE_ID, previous.backend, ctx);
    }
    if (previous.frontend.linuxFxVersion) {
      await setWebAppRuntimeConfig(FRONTEND_APP_RESOURCE_ID, previous.frontend, ctx);
    }
    await sleep(45_000);
    await waitForHealth(`${BACKEND_BASE_URL}/health`, ctx);
    await reportResult(version, previousVersion, 'rolled_back', detail, ctx);
  } catch (e: any) {
    ctx.error(`[autoUpdate] rollback itself failed: ${e.message}`);
    await reportResult(
      version, previousVersion, 'failed',
      `${detail}; rollback also failed: ${e.message}`, ctx,
    );
  }
}

app.timer('autoUpdate', {
  schedule: '0 */20 * * * *',
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      const release = await latestRelease(ctx);
      if (!release) return;

      // The backend owns the policy, so it decides; this only carries it out.
      const decision = await postJsonForResult<{ nextAction?: { action: string; version?: string; reason?: string } }>(
        '/api/updates/available',
        { version: release.version, notes: release.notes },
        ctx,
      );
      const next = decision?.nextAction;
      if (!next) return;

      if (next.action !== 'install' || !next.version) {
        ctx.log(`[autoUpdate] no install (${next.action}: ${next.reason})`);
        return;
      }
      await installRelease(next.version, ctx);
    } catch (e: any) {
      ctx.error(`[autoUpdate] failed: ${e.message}`);
    }
  },
});
