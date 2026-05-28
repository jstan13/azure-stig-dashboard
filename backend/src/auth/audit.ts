/**
 * Audit middleware + sink (constitution Principle II, FR-003, FR-015).
 *
 * `AuditEntry` is the canonical shape persisted to the immutable `AuditLog`
 * table (see `specs/001-azure-stig-dashboard/data-model.md`).
 *
 * The `Auditor` class is intentionally small and free of route-handler
 * concerns:
 *   - it persists via an injected `AuditWriter` (a thin wrapper over the
 *     `AuditLogEntity` repository in production)
 *   - it deduplicates entries within the same `correlationId + action +
 *     entityId` triple to make HTTP retries idempotent
 *   - it MUST NOT throw back to the caller if the underlying writer fails;
 *     audit failure is logged through the fallback sink and the request is
 *     allowed to complete, since blocking on audit-write failures would
 *     itself be a denial-of-service path
 *
 * The Express middleware is built on top in `auditMiddleware()`.
 */
import type { Request, Response, NextFunction } from 'express';

export type AuditResult = 'Success' | 'Denied' | 'Error';

export interface AuditEntry {
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  result: AuditResult;
  correlationId: string;
  sourceIp: string;
  occurredAt: Date;
}

export interface AuditInput
  extends Omit<AuditEntry, 'occurredAt'> {
  occurredAt?: Date;
}

export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

export interface AuditSink {
  record(input: AuditInput): Promise<void>;
}

export interface FallbackLogPayload {
  reason: 'audit_write_failed';
  action: string;
  correlationId: string;
  error: unknown;
}

export type FallbackLog = (payload: FallbackLogPayload) => void;

export interface AuditorOptions {
  now?: () => Date;
  fallbackLog?: FallbackLog;
}

export class Auditor implements AuditSink {
  private readonly writer: AuditWriter;
  private readonly now: () => Date;
  private readonly fallbackLog: FallbackLog;
  // Bounded FIFO dedupe cache. NOTE: this is per-process only — it makes HTTP
  // retries within a single instance idempotent, but does NOT dedupe across
  // multiple scaled-out instances. For cross-instance guarantees, rely on a
  // unique DB constraint on (correlationId, action, entityId).
  private readonly seen = new Set<string>();
  private static readonly MAX_SEEN = 5000;

  constructor(writer: AuditWriter, opts: AuditorOptions = {}) {
    this.writer = writer;
    this.now = opts.now ?? (() => new Date());
    this.fallbackLog =
      opts.fallbackLog ??
      ((p) => {
        // Keep the default sink dependency-free; consumers can wire
        // pino/applicationinsights here.
        // eslint-disable-next-line no-console
        console.error('[audit:fallback]', p);
      });
  }

  async record(input: AuditInput): Promise<void> {
    const dedupeKey = `${input.correlationId}|${input.action}|${input.entityId}`;
    if (this.seen.has(dedupeKey)) {
      return;
    }    const entry: AuditEntry = {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      result: input.result,
      correlationId: input.correlationId,
      sourceIp: input.sourceIp,
      occurredAt: input.occurredAt ?? this.now(),
    };

    try {
      await this.writer.write(entry);
      // Only mark as seen on a successful write so a transient failure can
      // be retried by the caller without permanently losing the record.
      if (this.seen.size >= Auditor.MAX_SEEN) {
        // Evict the oldest entry (Sets preserve insertion order) to keep the
        // cache bounded and avoid an unbounded memory leak on long-lived procs.
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      this.seen.add(dedupeKey);
    } catch (err) {
      this.fallbackLog({
        reason: 'audit_write_failed',
        action: entry.action,
        correlationId: entry.correlationId,
        error: err,
      });
    }
  }
}

/**
 * Express middleware that captures actor + correlation context onto the
 * request so downstream handlers can call `req.audit.record(...)` without
 * threading the auditor through manually.
 *
 * State-changing routes are responsible for calling `req.audit.record()`
 * themselves with the appropriate before/after payloads. This middleware
 * does NOT auto-derive before/after, since doing so robustly would require
 * tying audit into the service layer rather than the HTTP layer.
 */
export interface AuditRequest extends Request {
  audit: AuditSink;
  correlationId: string;
}

export interface AuditMiddlewareOptions {
  auditor: AuditSink;
  /** Header name carrying an inbound correlation ID. Default: `x-correlation-id`. */
  correlationHeader?: string;
  /** Generator for new correlation IDs when no header is present. */
  generateCorrelationId?: () => string;
}

export function auditMiddleware(
  opts: AuditMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const headerName = (opts.correlationHeader ?? 'x-correlation-id').toLowerCase();
  const gen =
    opts.generateCorrelationId ??
    (() => globalThis.crypto?.randomUUID?.() ?? fallbackUuid());

  return (req, res, next) => {
    const incoming = req.headers[headerName];
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0 ? incoming : gen();
    (req as AuditRequest).audit = opts.auditor;
    (req as AuditRequest).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  };
}

function fallbackUuid(): string {
  // RFC 4122 v4 (no crypto.randomUUID available — extremely rare on Node 20+)
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
