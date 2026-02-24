import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import { SubscriptionEntity } from './Subscription';
import { ResourceEntity } from './Resource';

@Entity('resource_groups')
export class ResourceGroupEntity {
  @PrimaryColumn() id!: string; // /subscriptions/{subId}/resourceGroups/{name}
  @Column() name!: string;
  @Column() subscriptionId!: string;
  @Column({ nullable: true }) location!: string;
  @Column({ type: 'jsonb', nullable: true }) tags!: Record<string, string>;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @ManyToOne(() => SubscriptionEntity, (s) => s.resourceGroups)
  @JoinColumn({ name: 'subscriptionId' })
  subscription!: SubscriptionEntity;
  @OneToMany(() => ResourceEntity, (r) => r.resourceGroup)
  resources!: ResourceEntity[];
}
