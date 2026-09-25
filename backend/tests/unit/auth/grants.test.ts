import { grantDenial } from '../../../src/auth/grants';
import type { Role } from '../../../src/auth/permissions';
import type { ResolvedRoles } from '../../../src/auth/roleResolver';

const resolved = (global: Role[], byCollection: Record<string, Role[]> = {}): ResolvedRoles => ({
  global: new Set(global),
  byCollection: new Map(Object.entries(byCollection).map(([k, v]) => [k, new Set(v)])),
});

describe('grantDenial', () => {
  const scopedIssm = resolved([], { 'col-a': ['issm'] });

  it('stops a collection-scoped ISSM from granting any global role', () => {
    expect(grantDenial(scopedIssm, 'admin', null)).toMatch(/global/);
    expect(grantDenial(scopedIssm, 'auditor', null)).toMatch(/global/);
  });

  it('stops a collection-scoped ISSM from granting in another collection', () => {
    expect(grantDenial(scopedIssm, 'isso', 'col-b')).toMatch(/collection/);
  });

  it('lets a collection-scoped ISSM grant up to ISSM in its own collection', () => {
    expect(grantDenial(scopedIssm, 'isso', 'col-a')).toBeNull();
    expect(grantDenial(scopedIssm, 'issm', 'col-a')).toBeNull();
    expect(grantDenial(scopedIssm, 'admin', 'col-a')).toMatch(/above your own/);
  });

  it('stops a global ISSM from granting admin anywhere', () => {
    const issm = resolved(['issm']);
    expect(grantDenial(issm, 'issm', null)).toBeNull();
    expect(grantDenial(issm, 'isso', 'col-a')).toBeNull();
    expect(grantDenial(issm, 'admin', null)).toMatch(/above your own/);
    expect(grantDenial(issm, 'admin', 'col-a')).toMatch(/above your own/);
  });

  it('lets a global admin grant any role', () => {
    const admin = resolved(['admin']);
    expect(grantDenial(admin, 'admin', null)).toBeNull();
    expect(grantDenial(admin, 'admin', 'col-a')).toBeNull();
  });

  it('refuses callers below ISSM', () => {
    expect(grantDenial(resolved(['isso']), 'auditor', null)).not.toBeNull();
    expect(grantDenial(resolved([], { 'col-a': ['isso'] }), 'auditor', 'col-a')).not.toBeNull();
  });
});
