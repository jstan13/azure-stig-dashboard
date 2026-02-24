import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * An Exception grants a waiver or deviation from a STIG control for a
 * specific machine or resource group.
 */
@Entity('exceptions')
export class ExceptionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() machineId!: string;
  @Column() controlId!: string;
  /** waiver | deviation | false_positive */
  @Column({ default: 'waiver' }) type!: string;
  @Column({ type: 'text' }) justification!: string;
  @Column({ nullable: true }) approvedBy!: string;
  @Column({ type: 'timestamp', nullable: true }) expiresAt!: Date;
  @Column({ default: 'pending' }) status!: string; // pending | approved | denied | expired
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
