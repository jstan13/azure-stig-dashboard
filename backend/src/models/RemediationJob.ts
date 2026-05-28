/**
 * RemediationJob — tracks bulk automated remediation runs.
 *
 * A job can apply multiple STIG fixes across multiple machines
 * using DSC push (enforce) mode or Azure Policy remediation tasks.
 *
 * Status: pending → running → completed | failed | partial
 */

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  OneToMany, JoinColumn,
} from 'typeorm';

@Entity('remediation_jobs')
export class RemediationJobEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** Human label, e.g. "CAT I fixes — rg-prod — 2024-02-15" */
  @Column() name!: string;

  /** pending | running | completed | failed | partial */
  @Column({ default: 'pending' }) status!: string;

  /** Whether a second operator approved execution (4-eyes control) */
  @Column({ default: false }) approvalRequired!: boolean;
  @Column({ default: false }) approved!: boolean;
  @Column({ nullable: true }) approvedByOid!: string;
  @Column({ nullable: true }) approvedByName!: string;
  @Column({ type: 'timestamp', nullable: true }) approvedAt!: Date;

  /** Strategy: dsc_push | azure_policy | manual */
  @Column({ default: 'dsc_push' }) strategy!: string;

  /** Machine IDs targeted */
  @Column({ type: 'jsonb', default: '[]' }) machineIds!: string[];

  /** Finding IDs in scope */
  @Column({ type: 'jsonb', default: '[]' }) findingIds!: string[];

  /** STIG benchmark + version to remediate against */
  @Column({ nullable: true }) benchmarkId!: string;
  @Column({ nullable: true }) stigVersion!: string;

  /** Restrict to a severity level: high | medium | low */
  @Column({ nullable: true }) severity!: string;

  /** Azure AD OID of actor who triggered this job */
  @Column() triggeredByOid!: string;
  @Column({ nullable: true }) triggeredByName!: string;

  /** Summary counts after completion */
  @Column({ default: 0 }) totalItems!: number;
  @Column({ default: 0 }) succeeded!: number;
  @Column({ default: 0 }) failed!: number;
  @Column({ default: 0 }) skipped!: number;

  @Column({ type: 'timestamp', nullable: true }) startedAt!: Date;
  @Column({ type: 'timestamp', nullable: true }) completedAt!: Date;

  /** Per-machine/per-finding result log */
  @Column({ type: 'jsonb', default: '[]' }) resultLog!: RemediationResultEntry[];

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

export interface RemediationResultEntry {
  machineId: string;
  machineName: string;
  findingId?: string;
  controlId?: string;
  vulnId?: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'pending';
  message?: string;
  runCommandJobId?: string;
  timestamp: string;
}
