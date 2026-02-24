import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('audit_logs')
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() action!: string; // e.g. scan.triggered, checklist.exported, finding.updated
  @Column() actor!: string; // user email or 'system'
  @Column({ nullable: true }) targetId!: string;
  @Column({ nullable: true }) targetType!: string; // machine | checklist | finding | exception
  @Column({ type: 'jsonb', nullable: true }) details!: Record<string, any>;
  /** Client IP if available */
  @Column({ nullable: true }) ipAddress!: string;
  @CreateDateColumn() timestamp!: Date;
}
