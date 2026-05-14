/**
 * Failing-first unit tests for backend/src/auth/audit.ts (constitution VII).
 *
 * The audit layer:
 *   - records every state-changing action with actor, role, action,
 *     before/after, correlation ID, source IP, and UTC occurredAt timestamp
 *   - writes Success / Denied / Error results
 *   - never throws synchronously back to the caller — failure to write to
 *     the underlying sink must emit a fallback log line and resolve so that
 *     the route handler can complete
 *   - is idempotent under retries (same correlationId + action + entityId
 *     produces a single logical record)
 */
import {
  Auditor,
  type AuditWriter,
  type AuditEntry,
} from '../../../src/auth/audit';

function makeWriter(): AuditWriter & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: jest.fn(async (entry) => {
      entries.push(entry);
    }),
  };
}

describe('Auditor', () => {
  it('records a Success entry with all required fields populated', async () => {
    const writer = makeWriter();
    const auditor = new Auditor(writer, {
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    });

    await auditor.record({
      actorUserId: 'user-1',
      actorRole: 'operator',
      action: 'Finding.UpdateStatus',
      entityType: 'Finding',
      entityId: 'finding-42',
      before: { status: 'Open' },
      after: { status: 'NotAFinding' },
      result: 'Success',
      correlationId: 'corr-success',
      sourceIp: '10.0.0.1',
    });

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0]).toMatchObject({
      actorUserId: 'user-1',
      actorRole: 'operator',
      action: 'Finding.UpdateStatus',
      entityType: 'Finding',
      entityId: 'finding-42',
      before: { status: 'Open' },
      after: { status: 'NotAFinding' },
      result: 'Success',
      correlationId: 'corr-success',
      sourceIp: '10.0.0.1',
    });
    expect(writer.entries[0].occurredAt).toEqual(
      new Date('2026-05-07T12:00:00.000Z'),
    );
  });

  it('records a Denied entry when given Denied result', async () => {
    const writer = makeWriter();
    const auditor = new Auditor(writer);

    await auditor.record({
      actorUserId: 'user-2',
      actorRole: 'auditor',
      action: 'Scan.Trigger',
      entityType: 'Collection',
      entityId: 'coll-A',
      result: 'Denied',
      correlationId: 'corr-denied',
      sourceIp: '10.0.0.2',
    });

    expect(writer.entries[0].result).toBe('Denied');
  });

  it('does not throw if the underlying writer fails — fallback only', async () => {
    const writer: AuditWriter = {
      write: jest.fn(async () => {
        throw new Error('db unreachable');
      }),
    };
    const fallback = jest.fn();
    const auditor = new Auditor(writer, { fallbackLog: fallback });

    await expect(
      auditor.record({
        actorUserId: 'user-3',
        actorRole: 'admin',
        action: 'Tenant.Manage',
        entityType: 'Tenant',
        entityId: 't1',
        result: 'Success',
        correlationId: 'corr-fallback',
        sourceIp: '10.0.0.3',
      }),
    ).resolves.toBeUndefined();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toMatchObject({
      action: 'Tenant.Manage',
      reason: 'audit_write_failed',
    });
  });

  it('deduplicates within the same correlationId+action+entityId tuple', async () => {
    const writer = makeWriter();
    const auditor = new Auditor(writer);

    const entry = {
      actorUserId: 'user-4',
      actorRole: 'operator' as const,
      action: 'Finding.UpdateStatus',
      entityType: 'Finding',
      entityId: 'finding-1',
      result: 'Success' as const,
      correlationId: 'corr-dedupe',
      sourceIp: '10.0.0.4',
    };

    await auditor.record(entry);
    await auditor.record(entry);
    await auditor.record(entry);

    expect(writer.entries).toHaveLength(1);
  });

  it('stamps occurredAt as UTC even when injected clock returns a local Date', async () => {
    const writer = makeWriter();
    const auditor = new Auditor(writer, {
      now: () => new Date(Date.UTC(2026, 4, 7, 12, 30, 0)),
    });

    await auditor.record({
      actorUserId: 'user-5',
      actorRole: 'admin',
      action: 'Collection.Create',
      entityType: 'Collection',
      entityId: 'coll-Z',
      result: 'Success',
      correlationId: 'corr-utc',
      sourceIp: '10.0.0.5',
    });

    expect(writer.entries[0].occurredAt.toISOString()).toBe(
      '2026-05-07T12:30:00.000Z',
    );
  });
});
