/**
 * GET /api/groups/:id/compliance  — aggregated compliance for a resource group
 */

import { Router } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { MachineEntity } from '../models/Machine';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { In } from 'typeorm';

const router = Router();

router.get('/:id/compliance', async (req, res, next) => {
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

  // ── Real DB-backed path ──────────────────────────────────────────────────
  try {
    const machineRepo = AppDataSource.getRepository(MachineEntity);
    const findingRepo = AppDataSource.getRepository(FindingEntity);
    const controlRepo = AppDataSource.getRepository(ControlEntity);

    // "all" → list every distinct resource group with rolled-up scores
    if (groupName === 'all') {
      const machines = await machineRepo.find();
      const byRg = new Map<string, MachineEntity[]>();
      for (const m of machines) {
        if (!byRg.has(m.resourceGroupName)) byRg.set(m.resourceGroupName, []);
        byRg.get(m.resourceGroupName)!.push(m);
      }
      const groups = Array.from(byRg.entries()).map(([rg, ms]) => ({
        resourceGroupName: rg,
        machineCount: ms.length,
        avgComplianceScore: Math.round(
          ms.reduce((s, m) => s + (m.complianceScore || 0), 0) / ms.length,
        ),
      }));
      return res.json({ data: groups });
    }

    const machines = await machineRepo.find({
      where: { resourceGroupName: groupName },
    });
    if (!machines.length) {
      return res.json({
        resourceGroupName: groupName,
        machineCount: 0,
        avgComplianceScore: 0,
        controls: [],
        machines: [],
      });
    }
    const machineIds = machines.map((m) => m.id);
    const allFindings = await findingRepo.find({
      where: { machineId: In(machineIds) },
    });
    const controlIds = Array.from(new Set(allFindings.map((f) => f.controlId)));
    const controls = controlIds.length
      ? await controlRepo.findByIds(controlIds)
      : [];
    const controlById = new Map(controls.map((c) => [c.id, c]));

    const controlRollup: Record<string, any> = {};
    for (const f of allFindings) {
      const ctrl = controlById.get(f.controlId);
      if (!controlRollup[f.controlId]) {
        controlRollup[f.controlId] = {
          controlId: f.controlId,
          stigId: ctrl?.stigId,
          title: ctrl?.title,
          severity: ctrl?.severity,
          open: 0,
          not_a_finding: 0,
          not_applicable: 0,
          not_reviewed: 0,
          total: 0,
        };
      }
      const r = controlRollup[f.controlId];
      r[f.status] = (r[f.status] || 0) + 1;
      r.total++;
    }

    const avgScore = Math.round(
      machines.reduce((s, m) => s + (m.complianceScore || 0), 0) / machines.length,
    );

    res.json({
      resourceGroupName: groupName,
      machineCount: machines.length,
      avgComplianceScore: avgScore,
      machines: machines.map((m) => ({
        id: m.id,
        name: m.name,
        complianceScore: m.complianceScore,
        lastScanDate: m.lastScanDate,
      })),
      controls: Object.values(controlRollup),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
