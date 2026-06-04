/**
 * Authorization middleware — `requirePermission()`.
 *
 * Replaces the flat `requireRole()` guard. It resolves the caller's effective
 * roles (token app roles + DB role bindings + Entra group mappings), optionally
 * resolves the Collection(s) the request targets, and allows the request only
 * when the permission is granted (globally or within a targeted Collection).
 *
 * Denials are audited (`result: 'Denied'`) and return 403.
 *
 * MOCK_MODE: the database is not connected, so role resolution falls back to the
 * synthetic principal's app roles (driven by `MOCK_ROLE`). Scope resolution is
 * skipped, so checks run in "any scope" mode against the mock global roles.
 */
import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/dataSource';
import {
  createRoleResolver,
  type RoleResolver,
  type ResolvedRoles,
  type ResolvablePrincipal,
} from '../auth/roleResolver';
import { can, primaryGlobalRole } from '../auth/can';
import { isRole, type Permission, type Role } from '../auth/permissions';
import { logger } from '../utils/logger';

const MOCK_MODE = process.env.MOCK_MODE === 'true';

let resolverSingleton: RoleResolver | undefined;
function resolver(): RoleResolver {
  if (!resolverSingleton) {
    resolverSingleton = createRoleResolver(AppDataSource);
  }
  return resolverSingleton;
}

/** Exposed so role/collection mutations can flush the resolver cache. */
export function invalidateAuthzCache(): void {
  resolverSingleton?.invalidate();
}

/** Exposed so endpoints (e.g. /api/me) can read collection membership. */
export function getRoleResolver(): RoleResolver {
  return resolver();
}

/**
 * Resolves a principal's roles. In MOCK_MODE (or before the DB is initialized)
 * this uses only the token/synthetic app roles so the app runs DB-free.
 *
 * Exported so endpoints that report a caller's effective access (e.g.
 * `GET /api/me`) compute roles identically to the route guards.
 */
export async function resolveRoles(p: ResolvablePrincipal): Promise<ResolvedRoles> {
  if (MOCK_MODE || !AppDataSource.isInitialized) {
    const global = new Set<Role>();
    for (const r of p.appRoles) if (isRole(r)) global.add(r);
    return { global, byCollection: new Map() };
  }
  return resolver().resolveRoles(p);
}

/**
 * A scope resolver derives the Collection ids a request targets. Returning
 * `undefined` means "scope unknown" -> the permission is checked in any-scope
 * mode. Scope resolvers are skipped entirely in MOCK_MODE.
 */
export type ScopeResolver = (
  req: Request,
  roleResolver: RoleResolver,
) => Promise<string[] | undefined>;

/** Scope by a machine id taken from a route param (default `machineId`). */
export function scopeByMachineParam(param = 'machineId'): ScopeResolver {
  return async (req, roleResolver) => {
    const machineId = req.params[param];
    if (!machineId) return undefined;
    return roleResolver.collectionsForMachine(machineId);
  };
}

/** Scope by a machine id taken from a request-body field (default `machineId`). */
export function scopeByMachineBody(field = 'machineId'): ScopeResolver {
  return async (req, roleResolver) => {
    const value = (req.body ?? {})[field];
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return roleResolver.collectionsForMachine(value);
  };
}

/**
 * Guard a route by a single permission, optionally scoped to the Collection(s)
 * resolved from the request.
 */
export function requirePermission(
  permission: Permission,
  scopeResolver?: ScopeResolver,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const resolved = await resolveRoles(principal);

      let collectionIds: string[] | undefined;
      if (scopeResolver && !MOCK_MODE && AppDataSource.isInitialized) {
        collectionIds = await scopeResolver(req, resolver());
      }

      if (can({ resolved, permission, collectionIds })) {
        req.authzScope = collectionIds && collectionIds.length === 1 ? collectionIds[0] : undefined;
        next();
        return;
      }

      await emitDenied(req, permission, primaryGlobalRole(resolved));
      res.status(403).json({
        error: 'Forbidden',
        message: `Requires permission: ${permission}`,
      });
    } catch (err) {
      logger.error(`Authorization error for ${permission}: ${(err as Error).message}`);
      res.status(500).json({ error: 'Authorization failed' });
    }
  };
}

/**
 * Separation-of-duties guard for approval endpoints: the approver must not be
 * the same person who requested/created the item.
 *
 * `getRequesterOid` loads the requester's Entra oid for the targeted entity.
 * If it returns null/undefined the check is skipped (nothing to compare).
 */
export function requireDifferentActor(
  getRequesterOid: (req: Request) => Promise<string | null | undefined>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const requesterOid = await getRequesterOid(req);
      if (requesterOid && requesterOid === principal.objectId) {
        await emitDenied(req, 'separation-of-duties', 'self');
        res.status(403).json({
          error: 'Forbidden',
          message: 'Separation of duties: you cannot approve your own request.',
        });
        return;
      }
      next();
    } catch (err) {
      logger.error(`SoD check error: ${(err as Error).message}`);
      res.status(500).json({ error: 'Authorization failed' });
    }
  };
}

async function emitDenied(
  req: Request,
  permission: string,
  actorRole: string,
): Promise<void> {
  const principal = req.principal;
  const audit = req.audit;
  if (!audit || !principal) return;
  await audit.record({
    actorUserId: principal.objectId,
    actorRole,
    action: `authz.denied:${permission}`,
    entityType: 'permission',
    entityId: permission,
    result: 'Denied',
    correlationId: req.correlationId ?? 'unknown',
    sourceIp: req.ip ?? 'unknown',
    after: { permission, path: req.originalUrl, method: req.method },
  });
}
