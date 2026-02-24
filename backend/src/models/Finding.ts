import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { MachineEntity } from './Machine';
import { ControlEntity } from './Control';

/**
 * A Finding represents the evaluation result for one Control on one Machine.
 * Status values match STIG Viewer conventions.
 */
@Entity('findings')
export class FindingEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() machineId!: string;
  @Column() controlId!: string;
  /** open | not_a_finding | not_applicable | not_reviewed */
  @Column({ default: 'not_reviewed' }) status!: string;
  @Column({ default: 'medium' }) severity!: string;
  /** STIG Viewer "Comments" field */
  @Column({ type: 'text', nullable: true }) comments!: string;
  /** STIG Viewer "Finding Details" field */
  @Column({ type: 'text', nullable: true }) findingDetails!: string;
  /** Source of the finding: azure-policy | defender | resource-graph | manual */
  @Column({ default: 'azure-policy' }) sourceType!: string;
  /** Raw evidence payload from Azure (policy evaluation result, Defender alert, etc.) */
  @Column({ type: 'jsonb', nullable: true }) evidence!: Record<string, any>;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @ManyToOne(() => MachineEntity, (m) => m.findings)
  @JoinColumn({ name: 'machineId' })
  machine!: MachineEntity;
  @ManyToOne(() => ControlEntity)
  @JoinColumn({ name: 'controlId' })
  control!: ControlEntity;
}
