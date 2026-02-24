import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { ControlEntity } from './Control';

/** Mapping between an Azure artefact (policy, defender rule, etc.) and a STIG control. */
@Entity('control_mappings')
export class ControlMappingEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() controlId!: string;
  /** Source system: azure-policy | defender | resource-graph | manual */
  @Column() sourceType!: string;
  /** The ID used by the source system (e.g. Azure Policy definition ID) */
  @Column() sourceId!: string;
  /** Human-readable name of the source rule/policy */
  @Column({ nullable: true }) sourceName!: string;
  /** How confident is this mapping? 1=exact, 2=related, 3=inferred */
  @Column({ default: 1 }) confidence!: number;
  @Column({ type: 'text', nullable: true }) notes!: string;
  @CreateDateColumn() createdAt!: Date;
  @ManyToOne(() => ControlEntity, (c) => c.mappings)
  @JoinColumn({ name: 'controlId' })
  control!: ControlEntity;
}
