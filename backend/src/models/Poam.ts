/**
 * Plan of Action & Milestones (POA&M)
 *
 * Tracks open findings through their remediation lifecycle in accordance with
 * DoD 8500.2 / DODI 8510.01 (RMF) requirements.
 *
 * Status flow:
 *   open → in_remediation → resolved → risk_accepted | false_positive | closed
 *
 * A POA&M is normally linked to one Finding (machine + control). POA&Ms for
 * weaknesses identified outside scanning (assessments, audits, pen tests) are
 * entered by hand and have no finding; they carry their own severity/control.
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

  /** Linked finding (machine + control pair). Null for manually entered weaknesses. */
  @Column({ type: 'uuid', nullable: true }) findingId!: string | null;
  @ManyToOne(() => FindingEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'findingId' })
  finding!: FindingEntity | null;

  /** Unique sequential identifier within the system, e.g. "POA-2024-0042" */
  @Column({ unique: true }) poamId!: string;

  /** Human-readable title summarising the weakness */
  @Column({ type: 'text' }) weakness!: string;

  /** high | medium | low (CAT I / II / III); copied from the finding when linked */
  @Column({ type: 'varchar', nullable: true }) severity!: string | null;

  /** NIST SP 800-53 control, e.g. "AC-2" or "AC-2(1)" — sent to eMASS */
  @Column({ type: 'varchar', nullable: true }) controlAcronym!: string | null;

  /** Where the weakness was identified, e.g. "Annual security assessment" */
  @Column({ type: 'text', nullable: true }) sourceIdentifyingControl!: string | null;

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

  /**
   * Immutable Azure AD OID of the authenticated user who created this POA&M.
   * Set server-side from the verified token; used for the separation-of-duties
   * check on approval so the approver cannot be the creator.
   */
  @Column({ nullable: true }) createdByOid!: string;

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
