/**
 * Notification Service
 *
 * Sends alerts via Email (SendGrid), Microsoft Teams webhook, or Azure Monitor
 * based on registered NotificationConfig rules.
 *
 * Trigger points called from:
 *   - dscResultParser.ts   (new CAT I finding)
 *   - stigUpdateScheduler.ts (STIG updates available)
 *   - poams.ts routes      (overdue POA&M warning)
 *   - scan orchestrator    (scan complete digest)
 *
 * Required env vars (at least one channel must be configured):
 *   SENDGRID_API_KEY        — SendGrid API key for email
 *   SENDGRID_FROM_EMAIL     — sender address
 *   TEAMS_WEBHOOK_URL       — default Teams incoming webhook URL
 *   AZURE_MONITOR_WORKSPACE — Log Analytics workspace ID (optional)
 */

import axios from 'axios';
import { DataSource } from 'typeorm';
import { NotificationConfigEntity, NotificationTrigger } from '../models/NotificationConfig';
import { logger } from '../utils/logger';

export interface NotificationPayload {
  trigger: NotificationTrigger;
  title: string;
  body: string;
  severity?: string;
  resourceName?: string;
  resourceId?: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatch function
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchNotification(
  payload: NotificationPayload,
  dataSource?: DataSource,
): Promise<void> {
  const configs = await getMatchingConfigs(payload.trigger, dataSource);

  for (const cfg of configs) {
    try {
      switch (cfg.channel) {
        case 'email':          await sendEmail(cfg.destination, payload);         break;
        case 'teams_webhook':  await sendTeamsWebhook(cfg.destination, payload);  break;
        case 'azure_monitor':  await sendAzureMonitor(cfg.destination, payload);  break;
      }
    } catch (err: any) {
      logger.error(`[Notifications] Failed to send via ${cfg.channel} to ${cfg.destination}: ${err.message}`);
    }
  }

  // Also check environment-level defaults
  if (payload.trigger === 'new_cat1' || payload.trigger === 'overdue_poam') {
    const defaultWebhook = process.env.TEAMS_WEBHOOK_URL;
    if (defaultWebhook) {
      await sendTeamsWebhook(defaultWebhook, payload).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel implementations
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(to: string, p: NotificationPayload): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from   = process.env.SENDGRID_FROM_EMAIL ?? 'stig-dashboard@noreply.local';
  if (!apiKey) { logger.warn('[Notifications] SENDGRID_API_KEY not set — skipping email'); return; }

  await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    {
      personalizations: [{ to: [{ email: to }] }],
      from:    { email: from },
      subject: p.title,
      content: [{ type: 'text/html', value: buildEmailHtml(p) }],
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
  );

  logger.info(`[Notifications] Email sent to ${to}: "${p.title}"`);
}

async function sendTeamsWebhook(webhookUrl: string, p: NotificationPayload): Promise<void> {
  const color = p.severity === 'high' ? 'FF0000' : p.severity === 'medium' ? 'FF6600' : '0078D4';

  const card = {
    '@type':      'MessageCard',
    '@context':   'http://schema.org/extensions',
    summary:      p.title,
    themeColor:   color,
    title:        p.title,
    sections: [
      {
        activityTitle:    p.resourceName ?? '',
        activitySubtitle: triggerLabel(p.trigger),
        text:             p.body,
        facts: Object.entries(p.metadata ?? {}).map(([k, v]) => ({ name: k, value: String(v) })),
      },
    ],
    potentialAction: p.actionUrl
      ? [{ '@type': 'OpenUri', name: 'View in Dashboard', targets: [{ os: 'default', uri: p.actionUrl }] }]
      : [],
  };

  await axios.post(webhookUrl, card);
  logger.info(`[Notifications] Teams webhook sent: "${p.title}"`);
}

async function sendAzureMonitor(workspaceId: string, p: NotificationPayload): Promise<void> {
  // Azure Monitor Data Collector API (HTTP Data Collector)
  const body = JSON.stringify([{
    trigger:      p.trigger,
    title:        p.title,
    body:         p.body,
    severity:     p.severity ?? '',
    resourceName: p.resourceName ?? '',
    resourceId:   p.resourceId ?? '',
    timestamp:    new Date().toISOString(),
    ...p.metadata,
  }]);

  const contentLength = Buffer.byteLength(body, 'utf8');
  // Note: full implementation requires HMAC-SHA256 signing with workspace key
  // See: https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-collector-api
  logger.info(`[Notifications] Would send to Azure Monitor workspace ${workspaceId}: ${contentLength} bytes`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Digest helpers (called by scheduler)
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestSummary {
  totalMachines: number;
  avgScore: number;
  newFindings: number;
  resolvedFindings: number;
  catIOpen: number;
  overduePoams: number;
  stigUpdatesAvailable: number;
}

export async function sendDailyDigest(
  summary: DigestSummary,
  dataSource?: DataSource,
): Promise<void> {
  await dispatchNotification(
    {
      trigger:  'daily_digest',
      title:    `STIG Dashboard Daily Digest — ${new Date().toLocaleDateString()}`,
      body:     buildDigestBody(summary),
      severity: summary.catIOpen > 0 ? 'high' : 'medium',
      metadata: { ...summary },
    },
    dataSource,
  );
}

export async function sendWeeklyDigest(
  summary: DigestSummary,
  dataSource?: DataSource,
): Promise<void> {
  await dispatchNotification(
    {
      trigger:  'weekly_digest',
      title:    `STIG Dashboard Weekly Report — Week of ${new Date().toLocaleDateString()}`,
      body:     buildDigestBody(summary),
      metadata: { ...summary },
    },
    dataSource,
  );
}

export async function notifyNewCatIFinding(
  machineName: string,
  vulnId: string,
  title: string,
  dataSource?: DataSource,
): Promise<void> {
  await dispatchNotification(
    {
      trigger:      'new_cat1',
      title:        `⚠ New CAT I Finding: ${vulnId}`,
      body:         `**${machineName}** has a new unmitigated CAT I (High severity) finding:\n\n**${title}**\n\nImmediate remediation required within 30 days.`,
      severity:     'high',
      resourceName: machineName,
      metadata:     { vulnId, machineName },
    },
    dataSource,
  );
}

export async function notifyOverduePoam(
  poamId: string,
  weakness: string,
  daysOverdue: number,
  assignedToName?: string,
  dataSource?: DataSource,
): Promise<void> {
  await dispatchNotification(
    {
      trigger:  'overdue_poam',
      title:    `⚠ POA&M Overdue: ${poamId} (${daysOverdue} days)`,
      body:     `POA&M **${poamId}** is ${daysOverdue} days past its scheduled completion date.\n\n**Weakness:** ${weakness}\n**Assigned to:** ${assignedToName ?? 'Unassigned'}`,
      severity: daysOverdue > 30 ? 'high' : 'medium',
      metadata: { poamId, daysOverdue, assignedToName },
    },
    dataSource,
  );
}

export async function notifyStigUpdate(
  benchmarkTitle: string,
  installedVersion: string,
  availableVersion: string,
  dataSource?: DataSource,
): Promise<void> {
  await dispatchNotification(
    {
      trigger:  'stig_update',
      title:    `STIG Update Available: ${benchmarkTitle}`,
      body:     `A new version of **${benchmarkTitle}** is available.\n\nInstalled: **${installedVersion}**\nAvailable: **${availableVersion}**\n\nSchedule an import to stay current with DISA requirements.`,
      severity: 'medium',
      metadata: { benchmarkTitle, installedVersion, availableVersion },
    },
    dataSource,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getMatchingConfigs(
  trigger: NotificationTrigger,
  dataSource?: DataSource,
): Promise<NotificationConfigEntity[]> {
  if (!dataSource || process.env.MOCK_MODE === 'true') return [];
  try {
    return await dataSource.getRepository(NotificationConfigEntity).find({
      where: { trigger, enabled: true },
    });
  } catch { return []; }
}

function triggerLabel(t: NotificationTrigger): string {
  const m: Record<NotificationTrigger, string> = {
    new_cat1:       'New CAT I Finding',
    new_finding:    'New Finding',
    overdue_poam:   'Overdue POA&M',
    stig_update:    'STIG Update Available',
    daily_digest:   'Daily Digest',
    weekly_digest:  'Weekly Report',
    scan_complete:  'Scan Complete',
  };
  return m[t] ?? t;
}

function buildEmailHtml(p: NotificationPayload): string {
  const color = p.severity === 'high' ? '#a4262c' : p.severity === 'medium' ? '#ca5010' : '#0078d4';
  const rows = Object.entries(p.metadata ?? {})
    .map(([k, v]) => `<tr><td style="font-weight:600;padding:4px 8px;color:#605e5c">${k}</td><td style="padding:4px 8px">${v}</td></tr>`)
    .join('');
  return `
    <div style="font-family:Segoe UI,sans-serif;max-width:640px;margin:0 auto">
      <div style="background:${color};color:#fff;padding:16px 24px;border-radius:4px 4px 0 0">
        <h2 style="margin:0">${p.title}</h2>
      </div>
      <div style="background:#f3f2f1;padding:20px 24px">
        <p style="margin:0 0 12px">${p.body.replace(/\n/g, '<br>')}</p>
        ${rows ? `<table style="border-collapse:collapse;margin-top:12px">${rows}</table>` : ''}
        ${p.actionUrl ? `<p style="margin-top:16px"><a href="${p.actionUrl}" style="background:${color};color:#fff;padding:8px 16px;text-decoration:none;border-radius:4px">View in Dashboard</a></p>` : ''}
      </div>
      <div style="background:#edebe9;padding:10px 24px;font-size:12px;color:#605e5c;border-radius:0 0 4px 4px">
        Azure STIG Dashboard — ${new Date().toISOString()}
      </div>
    </div>`;
}

function buildDigestBody(s: DigestSummary): string {
  return [
    `Machines monitored: ${s.totalMachines}`,
    `Average compliance score: ${s.avgScore.toFixed(1)}%`,
    `New findings: ${s.newFindings}  |  Resolved: ${s.resolvedFindings}`,
    `Open CAT I findings: ${s.catIOpen}`,
    `Overdue POA&Ms: ${s.overduePoams}`,
    `STIG updates available: ${s.stigUpdatesAvailable}`,
  ].join('\n');
}
