import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  /** Azure AD object ID */
  @Column({ unique: true }) oid!: string;
  @Column({ unique: true }) email!: string;
  @Column({ nullable: true }) displayName!: string;
  @Column({ type: 'simple-array', default: 'auditor' }) roles!: string[];
  @Column({ default: true }) isActive!: boolean;
  @Column({ type: 'timestamp', nullable: true }) lastLogin!: Date;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
