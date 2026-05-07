/**
 * Adapters bridging the canonical `AuditWriter` interface (in
 * `src/auth/audit.ts`) to the persistence layer.
 *
 * - `TypeOrmAuditWriter`  — writes `AuditEntry` rows to the `AuditLogEntity`
 *   table via TypeORM. Used in production and CI integration tests.
 * - `MockAuditWriter`     — in-memory ring buffer used in MOCK_MODE so the
 *   app stays fully functional without a database. Tests can also import it
 *   directly to assert audit emissions.
 *
 * Both writers map the canonical shape onto the existing `AuditLogEntity`
 * columns (which were extended in this commit to carry result, correlationId,
 * before, after, actorRole) without breaking pre-existing audit rows.
 */
import type { DataSource, Repository } from 'typeorm';
import { AuditLogEntity } from '../models/AuditLog';
import type { AuditEntry, AuditWriter } from '../auth/audit';

export class TypeOrmAuditWriter implements AuditWriter {
  private readonly repo: Repository<AuditLogEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(AuditLogEntity);
  }

  async write(entry: AuditEntry): Promise<void> {
    const row = this.repo.create({
      action: entry.action,
      actor: entry.actorUserId,
      actorRole: entry.actorRole,
      targetId: entry.entityId,
      targetType: entry.entityType,
      result: entry.result,
      correlationId: entry.correlationId,
      before: (entry.before ?? null) as Record<string, any> | null,
      after: (entry.after ?? null) as Record<string, any> | null,
      ipAddress: entry.sourceIp,
      timestamp: entry.occurredAt,
    });
    await this.repo.save(row);
  }
}

/**
 * In-memory writer used in MOCK_MODE. Holds the most recent N entries so the
 * GET /api/audit endpoint can still return realistic data without a DB.
 */
export class MockAuditWriter implements AuditWriter {
  private readonly cap: number;
  public readonly entries: AuditEntry[] = [];

  constructor(cap = 1000) {
    this.cap = cap;
  }

  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
  }
}

/** Singleton mock writer shared by the app and the mock data layer. */
export const mockAuditWriter = new MockAuditWriter();
