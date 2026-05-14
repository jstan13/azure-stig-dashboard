/**
 * Role-based access control (constitution Principle II, FR-002, FR-003).
 *
 * Combines:
 *   1. App role from the JWT (`admin` | `operator` | `auditor`) — governs
 *      tenant-wide actions like creating Collections.
 *   2. Collection-scoped role bindings persisted in the database — the same
 *      user can be `auditor` on Collection A and `operator` on Collection B.
 *
 * A request is authorized iff:
 *   - For unscoped requirements: caller holds the required app role.
 *   - For Collection-scoped requirements: caller either holds the app role
 *     (admin satisfies any) or has an active RoleBinding for that Collection
 *     at or above the required role per the hierarchy admin > operator > auditor.
 *
 * Every denial emits an AuditLog `Denied` row via the injected `AuditSink`.
 */
import { type AuditSink } from './audit';

export type Role = 'admin' | 'operator' | 'auditor';

const HIERARCHY: Record<Role, number> = {
  admin: 3,
  operator: 2,
  auditor: 1,
};

export interface AuthorizedPrincipal {
  subject: string;
  objectId: string;
  upn?: string | undefined;
  appRoles: string[];
}

export interface RoleBinding {
  collectionId: string;
  role: Role;
}

/** Resolves the active Collection-scoped RoleBindings for an Entra OID. */
export type RoleBindingLookup = (objectId: string) => Promise<RoleBinding[]>;

export interface AuthorizeArgs {
  principal: AuthorizedPrincipal;
  /**
   * The role required and (optionally) the Collection it must apply to.
   * If `collectionId` is omitted, this is an unscoped requirement (e.g. an
   * admin-only operation that does not act on a specific Collection).
   */
  require: { role: Role; collectionId?: string };
  bindings: RoleBindingLookup;
  audit: AuditSink;
  /** Action label used in AuditLog rows on denial, e.g. `Scan.Trigger`. */
  action: string;
  correlationId: string;
  sourceIp?: string;
  /** entity type/id used to label the audit row when authorization fails. */
  entityType?: string;
  entityId?: string;
}

export class RbacDeniedError extends Error {
  public override readonly name = 'RbacDeniedError';
  public readonly action: string;
  public readonly required: Role;
  public readonly collectionId: string | undefined;

  constructor(
    action: string,
    required: Role,
    collectionId: string | undefined,
  ) {
    super(
      collectionId
        ? `Denied ${action}: requires ${required} on Collection ${collectionId}`
        : `Denied ${action}: requires ${required}`,
    );
    this.action = action;
    this.required = required;
    this.collectionId = collectionId;
  }
}

function rank(role: Role | undefined): number {
  return role ? HIERARCHY[role] : 0;
}

function highestAppRole(appRoles: string[]): Role | undefined {
  let best: Role | undefined;
  for (const r of appRoles) {
    if (r === 'admin' || r === 'operator' || r === 'auditor') {
      if (rank(r) > rank(best)) {
        best = r;
      }
    }
  }
  return best;
}

export async function authorize(args: AuthorizeArgs): Promise<void> {
  const required = args.require.role;
  const requiredRank = rank(required);

  // Admin app role always wins.
  const appRole = highestAppRole(args.principal.appRoles);
  if (appRole && rank(appRole) >= requiredRank) {
    return;
  }

  // For unscoped requirements, only an app role can satisfy.
  if (!args.require.collectionId) {
    await emitDenied(args, required, undefined);
    throw new RbacDeniedError(args.action, required, undefined);
  }

  // For scoped requirements, look up Collection-scoped bindings.
  const bindings = await args.bindings(args.principal.objectId);
  const matching = bindings.filter(
    (b) => b.collectionId === args.require.collectionId,
  );
  const bestScopedRank = matching.reduce((acc, b) => Math.max(acc, rank(b.role)), 0);

  if (bestScopedRank >= requiredRank) {
    return;
  }

  await emitDenied(args, required, args.require.collectionId);
  throw new RbacDeniedError(args.action, required, args.require.collectionId);
}

async function emitDenied(
  args: AuthorizeArgs,
  required: Role,
  collectionId: string | undefined,
): Promise<void> {
  await args.audit.record({
    actorUserId: args.principal.objectId,
    actorRole: highestAppRole(args.principal.appRoles) ?? 'none',
    action: args.action,
    entityType: args.entityType ?? (collectionId ? 'Collection' : 'Tenant'),
    entityId: args.entityId ?? collectionId ?? 'tenant',
    result: 'Denied',
    correlationId: args.correlationId,
    sourceIp: args.sourceIp ?? 'unknown',
    after: { required, collectionId },
  });
}
