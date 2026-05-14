/**
 * Failing-first unit tests for backend/src/auth/rbac.ts (constitution VII).
 *
 * The RBAC layer enforces:
 *   - app role required from JWT (admin | operator | auditor)
 *   - Collection-scoped role bindings persisted in the database
 *   - Denial paths emit an AuditLog row with result="Denied"
 *
 * Tests inject a deterministic role-binding lookup and audit sink so no DB
 * is required at this layer.
 */
import {
  authorize,
  RbacDeniedError,
  type RoleBindingLookup,
  type AuthorizedPrincipal,
} from '../../../src/auth/rbac';
import { type AuditSink } from '../../../src/auth/audit';

function principal(
  overrides: Partial<AuthorizedPrincipal> = {},
): AuthorizedPrincipal {
  return {
    subject: 'sub-1',
    objectId: 'oid-1',
    upn: 'user@example.onmicrosoft.com',
    appRoles: [],
    ...overrides,
  };
}

function audit(): AuditSink & { records: any[] } {
  const records: any[] = [];
  return {
    records,
    record: jest.fn(async (entry) => {
      records.push(entry);
    }),
  };
}

const noBindings: RoleBindingLookup = async () => [];

describe('authorize()', () => {
  it('allows when caller has the required app role globally', async () => {
    const sink = audit();
    await expect(
      authorize({
        principal: principal({ appRoles: ['admin'] }),
        require: { role: 'admin' },
        bindings: noBindings,
        audit: sink,
        action: 'Collection.Create',
        correlationId: 'corr-1',
      }),
    ).resolves.toBeUndefined();
    expect(sink.records).toHaveLength(0);
  });

  it('denies when caller has no role at all and emits AuditLog Denied', async () => {
    const sink = audit();
    await expect(
      authorize({
        principal: principal({ appRoles: [] }),
        require: { role: 'operator' },
        bindings: noBindings,
        audit: sink,
        action: 'Scan.Trigger',
        correlationId: 'corr-2',
      }),
    ).rejects.toBeInstanceOf(RbacDeniedError);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      action: 'Scan.Trigger',
      result: 'Denied',
      correlationId: 'corr-2',
    });
  });

  it('allows when caller has a Collection-scoped binding for the required role', async () => {
    const sink = audit();
    const lookup: RoleBindingLookup = async (oid) =>
      oid === 'oid-1'
        ? [{ collectionId: 'coll-A', role: 'operator' }]
        : [];

    await expect(
      authorize({
        principal: principal({ appRoles: [] }),
        require: { role: 'operator', collectionId: 'coll-A' },
        bindings: lookup,
        audit: sink,
        action: 'Finding.Update',
        correlationId: 'corr-3',
      }),
    ).resolves.toBeUndefined();
    expect(sink.records).toHaveLength(0);
  });

  it('denies when caller has the role on a different Collection', async () => {
    const sink = audit();
    const lookup: RoleBindingLookup = async () => [
      { collectionId: 'coll-B', role: 'operator' },
    ];

    await expect(
      authorize({
        principal: principal({ appRoles: [] }),
        require: { role: 'operator', collectionId: 'coll-A' },
        bindings: lookup,
        audit: sink,
        action: 'Finding.Update',
        correlationId: 'corr-4',
      }),
    ).rejects.toBeInstanceOf(RbacDeniedError);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].result).toBe('Denied');
  });

  it('honors the role hierarchy: admin satisfies operator and auditor', async () => {
    const sink = audit();
    await expect(
      authorize({
        principal: principal({ appRoles: ['admin'] }),
        require: { role: 'auditor', collectionId: 'coll-X' },
        bindings: noBindings,
        audit: sink,
        action: 'Finding.Read',
        correlationId: 'corr-5',
      }),
    ).resolves.toBeUndefined();
  });

  it('honors the role hierarchy: operator satisfies auditor', async () => {
    const sink = audit();
    const lookup: RoleBindingLookup = async () => [
      { collectionId: 'coll-X', role: 'operator' },
    ];
    await expect(
      authorize({
        principal: principal({ appRoles: [] }),
        require: { role: 'auditor', collectionId: 'coll-X' },
        bindings: lookup,
        audit: sink,
        action: 'Finding.Read',
        correlationId: 'corr-6',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects when an unscoped require uses a Collection-scoped binding only', async () => {
    const sink = audit();
    const lookup: RoleBindingLookup = async () => [
      { collectionId: 'coll-X', role: 'admin' },
    ];
    await expect(
      authorize({
        principal: principal({ appRoles: [] }),
        require: { role: 'admin' }, // unscoped admin — needs global app role
        bindings: lookup,
        audit: sink,
        action: 'Tenant.Manage',
        correlationId: 'corr-7',
      }),
    ).rejects.toBeInstanceOf(RbacDeniedError);
  });
});
