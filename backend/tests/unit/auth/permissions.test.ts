import {
  ROLES,
  ROLE_RANK,
  ROLE_PERMISSIONS,
  GLOBAL_PERMISSIONS,
  isRole,
  isGlobalPermission,
  toRoles,
  permissionsForRoles,
  rolesGrant,
  type Role,
} from '../../../src/auth/permissions';

describe('permission catalog', () => {
  it('defines the five RMF roles in ascending authority order', () => {
    expect([...ROLES]).toEqual(['auditor', 'operator', 'isso', 'issm', 'admin']);
    const ranks = ROLES.map((r) => ROLE_RANK[r]);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });

  it('makes role permissions strictly cumulative up the hierarchy', () => {
    const ordered = [...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    for (let i = 1; i < ordered.length; i++) {
      const lower = ROLE_PERMISSIONS[ordered[i - 1]];
      const higher = ROLE_PERMISSIONS[ordered[i]];
      for (const perm of lower) {
        expect(higher.has(perm)).toBe(true);
      }
      // Higher tier adds at least one new permission.
      expect(higher.size).toBeGreaterThan(lower.size);
    }
  });

  it('separates approvals (issm) from execution (operator) for SoD', () => {
    // Operator executes remediation but cannot approve it.
    expect(ROLE_PERMISSIONS.operator.has('remediation:execute')).toBe(true);
    expect(ROLE_PERMISSIONS.operator.has('remediation:approve')).toBe(false);
    // ISSO authors POA&Ms but cannot approve them.
    expect(ROLE_PERMISSIONS.isso.has('poam:write')).toBe(true);
    expect(ROLE_PERMISSIONS.isso.has('poam:approve')).toBe(false);
    // ISSM approves but is not the application owner.
    expect(ROLE_PERMISSIONS.issm.has('poam:approve')).toBe(true);
    expect(ROLE_PERMISSIONS.issm.has('users:manage')).toBe(false);
  });

  it('grants the manual STIG check edit permission from operator up', () => {
    expect(ROLE_PERMISSIONS.auditor.has('findings:write')).toBe(false);
    expect(ROLE_PERMISSIONS.operator.has('findings:write')).toBe(true);
    expect(ROLE_PERMISSIONS.isso.has('findings:write')).toBe(true);
    expect(ROLE_PERMISSIONS.admin.has('findings:write')).toBe(true);
  });

  it('keeps auditor read-only', () => {
    const perms = [...ROLE_PERMISSIONS.auditor];
    expect(perms.sort()).toEqual(
      ['audit:read', 'dashboard:read', 'export:generate'].sort(),
    );
  });

  it('lets the scheduler report without letting it set the policy', () => {
    // The scheduler Function runs as an operator, so it must be able to check
    // in and record a shutdown without being made an administrator.
    expect(ROLE_PERMISSIONS.operator.has('power:report')).toBe(true);
    expect(ROLE_PERMISSIONS.operator.has('power:schedule')).toBe(false);
    expect(ROLE_PERMISSIONS.admin.has('power:schedule')).toBe(true);
    expect(ROLE_PERMISSIONS.admin.has('power:report')).toBe(true);
  });

  it('marks tenant-wide permissions as global', () => {
    for (const p of GLOBAL_PERMISSIONS) {
      expect(isGlobalPermission(p)).toBe(true);
    }
    expect(isGlobalPermission('findings:write')).toBe(false);
    expect(isGlobalPermission('users:manage')).toBe(true);
  });

  it('validates role strings', () => {
    expect(isRole('issm')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it('filters arbitrary claim values down to known roles', () => {
    expect(toRoles(['admin', 'guest', 'isso', ''])).toEqual(['admin', 'isso']);
  });

  it('unions permissions across multiple roles and ignores junk', () => {
    const perms = permissionsForRoles(['auditor', 'issm', 'not-a-role']);
    expect(perms.has('dashboard:read')).toBe(true); // from auditor
    expect(perms.has('poam:approve')).toBe(true); // from issm
    expect(perms.has('users:manage')).toBe(false); // admin-only
  });

  it('answers rolesGrant for a permission', () => {
    expect(rolesGrant(['operator'], 'scan:trigger')).toBe(true);
    expect(rolesGrant(['operator'], 'poam:approve')).toBe(false);
    expect(rolesGrant(['admin' as Role], 'users:manage')).toBe(true);
  });
});
