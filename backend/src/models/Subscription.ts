import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany,
} from 'typeorm';
import { ResourceGroupEntity } from './ResourceGroup';

@Entity('subscriptions')
export class SubscriptionEntity {
  @PrimaryColumn() id!: string; // Azure subscription ID
  @Column() displayName!: string;
  @Column({ nullable: true }) tenantId!: string;
  @Column({ default: true }) isActive!: boolean;
  @Column({ type: 'jsonb', nullable: true }) tags!: Record<string, string>;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @OneToMany(() => ResourceGroupEntity, (rg) => rg.subscription)
  resourceGroups!: ResourceGroupEntity[];
}
