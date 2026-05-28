import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddRemediationApprovalFields1700000004000 implements MigrationInterface {
  name = 'AddRemediationApprovalFields1700000004000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.addColumns('remediation_jobs', [
      new TableColumn({ name: 'approvalRequired', type: 'boolean', default: false }),
      new TableColumn({ name: 'approved', type: 'boolean', default: false }),
      new TableColumn({ name: 'approvedByOid', type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'approvedByName', type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'approvedAt', type: 'timestamp', isNullable: true }),
    ]);
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.dropColumn('remediation_jobs', 'approvedAt');
    await runner.dropColumn('remediation_jobs', 'approvedByName');
    await runner.dropColumn('remediation_jobs', 'approvedByOid');
    await runner.dropColumn('remediation_jobs', 'approved');
    await runner.dropColumn('remediation_jobs', 'approvalRequired');
  }
}
