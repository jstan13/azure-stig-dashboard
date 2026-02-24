import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { ResourceGroupEntity } from './ResourceGroup';

@Entity('resources')
export class ResourceEntity {
  @PrimaryColumn() id!: string; // full Azure resource ID
  @Column() name!: string;
  @Column() type!: string;
  @Column() resourceGroupId!: string;
  @Column({ nullable: true }) location!: string;
  @Column({ type: 'jsonb', nullable: true }) properties!: Record<string, any>;
  @Column({ type: 'jsonb', nullable: true }) tags!: Record<string, string>;
  @Column({ nullable: true }) policyComplianceState!: string; // Compliant / NonCompliant / Unknown
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @ManyToOne(() => ResourceGroupEntity, (rg) => rg.resources)
  @JoinColumn({ name: 'resourceGroupId' })
  resourceGroup!: ResourceGroupEntity;
}
