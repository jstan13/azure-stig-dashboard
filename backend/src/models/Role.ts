import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('roles')
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) name!: string; // admin | operator | auditor
  @Column({ nullable: true }) description!: string;
  @Column({ type: 'simple-array', default: '' }) permissions!: string[];
  @CreateDateColumn() createdAt!: Date;
}
