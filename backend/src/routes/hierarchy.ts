/**
 * Tenant > Subscription > Resource Group > Machine hierarchy + KPI rollups.
 *
 * GET  /api/hierarchy            — full nested tree with rolled-up scores at every level
 * GET  /api/hierarchy/kpis       — global KPIs for executive overview
 * GET  /api/hierarchy/heatmap    — RG x severity counts for the heat-map
 */

import { Router } from 'express';
import { mockStore } from '../database/dataSource';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// ── shared helpers ────────────────────────────────────────────────────────────

interface RollupCounts {
  total: number;
  open: number;
  catIOpen: number;
  catIIOpen: number;
  catIIIOpen: number;
  notAFinding: number;
  notApplicable: number;
  notReviewed: number;
}

function emptyRollup(): RollupCounts {
  return {
    total: 0,
    open: 0,
    catIOpen: 0,
    catIIOpen: 0,
    catIIIOpen: 0,
    notAFinding: 0,
    notApplicable: 0,
    notReviewed: 0,
  };
}

function severityToCat(sev: string): 'I' | 'II' | 'III' {
  // STIG severity → CAT mapping (DISA convention)
  if (sev === 'high')   return 'I';
  if (sev === 'medium') return 'II';
  return 'III';
}

function tallyFindings(findings: any[]): RollupCounts {
  const r = emptyRollup();
  for (const f of findings) {
    r.total++;
    if (f.status === 'open') {
      r.open++;
      const cat = severityToCat(f.severity);
      if (cat === 'I')   r.catIOpen++;
      if (cat === 'II')  r.catIIOpen++;
      if (cat === 'III') r.catIIIOpen++;
    } else if (f.status === 'not_a_finding') {
      r.notAFinding++;
    } else if (f.status === 'not_applicable') {
      r.notApplicable++;
    } else {
      r.notReviewed++;
    }
  }
  return r;
}

function avgScore(machines: any[]): number {
  if (!machines.length) return 0;
  return Math.round(machines.reduce((s, m) => s + (m.complianceScore || 0), 0) / machines.length);
}

// ── GET /api/hierarchy ────────────────────────────────────────────────────────
// Returns:
//   {
//     tenants: [{ id, name, subscriptionCount, machineCount, avgScore, rollup,
//       subscriptions: [{ id, name, machineCount, avgScore, rollup,
//         resourceGroups: [{ name, machineCount, avgScore, rollup,
//           machines: [{ id, name, osType, location, complianceScore, status, rollup }]
//         }]
//       }]
//     }]
//   }
router.get('/', (_req, res) => {
  if (!isMock()) {
    // TODO: Postgres aggregation query. For now, return empty shell.
    return res.json({ tenants: [] });
  }

  const machines = mockStore.machines;
  const findingsByMachine: Record<string, any[]> = {};
  for (const f of mockStore.findings) {
    (findingsByMachine[f.machineId] ||= []).push(f);
  }

  // Group by tenant -> subscription -> resourceGroup -> machine
  const tenantMap = new Map<string, any>();

  for (const m of machines) {
    const tenantId = m.tenantId || 'unknown';
    const tenantName = m.tenantName || 'Unknown Tenant';
    let tenant = tenantMap.get(tenantId);
    if (!tenant) {
      tenant = { id: tenantId, name: tenantName, subscriptionMap: new Map<string, any>() };
      tenantMap.set(tenantId, tenant);
    }

    let sub = tenant.subscriptionMap.get(m.subscriptionId);
    if (!sub) {
      sub = {
        id: m.subscriptionId,
        name: m.subscriptionName || m.subscriptionId,
        rgMap: new Map<string, any>(),
      };
      tenant.subscriptionMap.set(m.subscriptionId, sub);
    }

    let rg = sub.rgMap.get(m.resourceGroupName);
    if (!rg) {
      rg = { name: m.resourceGroupName, machines: [] };
      sub.rgMap.set(m.resourceGroupName, rg);
    }

    rg.machines.push({
      ...m,
      rollup: tallyFindings(findingsByMachine[m.id] || []),
    });
  }

  // Materialize + roll up
  const tenants = Array.from(tenantMap.values()).map((t) => {
    const subscriptions = Array.from(t.subscriptionMap.values()).map((s: any) => {
      const resourceGroups = Array.from(s.rgMap.values()).map((rg: any) => {
        const findings = rg.machines.flatMap((m: any) =>
          (findingsByMachine[m.id] || []),
        );
        return {
          name: rg.name,
          machineCount: rg.machines.length,
          avgScore: avgScore(rg.machines),
          rollup: tallyFindings(findings),
          machines: rg.machines.map((m: any) => ({
            id: m.id,
            name: m.name,
            osType: m.osType,
            osVersion: m.osVersion,
            location: m.location,
            status: m.status,
            complianceScore: m.complianceScore,
            lastScanDate: m.lastScanDate,
            resourceId: m.resourceId,
            rollup: m.rollup,
          })),
        };
      });
      const subMachines = resourceGroups.flatMap((rg: any) => rg.machines);
      const subFindings = subMachines.flatMap((m: any) => findingsByMachine[m.id] || []);
      return {
        id: s.id,
        name: s.name,
        machineCount: subMachines.length,
        avgScore: avgScore(subMachines),
        rollup: tallyFindings(subFindings),
        resourceGroups,
      };
    });

    const tMachines = subscriptions.flatMap((s: any) =>
      s.resourceGroups.flatMap((rg: any) => rg.machines),
    );
    const tFindings = tMachines.flatMap((m: any) => findingsByMachine[m.id] || []);
    return {
      id: t.id,
      name: t.name,
      subscriptionCount: subscriptions.length,
      machineCount: tMachines.length,
      avgScore: avgScore(tMachines),
      rollup: tallyFindings(tFindings),
      subscriptions,
    };
  });

  res.json({ tenants });
});

// ── GET /api/hierarchy/kpis ───────────────────────────────────────────────────
router.get('/kpis', (_req, res) => {
  if (!isMock()) {
    return res.json({
      tenantCount: 0,
      subscriptionCount: 0,
      resourceGroupCount: 0,
      machineCount: 0,
      avgComplianceScore: 0,
      machinesBelow80: 0,
      rollup: emptyRollup(),
      lastScanAt: null,
    });
  }

  const machines = mockStore.machines;
  const findings = mockStore.findings;
  const tenants  = new Set(machines.map((m: any) => m.tenantId).filter(Boolean));
  const subs     = new Set(machines.map((m: any) => m.subscriptionId));
  const rgs      = new Set(machines.map((m: any) => `${m.subscriptionId}/${m.resourceGroupName}`));
  const lastScan = machines
    .map((m: any) => m.lastScanDate)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  res.json({
    tenantCount: tenants.size,
    subscriptionCount: subs.size,
    resourceGroupCount: rgs.size,
    machineCount: machines.length,
    avgComplianceScore: avgScore(machines),
    machinesBelow80: machines.filter((m: any) => (m.complianceScore || 0) < 80).length,
    rollup: tallyFindings(findings),
    lastScanAt: lastScan || null,
  });
});

// ── GET /api/hierarchy/heatmap ────────────────────────────────────────────────
// Returns a grid of [{ scope: "<sub>/<rg>", subscriptionName, resourceGroup, catI, catII, catIII, machines }]
router.get('/heatmap', (_req, res) => {
  if (!isMock()) return res.json({ cells: [] });

  const findingsByMachine: Record<string, any[]> = {};
  for (const f of mockStore.findings) {
    (findingsByMachine[f.machineId] ||= []).push(f);
  }
  const cellMap = new Map<string, any>();
  for (const m of mockStore.machines) {
    const key = `${m.subscriptionId}/${m.resourceGroupName}`;
    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        scope: key,
        tenantName: m.tenantName,
        subscriptionId: m.subscriptionId,
        subscriptionName: m.subscriptionName,
        resourceGroup: m.resourceGroupName,
        machines: 0,
        catI: 0, catII: 0, catIII: 0,
      };
      cellMap.set(key, cell);
    }
    cell.machines++;
    const r = tallyFindings(findingsByMachine[m.id] || []);
    cell.catI  += r.catIOpen;
    cell.catII += r.catIIOpen;
    cell.catIII += r.catIIIOpen;
  }
  res.json({ cells: Array.from(cellMap.values()) });
});

export default router;
