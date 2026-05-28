/**
 * Vulnerabilities API
 *
 *   GET  /api/vulnerabilities                — paginated list with filters
 *   GET  /api/vulnerabilities/summary        — KPI rollup (critical/high/medium/low + exploitable)
 *   POST /api/vulnerabilities/sync           — trigger Defender for Cloud sub-assessment ingest
 *   PATCH /api/vulnerabilities/:id           — change status / add note
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { VulnerabilityEntity } from '../models/Vulnerability';
import { fetchVulnerabilities } from '../connectors/vulnerabilityConnector';
import { requireRole } from '../middleware/auth';
import { recordAudit } from '../auth';
import { sendServerError } from '../middleware/errorHandler';
import { parsePage, parsePageSize } from '../utils/paging';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// ── GET /api/vulnerabilities ────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const { severity, status, machineId, exploitOnly, q, page = '1', limit = '50' } = req.query as any;
    const safeLimit = parsePageSize(limit, 50, 500);
    const skip = (parsePage(page) - 1) * safeLimit;

    let rows: any[];
    if (isMock()) {
      rows = mockStore.vulnerabilities || [];
    } else {
      rows = await AppDataSource.getRepository(VulnerabilityEntity).find();
    }

    const filtered = rows.filter((v) => {
      if (severity && v.severity !== severity) return false;
      if (status && v.status !== status) return false;
      if (machineId && v.machineId !== machineId) return false;
      if (exploitOnly === 'true' && !v.exploitAvailable) return false;
      if (q) {
        const needle = String(q).toLowerCase();
        const hay = `${v.title} ${v.cve || ''} ${v.productName || ''} ${v.description || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const sorted = filtered.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    return res.json({ data: sorted.slice(skip, skip + safeLimit), total: sorted.length });
  } catch (err: any) {
    return sendServerError(res, '[GET /vulnerabilities]', err);
  }
});

// ── GET /api/vulnerabilities/summary ────────────────────────────────────────
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const rows: any[] = isMock()
      ? mockStore.vulnerabilities || []
      : await AppDataSource.getRepository(VulnerabilityEntity).find();
    const open = rows.filter((v) => v.status === 'open');
    const tally = (sev: string) => open.filter((v) => v.severity === sev).length;
    return res.json({
      total:         rows.length,
      open:          open.length,
      critical:      tally('critical'),
      high:          tally('high'),
      medium:        tally('medium'),
      low:           tally('low'),
      exploitable:   open.filter((v) => v.exploitAvailable).length,
      uniqueCves:    new Set(open.map((v) => v.cve).filter(Boolean)).size,
      affectedHosts: new Set(open.map((v) => v.machineId)).size,
    });
  } catch (err: any) {
    return sendServerError(res, '[GET /vulnerabilities/summary]', err);
  }
});

// ── POST /api/vulnerabilities/sync ──────────────────────────────────────────
router.post('/sync', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    const subs = (process.env.AZURE_SUBSCRIPTION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const rows = await fetchVulnerabilities(subs);

    if (isMock()) {
      mockStore.vulnerabilities = rows.map((r, i) => ({
        id: `mock-vuln-${i}`,
        machineId: machineIdFromResource(r.machineResourceId),
        cve: r.cve, sourceId: r.sourceId, title: r.title,
        description: r.description, severity: r.severity, cvssScore: r.cvssScore,
        exploitAvailable: r.exploitAvailable, remediation: r.remediation,
        productName: r.productName, productVendor: r.productVendor, productVersion: r.productVersion,
        firstDetectedAt: r.firstDetectedAt, lastDetectedAt: r.lastDetectedAt,
        status: 'open', createdAt: new Date(), updatedAt: new Date(),
      }));
    } else {
      const repo = AppDataSource.getRepository(VulnerabilityEntity);
      for (const r of rows) {
        const machineId = machineIdFromResource(r.machineResourceId);
        await repo.upsert({
          machineId, cve: r.cve || undefined, sourceId: r.sourceId, title: r.title,
          description: r.description, severity: r.severity, cvssScore: r.cvssScore,
          exploitAvailable: r.exploitAvailable, remediation: r.remediation,
          productName: r.productName, productVendor: r.productVendor, productVersion: r.productVersion,
          firstDetectedAt: r.firstDetectedAt ? new Date(r.firstDetectedAt) : undefined,
          lastDetectedAt:  r.lastDetectedAt  ? new Date(r.lastDetectedAt)  : undefined,
          raw: r.raw, status: 'open',
        }, ['sourceId']);
      }
    }
    await recordAudit(req as any, {
      action: 'vulnerability.sync',
      entityType: 'vulnerability',
      entityId: 'bulk',
      after: { count: rows.length },
      result: 'Success',
    });
    return res.json({ ok: true, ingested: rows.length });
  } catch (err: any) {
    return sendServerError(res, '[POST /vulnerabilities/sync]', err, 502);
  }
});

// ── PATCH /api/vulnerabilities/:id ──────────────────────────────────────────
router.patch('/:id', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, remediation } = req.body || {};
    const allowed = ['open', 'mitigated', 'risk_accepted', 'false_positive'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    if (isMock()) {
      const row = (mockStore.vulnerabilities || []).find((v: any) => v.id === id);
      if (!row) return res.status(404).json({ error: 'vulnerability not found' });
      if (status) row.status = status;
      if (remediation !== undefined) row.remediation = remediation;
      row.updatedAt = new Date();
      await recordAudit(req as any, {
        action: 'vulnerability.update',
        entityType: 'vulnerability',
        entityId: id,
        after: { id, status },
        result: 'Success',
      });
      return res.json({ ok: true, vulnerability: row });
    }
    const repo = AppDataSource.getRepository(VulnerabilityEntity);
    await repo.update(id, { ...(status ? { status } : {}), ...(remediation !== undefined ? { remediation } : {}) });
    const updated = await repo.findOne({ where: { id } });
    if (!updated) return res.status(404).json({ error: 'vulnerability not found' });
    await recordAudit(req as any, {
      action: 'vulnerability.update',
      entityType: 'vulnerability',
      entityId: id,
      after: { id, status },
      result: 'Success',
    });
    return res.json({ ok: true, vulnerability: updated });
  } catch (err: any) {
    return sendServerError(res, '[PATCH /vulnerabilities/:id]', err);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────
function machineIdFromResource(rid: string): string {
  // Use the last segment of the ARM resourceId as our internal machineId; this
  // matches how machines are seeded from the same source.
  return (rid || '').split('/').pop() || 'unknown';
}
function severityRank(s: string): number {
  return ({ critical: 4, high: 3, medium: 2, low: 1, informational: 0 } as Record<string, number>)[s] || 0;
}

export default router;
