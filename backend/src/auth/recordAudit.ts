/**
 * Convenience helper for route handlers.
 *
 * Reduces every state-changing handler from a ~10-line boilerplate to a
 * single call, while still producing a fully-populated AuditEntry conforming
 * to the canonical shape consumed by `Auditor`.
 *
 * Usage:
 *   import { recordAudit } from '../auth/recordAudit';
 *   await recordAudit(req, {
 *     action: 'scan.triggered',
 *     entityType: 'machine',
 *     entityId: machineId,
 *     after: { resourceIds, subscriptionIds },
 *     result: 'Success',
 *   });
 */
import type { Request } from 'express';
import type { AuditRequest, AuditInput, AuditResult } from './audit';

export interface RouteAuditInput {
  action: string;
  entityType: string;
  entityId: string;
  result: AuditResult;
  before?: unknown;
  after?: unknown;
}

export async function recordAudit(
  req: Request,
  input: RouteAuditInput,
): Promise<void> {
  const audit = (req as unknown as AuditRequest).audit;
  if (!audit) return;
  const auth = (req as any).auth ?? {};
  const actorUserId =
    typeof auth.email === 'string' && auth.email.length > 0
      ? auth.email
      : typeof auth.sub === 'string' && auth.sub.length > 0
      ? auth.sub
      : 'api';
  const roles = Array.isArray(auth.roles) ? auth.roles : [];
  const actorRole = pickHighestRole(roles) ?? 'unknown';

  const entry: AuditInput = {
    actorUserId,
    actorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    result: input.result,
    correlationId:
      (req as unknown as AuditRequest).correlationId ?? 'no-correlation',
    sourceIp: req.ip ?? 'unknown',
  };

  await audit.record(entry);
}

const ROLE_RANK: Record<string, number> = { admin: 3, operator: 2, auditor: 1 };

function pickHighestRole(roles: string[]): string | undefined {
  let best: string | undefined;
  let bestRank = 0;
  for (const r of roles) {
    const rank = ROLE_RANK[r] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = r;
    } else if (!best && typeof r === 'string') {
      best = r;
    }
  }
  return best;
}
