import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('emass_config')
export class EmassConfigEntity {
  @PrimaryColumn({ type: 'varchar', default: 'singleton' }) id!: string;

  @Column({ type: 'text', nullable: true }) baseUrl!: string | null;
  @Column({ type: 'text', nullable: true }) userUid!: string | null;
  @Column({ type: 'text', nullable: true }) apiKeyEncrypted!: string | null;
  @Column({ type: 'text', nullable: true }) certPemEncrypted!: string | null;
  @Column({ type: 'text', nullable: true }) keyPemEncrypted!: string | null;
  @Column({ type: 'text', nullable: true }) caPemEncrypted!: string | null;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}