import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { MachineEntity } from './Machine';

/** Represents a generated STIG checklist export (.ckl or JSON). */
@Entity('checklists')
export class ChecklistEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() machineId!: string;
  @Column({ nullable: true }) exportedBy!: string; // user email / OID
  @Column({ default: 'ckl' }) format!: string; // ckl | json | csv
  @Column({ type: 'text', nullable: true }) filePath!: string;
  @Column({ default: false }) archived!: boolean;
  @Column({ type: 'jsonb', nullable: true }) metadata!: Record<string, any>;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @ManyToOne(() => MachineEntity, (m) => m.checklists)
  @JoinColumn({ name: 'machineId' })
  machine!: MachineEntity;
}
