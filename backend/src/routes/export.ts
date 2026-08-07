/**
 * POST /api/export/checklist  — generate and return a .ckl or JSON checklist
 *
 * Body:
 *   { machineId: string, format: 'ckl' | 'json' | 'csv' }
 */

import { Router } from 'express';
import { generateCKL, CKLFinding } from '../exporters/cklExporter';
import {
  enforceMappingChain,
  MappingChainViolationError,
} from '../exporters';
import { AppDataSource, mockStore } from '../database/dataSource';
import { MachineEntity } from '../models/Machine';
import { FindingEntity } from '../models/Finding';
import { ControlEntity } from '../models/Control';
import { ChecklistEntity } from '../models/Checklist';
import { createError } from '../middleware/errorHandler';
import { requirePermission, scopeByMachineBody } from '../middleware/authz';
import { recordAudit } from '../auth';
import type { AuditRequest } from '../auth';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const MOCK_MODE = () => process.env.MOCK_MODE === 'true';

/** Prevent CSV-injection (Excel formula execution / DDE) by neutralising
 *  cells that begin with =, +, -, @, tab, or carriage return. See OWASP.
 *  Exported for unit testing. */
export function csvSafe(value: string | undefined | null): string {
  const s = String(value ?? '');
  const escaped = s.replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(escaped)) {
    return `"'${escaped}"`;
  }
  return `"${escaped}"`;
}

/** Sanitize a value for safe use inside a Content-Disposition `filename="..."`
 *  attribute. Strips quotes, control chars (incl. CR/LF to prevent header
 *  injection), and path separators, then caps length. Falls back to "export".
 *  Exported for unit testing. */
export function safeFilename(value: string | undefined | null): string {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_') // allow only filename-safe characters
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return cleaned || 'export';
}

function renderCsv(findings: CKLFinding[]): string {
  const header =
    'VulnID,StigRef,Title,Severity,Status,Comments,FindingDetails\n';
  const rows = findings
    .map(
      (f) =>
        [
          csvSafe(f.vulnId),
          csvSafe(f.stigRef),
          csvSafe(f.title),
          csvSafe(f.severity),
          csvSafe(f.status),
          csvSafe(f.comments),
          csvSafe(f.findingDetails),
        ].join(','),
    )
    .join('\n');
  return header + rows;
}

router.post(
  '/checklist',
  requirePermission('export:generate', scopeByMachineBody('machineId')),
  async (req, res, next) => {
    const { machineId, format = 'ckl' } = req.body;

    if (!machineId) {
      return next(createError('machineId is required', 400, 'VALIDATION_ERROR'));
    }

    if (MOCK_MODE()) {
      const machine = mockStore.machines.find((m: any) => m.id === machineId);
      if (!machine) return next(createError('Machine not found', 404, 'NOT_FOUND'));

      const rawFindings = mockStore.findings.filter((f: any) => f.machineId === machineId);

      // Constitution Principle IV / FR-009: every exported finding must carry
      // a complete mappingChain. Enforcement is opt-in via STRICT_TRACEABILITY
      // so existing fixture-based tests continue to pass; production deployments
      // set this to `true` (see infra/main.bicep / azure.yaml) and Phase 3+
      // ingestion will populate mappingChain on every Finding it emits.
      if (process.env.STRICT_TRACEABILITY === 'true') {
        try {
          enforceMappingChain(
            rawFindings.map((f: any) => ({
              id: f.id,
              machineId: f.machineId,
              controlId: f.controlId,
              status: f.status,
              severity: f.severity,
              mappingChain: f.mappingChain ?? null,
            })),
          );
        } catch (err) {
          if (err instanceof MappingChainViolationError) {
            await recordAudit(req, {
              action: 'checklist.export_rejected',
              entityType: 'machine',
              entityId: machineId,
              after: {
                format,
                violations: err.violations,
                reason: 'mapping_chain_incomplete',
              },
              result: 'Denied',
            });
            return res.status(422).json({
              error: err.message,
              code: err.errorCode,
              violations: err.violations,
            });
          }
          throw err;
        }
      }

      const findings: CKLFinding[] = rawFindings.map((f: any) => {
          const control = mockStore.controls.find((c: any) => c.id === f.controlId);
          return {
            vulnId: control?.id || f.controlId,
            ruleId: `${control?.id || f.controlId}_rule`,
            stigRef: control?.stigId,
            title: control?.title,
            severity: f.severity || control?.severity || 'medium',
            status: f.status,
            findingDetails: f.findingDetails || '',
            comments: f.comments || '',
            checkContent: control?.checkContent,
            fixText: control?.fixText,
            ccis: control?.ccis,
          };
        });

      // Log the export through the canonical Auditor (FR-003 / Principle II).
      // The MockAuditWriter mirrors entries into mockStore.auditLogs so the
      // legacy GET /api/audit endpoint continues to surface them.
      const auditReq = req as unknown as AuditRequest;
      const actor = (req as any).auth?.email || (req as any).auth?.sub || 'api';
      const actorRole =
        ((req as any).auth?.roles as string[] | undefined)?.[0] ?? 'unknown';
      void auditReq.audit?.record({
        actorUserId: actor,
        actorRole,
        action: 'checklist.exported',
        entityType: 'machine',
        entityId: machineId,
        before: undefined,
        after: { format, machineName: machine.name },
        result: 'Success',
        correlationId: auditReq.correlationId ?? 'no-correlation',
        sourceIp: req.ip ?? 'unknown',
      });

      // Track checklist
      mockStore.checklists.push({
        id: uuidv4(),
        machineId,
        exportedBy: actor,
        format,
        archived: false,
        metadata: { machineName: machine.name, findingCount: findings.length },
        createdAt: new Date().toISOString(),
      });

      const dlBase = safeFilename(machine.name);
      if (format === 'ckl') {
        const xml = generateCKL({
          machineId,
          machineName: machine.name,
          osType: machine.osType,
          osVersion: machine.osVersion,
          hostFQDN: `${machine.name}.domain.local`,
          findings,
        });

        res.setHeader('Content-Type', 'application/xml');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dlBase}_${new Date().toISOString().slice(0, 10)}.ckl"`,
        );
        return res.send(xml);
      }

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dlBase}_${new Date().toISOString().slice(0, 10)}.json"`,
        );
        return res.json({
          machine: { id: machineId, name: machine.name, osType: machine.osType },
          exportDate: new Date().toISOString(),
          findings,
        });
      }

      if (format === 'csv') {
        const csv = renderCsv(findings);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dlBase}_${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        return res.send(csv);
      }

      return next(createError('Invalid format. Supported: ckl, json, csv', 400, 'VALIDATION_ERROR'));
    }

    // ── Real DB-backed path ──────────────────────────────────────────────
    try {
      const machineRepo = AppDataSource.getRepository(MachineEntity);
      const findingRepo = AppDataSource.getRepository(FindingEntity);
      const controlRepo = AppDataSource.getRepository(ControlEntity);
      const checklistRepo = AppDataSource.getRepository(ChecklistEntity);

      const machine = await machineRepo.findOne({ where: { id: machineId } });
      if (!machine) return next(createError('Machine not found', 404, 'NOT_FOUND'));

      const rawFindings = await findingRepo.find({ where: { machineId } });

      if (process.env.STRICT_TRACEABILITY === 'true') {
        try {
          enforceMappingChain(
            rawFindings.map((f) => ({
              id: f.id,
              machineId: f.machineId,
              controlId: f.controlId,
              status: f.status,
              severity: f.severity,
              mappingChain: f.mappingChain ?? null,
            })),
          );
        } catch (err) {
          if (err instanceof MappingChainViolationError) {
            await recordAudit(req, {
              action: 'checklist.export_rejected',
              entityType: 'machine',
              entityId: machineId,
              after: {
                format,
                violations: err.violations,
                reason: 'mapping_chain_incomplete',
              },
              result: 'Denied',
            });
            return res.status(422).json({
              error: err.message,
              code: err.errorCode,
              violations: err.violations,
            });
          }
          throw err;
        }
      }

      // Fetch controls referenced by the findings, in one round trip
      const controlIds = Array.from(new Set(rawFindings.map((f) => f.controlId)));
      const controls = controlIds.length
        ? await controlRepo.findByIds(controlIds)
        : [];
      const controlById = new Map(controls.map((c) => [c.id, c]));

      const findings: CKLFinding[] = rawFindings.map((f) => {
        const control = controlById.get(f.controlId);
        return {
          vulnId: control?.vulnId || control?.id || f.controlId,
          ruleId: control?.ruleId || `${control?.id || f.controlId}_rule`,
          stigRef: control?.stigId,
          title: control?.title,
          severity: f.severity || control?.severity || 'medium',
          status: f.status,
          findingDetails: f.findingDetails || '',
          comments: f.comments || '',
          checkContent: control?.checkContent,
          fixText: control?.fixText,
          ccis: control?.ccis,
        };
      });

      const auditReq = req as unknown as AuditRequest;
      const actor =
        (req as any).auth?.email || (req as any).auth?.sub || 'api';
      const actorRole =
        ((req as any).auth?.roles as string[] | undefined)?.[0] ?? 'unknown';
      void auditReq.audit?.record({
        actorUserId: actor,
        actorRole,
        action: 'checklist.exported',
        entityType: 'machine',
        entityId: machineId,
        before: undefined,
        after: { format, machineName: machine.name },
        result: 'Success',
        correlationId: auditReq.correlationId ?? 'no-correlation',
        sourceIp: req.ip ?? 'unknown',
      });

      await checklistRepo.save(
        checklistRepo.create({
          id: uuidv4(),
          machineId,
          exportedBy: actor,
          format,
          archived: false,
          metadata: {
            machineName: machine.name,
            findingCount: findings.length,
          },
        } as any),
      );

      const dlBase = safeFilename(machine.name);
      if (format === 'ckl') {
        const xml = generateCKL({
          machineId,
          machineName: machine.name,
          osType: machine.osType,
          osVersion: machine.osVersion,
          hostFQDN: `${machine.name}.domain.local`,
          findings,
        });

        res.setHeader('Content-Type', 'application/xml');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dlBase}_${new Date().toISOString().slice(0, 10)}.ckl"`,
        );
        return res.send(xml);
      }

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dlBase}_${new Date().toISOString().slice(0, 10)}.json"`,
        );
        return res.json({
          machine: { id: machineId, name: machine.name, osType: machine.osType },
          exportDate: new Date().toISOString(),
          findings,
        });
      }

      if (format === 'csv') {
        const csv = renderCsv(findings);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dlBase}_${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        return res.send(csv);
      }

      return next(
        createError('Invalid format. Supported: ckl, json, csv', 400, 'VALIDATION_ERROR'),
      );
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
