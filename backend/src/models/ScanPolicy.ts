import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export type ScanFrequency = 'hourly' | 'daily' | 'weekly';

@Entity('scan_policy')
export class ScanPolicyEntity {
  @PrimaryColumn({ type: 'varchar', default: 'singleton' }) id!: string;

  @Column({ default: false }) enabled!: boolean;

  @Column({ type: 'varchar', default: 'daily' }) frequency!: ScanFrequency;

  @Column({ type: 'int', default: 0 }) minute!: number;

  @Column({ type: 'int', default: 2 }) hour!: number;

  @Column({ type: 'int', default: 0 }) dayOfWeek!: number;

  @Column({ type: 'varchar', default: 'UTC' }) timeZone!: string;

  @Column({ type: 'timestamptz', nullable: true }) lastScheduledRunAt!: Date | null;

  @Column({ type: 'varchar', nullable: true }) lastStatus!: 'running' | 'completed' | 'failed' | null;

  @Column({ type: 'text', nullable: true }) lastError!: string | null;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}