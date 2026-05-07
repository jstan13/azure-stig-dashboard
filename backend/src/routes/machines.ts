/**
 * GET  /api/machines          — list machines (paginated, filterable)
 * GET  /api/machines/:id      — machine details + control findings
 */

import { Router } from 'express';
import { mockStore } from '../database/dataSource';
import { createError } from '../middleware/errorHandler';
import { recordAudit } from '../auth';

const router = Router();
const MOCK_MODE = () => process.env.MOCK_MODE === 'true';

// GET /api/machines
router.get('/', (req, res) => {
  const { page = 1, pageSize = 20, q, status, subscriptionId, resourceGroup } = req.query;
  const p = Number(page);
  const ps = Math.min(Number(pageSize), 100);

  if (MOCK_MODE()) {
    let machines = [...mockStore.machines];

    // Filtering
    if (q) {
      const lower = String(q).toLowerCase();
      machines = machines.filter((m: any) =>
        m.name.toLowerCase().includes(lower) ||
        m.resourceGroupName.toLowerCase().includes(lower),
      );
    }
    if (status) machines = machines.filter((m: any) => m.status === status);
    if (subscriptionId) machines = machines.filter((m: any) => m.subscriptionId === subscriptionId);
    if (resourceGroup) machines = machines.filter((m: any) => m.resourceGroupName === resourceGroup);

    const total = machines.length;
    const data = machines.slice((p - 1) * ps, p * ps);
    return res.json({ data, total, page: p, pageSize: ps });
  }

  // TODO: query DB
  res.json({ data: [], total: 0, page: p, pageSize: ps });
});

// GET /api/machines/:id
router.get('/:id', (req, res, next) => {
  if (MOCK_MODE()) {
    const machine = mockStore.machines.find((m: any) => m.id === req.params.id);
    if (!machine) return next(createError('Machine not found', 404, 'NOT_FOUND'));

    const findings = mockStore.findings
      .filter((f: any) => f.machineId === machine.id)
      .map((f: any) => {
        const control = mockStore.controls.find((c: any) => c.id === f.controlId);
        return { ...f, control };
      });

    const open = findings.filter((f: any) => f.status === 'open').length;
    const notAFinding = findings.filter((f: any) => f.status === 'not_a_finding').length;
    const notApplicable = findings.filter((f: any) => f.status === 'not_applicable').length;
    const notReviewed = findings.filter((f: any) => f.status === 'not_reviewed').length;

    return res.json({
      ...machine,
      findings,
      summary: {
        total: findings.length,
        open,
        notAFinding,
        notApplicable,
        notReviewed,
        complianceScore: findings.length
          ? Math.round((notAFinding / (findings.length - notApplicable)) * 100)
          : 0,
      },
    });
  }

  // TODO: query DB
  next(createError('Machine not found', 404, 'NOT_FOUND'));
});

// PATCH /api/machines/:machineId/findings/:findingId
router.patch('/:machineId/findings/:findingId', async (req, res, next) => {
  const { status, comments, findingDetails } = req.body;

  if (MOCK_MODE()) {
    const finding = mockStore.findings.find(
      (f: any) => f.id === req.params.findingId && f.machineId === req.params.machineId,
    );
    if (!finding) return next(createError('Finding not found', 404, 'NOT_FOUND'));

    const before = {
      status: finding.status,
      comments: finding.comments,
      findingDetails: finding.findingDetails,
    };

    if (status) finding.status = status;
    if (comments !== undefined) finding.comments = comments;
    if (findingDetails !== undefined) finding.findingDetails = findingDetails;
    finding.lastUpdated = new Date().toISOString();

    // Update machine compliance score
    const machine = mockStore.machines.find((m: any) => m.id === req.params.machineId);
    if (machine) {
      const machineFIndings = mockStore.findings.filter((f: any) => f.machineId === machine.id);
      const applicable = machineFIndings.filter((f: any) => f.status !== 'not_applicable');
      const passing = machineFIndings.filter((f: any) => f.status === 'not_a_finding');
      machine.complianceScore = applicable.length
        ? Math.round((passing.length / applicable.length) * 100)
        : 0;
    }

    await recordAudit(req, {
      action: 'finding.updated',
      entityType: 'finding',
      entityId: finding.id,
      before,
      after: {
        status: finding.status,
        comments: finding.comments,
        findingDetails: finding.findingDetails,
      },
      result: 'Success',
    });

    return res.json(finding);
  }

  next(createError('Not implemented', 501));
});

export default router;
