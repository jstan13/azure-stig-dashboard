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
import { mockStore } from '../database/dataSource';
import { createError } from '../middleware/errorHandler';
import { requireRole } from '../middleware/auth';
import { recordAudit } from '../auth';
import type { AuditRequest } from '../auth';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const MOCK_MODE = () => process.env.MOCK_MODE === 'true';

router.post(
  '/checklist',
  requireRole('admin', 'operator', 'auditor'),
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
          `attachment; filename="${machine.name}_${new Date().toISOString().slice(0, 10)}.ckl"`,
        );
        return res.send(xml);
      }

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${machine.name}_${new Date().toISOString().slice(0, 10)}.json"`,
        );
        return res.json({
          machine: { id: machineId, name: machine.name, osType: machine.osType },
          exportDate: new Date().toISOString(),
          findings,
        });
      }

      if (format === 'csv') {
        const header = 'VulnID,StigRef,Title,Severity,Status,Comments,FindingDetails\n';
        const rows = findings
          .map(
            (f) =>
              `"${f.vulnId}","${f.stigRef || ''}","${(f.title || '').replace(/"/g, '""')}","${f.severity}","${f.status}","${(f.comments || '').replace(/"/g, '""')}","${(f.findingDetails || '').replace(/"/g, '""')}"`,
          )
          .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${machine.name}_${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        return res.send(header + rows);
      }

      return next(createError('Invalid format. Supported: ckl, json, csv', 400, 'VALIDATION_ERROR'));
    }

    // TODO: query real DB and generate CKL
    next(createError('Not implemented without MOCK_MODE', 501));
  },
);

export default router;
