import { createRoleResolver } from '../../../src/auth/roleResolver';
import { UserEntity } from '../../../src/models/User';
import { RoleBindingEntity } from '../../../src/models/RoleBinding';

function dataSource(user: Partial<UserEntity> | null) {
  const repos = new Map<unknown, unknown>([
    [UserEntity, { findOne: jest.fn(async () => user) }],
    [RoleBindingEntity, { find: jest.fn(async () => [{ role: 'issm', collectionId: null, revokedAt: null }]) }],
  ]);
  return { getRepository: (entity: unknown) => repos.get(entity) } as any;
}

const principal = { objectId: 'oid-1', appRoles: ['admin'], groups: [] };

describe('roleResolver disabled users', () => {
  it('grants nothing, not even token app roles, to a disabled user', async () => {
    const resolved = await createRoleResolver(dataSource({ oid: 'oid-1', isActive: false })).resolveRoles(principal);
    expect(resolved.global.size).toBe(0);
    expect(resolved.byCollection.size).toBe(0);
  });

  it('resolves roles normally for an enabled or unregistered user', async () => {
    for (const user of [{ oid: 'oid-1', isActive: true }, null]) {
      const resolved = await createRoleResolver(dataSource(user)).resolveRoles(principal);
      expect([...resolved.global].sort()).toEqual(['admin', 'issm']);
    }
  });
});
