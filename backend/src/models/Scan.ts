import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { MachineEntity } from './Machine';

@Entity('scans')
export class ScanEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() machineId!: string;
  @Column({ nullable: true }) machineName!: string;
  @Column({ nullable: true }) subscriptionId!: string;
  @Column({ nullable: true }) resourceGroupName!: string;
  @Column({ default: 'system-scheduler' }) triggeredBy!: string;
  @Column({ default: 'full' }) scanType!: string; // full | incremental | on-demand
  @Column({ default: 'pending' }) status!: string; // pending | running | completed | failed
  @Column({ type: 'timestamp', nullable: true }) startedAt!: Date;
  @Column({ type: 'timestamp', nullable: true }) completedAt!: Date;
  @Column({ default: 0 }) totalControls!: number;
  @Column({ default: 0 }) openFindings!: number;
  @Column({ default: 0 }) compliantControls!: number;
  @Column({ type: 'text', nullable: true }) errorMessage!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @ManyToOne(() => MachineEntity, (m) => m.scans)
  @JoinColumn({ name: 'machineId' })
  machine!: MachineEntity;
}
