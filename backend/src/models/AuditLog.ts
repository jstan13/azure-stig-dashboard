import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('audit_logs')
@Index('idx_audit_correlation', ['correlationId'])
@Index('idx_audit_action_target', ['action', 'targetId'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() action!: string; // e.g. scan.triggered, checklist.exported, finding.updated
  @Column() actor!: string; // user email or 'system'
  /** Best-effort role label captured at audit time (admin|operator|auditor|none|<custom>). */
  @Column({ nullable: true }) actorRole!: string | null;
  @Column({ nullable: true }) targetId!: string;
  @Column({ nullable: true }) targetType!: string; // machine | checklist | finding | exception
  /**
   * Outcome of the action — Success | Denied | Error. Nullable for backward
   * compatibility with rows written before the canonical auditor was wired in.
   */
  @Column({ nullable: true }) result!: string | null;
  /** Correlation ID propagated from the inbound x-correlation-id header. */
  @Column({ nullable: true }) correlationId!: string | null;
  /** Snapshot of the entity before the action (for state-changing ops). */
  @Column({ type: 'jsonb', nullable: true }) before!: Record<string, any> | null;
  /** Snapshot of the entity after the action (for state-changing ops). */
  @Column({ type: 'jsonb', nullable: true }) after!: Record<string, any> | null;
  /**
   * Free-form supplemental details. Retained for backward compatibility with
   * the older audit shape — new code should prefer `before`/`after`.
   */
  @Column({ type: 'jsonb', nullable: true }) details!: Record<string, any>;
  /** Client IP if available */
  @Column({ nullable: true }) ipAddress!: string;
  @CreateDateColumn() timestamp!: Date;
}
