import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany,
} from 'typeorm';
import { FindingEntity } from './Finding';
import { ScanEntity } from './Scan';
import { ChecklistEntity } from './Checklist';

@Entity('machines')
export class MachineEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) resourceId!: string; // full Azure VM resource ID
  @Column() name!: string;
  @Column({ nullable: true }) tenantId!: string;
  @Column({ nullable: true }) tenantName!: string;
  @Column() subscriptionId!: string;
  @Column({ nullable: true }) subscriptionName!: string;
  @Column() resourceGroupName!: string;
  @Column({ nullable: true }) location!: string;
  @Column({ default: 'Windows' }) osType!: string;
  @Column({ nullable: true }) osVersion!: string;
  @Column({ type: 'jsonb', nullable: true }) tags!: Record<string, string>;
  @Column({ type: 'float', default: 0 }) complianceScore!: number;
  @Column({ nullable: true }) lastScanDate!: Date;
  @Column({ default: 'unknown' }) status!: string; // online / offline / unknown
  @Column({ default: false }) isArcConnected!: boolean;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @OneToMany(() => FindingEntity, (f) => f.machine)   findings!: FindingEntity[];
  @OneToMany(() => ScanEntity, (s) => s.machine)      scans!: ScanEntity[];
  @OneToMany(() => ChecklistEntity, (c) => c.machine) checklists!: ChecklistEntity[];
}
