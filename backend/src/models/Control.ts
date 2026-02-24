import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany,
} from 'typeorm';
import { ControlMappingEntity } from './ControlMapping';

@Entity('controls')
export class ControlEntity {
  @PrimaryColumn() id!: string;              // e.g. V-220700
  @Column() stigId!: string;                 // e.g. WN10-AU-000005
  @Column({ nullable: true }) title!: string;
  @Column({ default: 'medium' }) severity!: string; // high | medium | low | informational
  @Column({ type: 'text', nullable: true }) description!: string;
  @Column({ type: 'text', nullable: true }) checkContent!: string;
  @Column({ type: 'text', nullable: true }) fixText!: string;
  @Column({ nullable: true }) version!: string;
  @Column({ nullable: true }) stigName!: string; // e.g. Windows 10 STIG
  @Column({ nullable: true }) azurePolicyId!: string;
  @Column({ nullable: true }) defenderRuleId!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @OneToMany(() => ControlMappingEntity, (m) => m.control)
  mappings!: ControlMappingEntity[];
}
