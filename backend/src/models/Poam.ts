/**
 * Plan of Action & Milestones (POA&M)
 *
 * Tracks open findings through their remediation lifecycle in accordance with
 * DoD 8500.2 / DODI 8510.01 (RMF) requirements.
 *
 * Status flow:
 *   open → in_remediation → resolved → risk_accepted | false_positive | closed
 *
 * Each POA&M is linked to one Finding (which is linked to machine + control).
 * Multiple milestone tasks can be attached to track sub-tasks.
 */

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  OneToMany, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { FindingEntity } from './Finding';

export type PoamStatus =
  | 'open'
  | 'in_remediation'
  | 'resolved'
  | 'risk_accepted'
  | 'false_positive'
  | 'closed';

@Entity('poams')
@Index(['findingId'])
@Index(['status'])
export class PoamEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** Linked finding (machine + control pair) */
  @Column() findingId!: string;
  @ManyToOne(() => FindingEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'findingId' })
  finding!: FindingEntity;

  /** Unique sequential identifier within the system, e.g. "POA-2024-0042" */
  @Column({ unique: true }) poamId!: string;

  /** Human-readable title summarising the weakness */
  @Column({ type: 'text' }) weakness!: string;

  /** Vulnerability description from STIG check */
  @Column({ type: 'text', nullable: true }) description!: string;

  /** Impact if not remediated (from STIG severity + context) */
  @Column({ type: 'text', nullable: true }) impact!: string;

  /** Current lifecycle status */
  @Column({ default: 'open' }) status!: PoamStatus;

  /** DoD 8531.01 due-date by CAT: CAT I = 30d, CAT II = 90d, CAT III = 180d */
  @Column({ type: 'timestamp', nullable: true }) scheduledCompletion!: Date;

  /** Actual completion date (set when status → resolved / closed) */
  @Column({ type: 'timestamp', nullable: true }) actualCompletion!: Date;

  /** Azure AD OID of the person responsible for remediation */
  @Column({ nullable: true }) assignedToOid!: string;

  /** Display name of assignee */
  @Column({ nullable: true }) assignedToName!: string;

  /** Azure AD OID of the ISSO who owns this POA&M */
  @Column({ nullable: true }) issoOid!: string;

  /** Delay reason (required when past due) */
  @Column({ type: 'text', nullable: true }) delayReason!: string;

  /** Resources required for remediation */
  @Column({ type: 'text', nullable: true }) resourcesRequired!: string;

  /** Risk acceptance justification (required when status = risk_accepted) */
  @Column({ type: 'text', nullable: true }) riskAcceptanceRationale!: string;

  /** Final disposition notes */
  @Column({ type: 'text', nullable: true }) residualRisk!: string;

  /** Planned countermeasures / interim fix */
  @Column({ type: 'text', nullable: true }) countermeasures!: string;

  /** OID of reviewer who approved risk acceptance */
  @Column({ nullable: true }) approvedByOid!: string;

  @Column({ type: 'timestamp', nullable: true }) approvedAt!: Date;

  @OneToMany(() => PoamMilestoneEntity, (m) => m.poam, { cascade: true, eager: true })
  milestones!: PoamMilestoneEntity[];

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

/** Individual milestone task within a POA&M */
@Entity('poam_milestones')
export class PoamMilestoneEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column() poamId!: string;
  @ManyToOne(() => PoamEntity, (p) => p.milestones, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'poamId' })
  poam!: PoamEntity;

  @Column({ type: 'text' }) description!: string;

  /** planned | in_progress | completed | delayed */
  @Column({ default: 'planned' }) status!: string;

  @Column({ type: 'timestamp', nullable: true }) dueDate!: Date;
  @Column({ type: 'timestamp', nullable: true }) completedAt!: Date;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
