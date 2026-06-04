import {
  can,
  permittedGlobally,
  permittedInCollections,
  permittedAnyScope,
  primaryGlobalRole,
} from '../../../src/auth/can';
import type { ResolvedRoles } from '../../../src/auth/roleResolver';
import type { Role } from '../../../src/auth/permissions';

function resolved(
  global: Role[],
  byCollection: Record<string, Role[]> = {},
): ResolvedRoles {
  return {
    global: new Set(global),
    byCollection: new Map(
      Object.entries(byCollection).map(([id, roles]) => [id, new Set(roles)]),
    ),
  };
}

const COLL_A = 'col-aaaa';
const COLL_B = 'col-bbbb';

describe('can() — global permissions', () => {
  it('requires a global grant and ignores Collection scope', () => {
    // users:manage is global; only a global admin grant satisfies it.
    const scopedAdmin = resolved([], { [COLL_A]: ['admin'] });
    expect(can({ resolved: scopedAdmin, permission: 'users:manage' })).toBe(false);
    expect(
      can({ resolved: scopedAdmin, permission: 'users:manage', collectionIds: [COLL_A] }),
    ).toBe(false);

    const globalAdmin = resolved(['admin']);
    expect(can({ resolved: globalAdmin, permission: 'users:manage' })).toBe(true);
  });
});

describe('can() — scopable permissions', () => {
  it('allows a global grant across every boundary', () => {
    const op = resolved(['operator']);
    expect(
      can({ resolved: op, permission: 'findings:write', collectionIds: [COLL_A] }),
    ).toBe(true);
    expect(
      can({ resolved: op, permission: 'findings:write', collectionIds: [COLL_B] }),
    ).toBe(true);
  });

  it('isolates a Collection-scoped grant to that boundary only', () => {
    // ISSO on Collection A may edit findings in A but not in B.
    const issoOnA = resolved([], { [COLL_A]: ['isso'] });
    expect(
      can({ resolved: issoOnA, permission: 'findings:write', collectionIds: [COLL_A] }),
    ).toBe(true);
    expect(
      can({ resolved: issoOnA, permission: 'findings:write', collectionIds: [COLL_B] }),
    ).toBe(false);
  });

  it('falls back to an any-scope check when scope is unknown', () => {
    const issoOnA = resolved([], { [COLL_A]: ['isso'] });
    // No collectionIds -> allowed because it holds the permission somewhere.
    expect(can({ resolved: issoOnA, permission: 'findings:write' })).toBe(true);
    // But a principal with no grant anywhere is denied.
    const auditor = resolved(['auditor']);
    expect(can({ resolved: auditor, permission: 'findings:write' })).toBe(false);
  });

  it('fails closed for a role that lacks the permission', () => {
    const auditorOnA = resolved([], { [COLL_A]: ['auditor'] });
    expect(
      can({ resolved: auditorOnA, permission: 'findings:write', collectionIds: [COLL_A] }),
    ).toBe(false);
    // ...but auditor can read its dashboard.
    expect(
      can({ resolved: auditorOnA, permission: 'dashboard:read', collectionIds: [COLL_A] }),
    ).toBe(true);
  });
});

describe('helper predicates', () => {
  it('permittedGlobally only consults global roles', () => {
    expect(permittedGlobally(resolved(['operator']), 'scan:trigger')).toBe(true);
    expect(
      permittedGlobally(resolved([], { [COLL_A]: ['operator'] }), 'scan:trigger'),
    ).toBe(false);
  });

  it('permittedInCollections checks only the listed boundaries', () => {
    const r = resolved([], { [COLL_A]: ['operator'] });
    expect(permittedInCollections(r, 'scan:trigger', [COLL_A])).toBe(true);
    expect(permittedInCollections(r, 'scan:trigger', [COLL_B])).toBe(false);
  });

  it('permittedAnyScope matches a grant in any boundary', () => {
    const r = resolved([], { [COLL_B]: ['operator'] });
    expect(permittedAnyScope(r, 'scan:trigger')).toBe(true);
    expect(permittedAnyScope(r, 'users:manage')).toBe(false);
  });
});

describe('primaryGlobalRole', () => {
  it('returns the highest-ranked global role', () => {
    expect(primaryGlobalRole(resolved(['auditor', 'issm']))).toBe('issm');
    expect(primaryGlobalRole(resolved(['admin', 'operator']))).toBe('admin');
  });

  it('returns "none" when there is no global role', () => {
    expect(primaryGlobalRole(resolved([], { [COLL_A]: ['admin'] }))).toBe('none');
  });
});
