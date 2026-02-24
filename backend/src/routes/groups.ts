/**
 * GET /api/groups/:id/compliance  — aggregated compliance for a resource group
 */

import { Router } from 'express';
import { mockStore } from '../database/dataSource';

const router = Router();

router.get('/:id/compliance', (req, res) => {
  const groupName = req.params.id;
  const MOCK_MODE = process.env.MOCK_MODE === 'true';

  if (MOCK_MODE) {
    const machines = mockStore.machines.filter(
      (m: any) => m.resourceGroupName === groupName,
    );

    if (!machines.length) {
      // Return all groups if id is 'all'
      if (groupName === 'all') {
        const allGroups = [...new Set(mockStore.machines.map((m: any) => m.resourceGroupName))];
        const groups = allGroups.map((rg) => {
          const rgMachines = mockStore.machines.filter((m: any) => m.resourceGroupName === rg);
          const avgScore = rgMachines.reduce((s: number, m: any) => s + m.complianceScore, 0) / rgMachines.length;
          return { resourceGroupName: rg, machineCount: rgMachines.length, avgComplianceScore: Math.round(avgScore) };
        });
        return res.json({ data: groups });
      }
      return res.json({ resourceGroupName: groupName, machineCount: 0, avgComplianceScore: 0, controls: [], machines: [] });
    }

    const machineIds = machines.map((m: any) => m.id);
    const allFindings = mockStore.findings.filter((f: any) => machineIds.includes(f.machineId));

    // Per-control rollup
    const controlRollup: Record<string, any> = {};
    for (const finding of allFindings) {
      if (!controlRollup[finding.controlId]) {
        const control = mockStore.controls.find((c: any) => c.id === finding.controlId);
        controlRollup[finding.controlId] = {
          controlId: finding.controlId,
          stigId: control?.stigId,
          title: control?.title,
          severity: control?.severity,
          open: 0, not_a_finding: 0, not_applicable: 0, not_reviewed: 0, total: 0,
        };
      }
      const rollup = controlRollup[finding.controlId];
      rollup[finding.status] = (rollup[finding.status] || 0) + 1;
      rollup.total++;
    }

    const avgScore =
      machines.reduce((s: number, m: any) => s + m.complianceScore, 0) / machines.length;

    return res.json({
      resourceGroupName: groupName,
      machineCount: machines.length,
      avgComplianceScore: Math.round(avgScore),
      machines: machines.map((m: any) => ({
        id: m.id,
        name: m.name,
        complianceScore: m.complianceScore,
        lastScanDate: m.lastScanDate,
      })),
      controls: Object.values(controlRollup),
    });
  }

  // TODO: query DB
  res.json({ resourceGroupName: groupName, machineCount: 0, avgComplianceScore: 0, controls: [], machines: [] });
});

export default router;
