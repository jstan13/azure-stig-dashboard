/**
 * ComplianceHistory — daily compliance score snapshots per machine.
 *
 * Written by the scan orchestrator after every completed scan.
 * Used to power the trend charts (score over time, new vs resolved).
 */

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

@Entity('compliance_history')
@Index(['machineId', 'snapshotDate'])
export class ComplianceHistoryEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column() machineId!: string;

  /** Date of snapshot (truncated to day) */
  @Column({ type: 'date' }) snapshotDate!: string;

  @Column({ type: 'float', default: 0 }) score!: number;

  @Column({ default: 0 }) totalControls!: number;
  @Column({ default: 0 }) openFindings!: number;
  @Column({ default: 0 }) catIOpen!: number;
  @Column({ default: 0 }) catIIOpen!: number;
  @Column({ default: 0 }) catIIIOpen!: number;
  @Column({ default: 0 }) resolved!: number;
  @Column({ default: 0 }) notApplicable!: number;
  @Column({ default: 0 }) notReviewed!: number;

  /** Source subscription/benchmark that triggered this snapshot */
  @Column({ nullable: true }) scanId!: string;

  @CreateDateColumn() createdAt!: Date;
}
