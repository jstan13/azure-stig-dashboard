/**
 * RMF / NIST SP 800-53 Crosswalk API
 *
 * GET /api/rmf/nist-crosswalk          — STIG findings grouped by NIST control
 * GET /api/rmf/families                — NIST families with open finding counts
 * GET /api/rmf/controls/:control       — findings for a specific NIST control
 * GET /api/rmf/cci/:cci                — CCI detail + linked findings
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import {
  getAllCcis, lookupCci, getCcisByFamily, NIST_FAMILIES, NistFamily,
  mapCcisToNist, ccisToNistControls,
} from '../data/cciNistMapping';
import { sendServerError } from '../middleware/errorHandler';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// GET /api/rmf/families — family heat map data
router.get('/families', async (_req: Request, res: Response) => {
  try {
    if (isMock()) {
      return res.json(buildMockFamilySummary());
    }

    const findingRepo = AppDataSource.getRepository(FindingEntity);
    const controlRepo = AppDataSource.getRepository(ControlEntity);

    const openFindings = await findingRepo.find({ where: { status: 'open' as any }, relations: ['control'] });

    const familyCounts: Record<string, { open: number; total: number; familyName: string }> = {};
    for (const family of Object.keys(NIST_FAMILIES) as NistFamily[]) {
      familyCounts[family] = { open: 0, total: 0, familyName: NIST_FAMILIES[family] };
    }

    for (const f of openFindings) {
      const control = f.control ?? await controlRepo.findOne({ where: { id: f.controlId } });
      if (!control) continue;
      const ccis: string[] = (control as any).ccis ?? [];
      const nistEntries = mapCcisToNist(ccis);
      for (const entry of nistEntries) {
        if (entry.family in familyCounts) {
          familyCounts[entry.family].open++;
        }
      }
    }

    return res.json(Object.entries(familyCounts).map(([family, data]) => ({ family, ...data })));
  } catch (err: any) {
    return sendServerError(res, '[GET /rmf/families]', err);
  }
});

// GET /api/rmf/nist-crosswalk?status=open&machineId=x
router.get('/nist-crosswalk', async (req: Request, res: Response) => {
  try {
    const { status, machineId } = req.query;

    if (isMock()) {
      return res.json(buildMockCrosswalk());
    }

    const findingRepo = AppDataSource.getRepository(FindingEntity);
    const controlRepo = AppDataSource.getRepository(ControlEntity);

    const qb = findingRepo.createQueryBuilder('f').leftJoinAndSelect('f.control', 'c');
    if (status) qb.where('f.status = :status', { status });
    if (machineId) qb.andWhere('f.machineId = :machineId', { machineId });
    const findings = await qb.getMany();

    // Group by NIST control
    const byControl: Record<string, { control: string; familyName: string; title: string; findings: any[] }> = {};

    for (const f of findings) {
      const control = f.control ?? await controlRepo.findOne({ where: { id: f.controlId } });
      if (!control) continue;
      const ccis: string[] = (control as any).ccis ?? [];
      const nistControls = ccisToNistControls(ccis);
      for (const nc of nistControls) {
        const entry = lookupCci(ccis[0]);
        if (!byControl[nc]) {
          byControl[nc] = {
            control:    nc,
            familyName: entry?.familyName ?? nc.split('-')[0],
            title:      entry?.title ?? nc,
            findings:   [],
          };
        }
        byControl[nc].findings.push({
          findingId:    f.id,
          machineId:    f.machineId,
          severity:     f.severity,
          vulnId:       (control as any).vulnId,
          ruleTitle:    (control as any).title,
          status:       f.status,
        });
      }
    }

    const result = Object.values(byControl).sort((a, b) => b.findings.length - a.findings.length);
    return res.json(result);
  } catch (err: any) {
    return sendServerError(res, '[GET /rmf/nist-crosswalk]', err);
  }
});

// GET /api/rmf/controls/:control
router.get('/controls/:control', async (req: Request, res: Response) => {
  try {
    const { control } = req.params;
    const ccis = getAllCcis().filter((c) =>
      c.nistControl === control || c.nistControl.startsWith(`${control}(`),
    );
    return res.json({ control, families: NIST_FAMILIES, ccis });
  } catch (err: any) {
    return sendServerError(res, '[GET /rmf/controls/:control]', err);
  }
});

// GET /api/rmf/cci/:cci
router.get('/cci/:cci', async (req: Request, res: Response) => {
  try {
    const entry = lookupCci(req.params.cci);
    if (!entry) return res.status(404).json({ error: 'CCI not found' });
    return res.json(entry);
  } catch (err: any) {
    return sendServerError(res, '[GET /rmf/cci/:cci]', err);
  }
});

// ─── Mock builders ────────────────────────────────────────────────────────────

function buildMockFamilySummary() {
  return Object.entries(NIST_FAMILIES).map(([family, familyName]) => ({
    family,
    familyName,
    open:  Math.floor(Math.random() * 15),
    total: Math.floor(Math.random() * 30) + 10,
  }));
}

function buildMockCrosswalk() {
  const controls = [
    { control: 'AU-3',  familyName: 'Audit and Accountability', title: 'Content of Audit Records' },
    { control: 'AC-11', familyName: 'Access Control',           title: 'Session Lock' },
    { control: 'IA-5',  familyName: 'Identification and Authentication', title: 'Authenticator Management' },
    { control: 'CM-6',  familyName: 'Configuration Management', title: 'Configuration Settings' },
    { control: 'SI-2',  familyName: 'System and Information Integrity', title: 'Flaw Remediation' },
    { control: 'SC-8',  familyName: 'System and Communications Protection', title: 'Transmission Confidentiality and Integrity' },
  ];
  return controls.map((c) => ({
    ...c,
    findings: Array.from({ length: Math.floor(Math.random() * 8) + 1 }, (_, i) => ({
      findingId:  `mock-f-${c.control}-${i}`,
      machineId:  `mock-machine-${i % 4}`,
      severity:   ['high', 'medium', 'low'][i % 3],
      vulnId:     `V-${220000 + i}`,
      ruleTitle:  `${c.title} rule ${i + 1}`,
      status:     'open',
    })),
  }));
}

export default router;
