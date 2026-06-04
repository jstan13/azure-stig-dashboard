/**
 * roleResolver — production resolution of a principal's effective roles and the
 * Collection membership of assets.
 *
 * Two concerns:
 *
 *  1. resolveRoles(principal): merges every source of role grants into a single
 *     view — token app roles, direct RoleBindings (global + scoped), and
 *     GroupRoleMappings matched by the principal's Entra `groups` claim.
 *
 *  2. collectionsForMachine(machineId): which authorization boundaries a machine
 *     belongs to, via explicit CollectionAsset rows and tag-rule matching against
 *     the machine's Azure tags.
 *
 * Both are read-mostly, so a small TTL cache avoids hammering the DB on every
 * request. Caches are best-effort and safe to drop.
 */
import { DataSource } from 'typeorm';
import { RoleBindingEntity } from '../models/RoleBinding';
import { GroupRoleMappingEntity } from '../models/GroupRoleMapping';
import { CollectionEntity } from '../models/Collection';
import { CollectionAssetEntity } from '../models/CollectionAsset';
import { MachineEntity } from '../models/Machine';
import { isRole, type Role } from './permissions';

/** A principal's effective role grants, split into global vs per-Collection. */
export interface ResolvedRoles {
  /** Roles that apply across every boundary (token app roles + global grants). */
  global: Set<Role>;
  /** Roles granted only within a specific Collection (id -> roles). */
  byCollection: Map<string, Set<Role>>;
}

/** Minimal principal shape the resolver needs (subset of AuthenticatedPrincipal). */
export interface ResolvablePrincipal {
  objectId: string;
  appRoles: string[];
  groups: string[];
}

export interface RoleResolver {
  resolveRoles(principal: ResolvablePrincipal): Promise<ResolvedRoles>;
  collectionsForMachine(machineId: string): Promise<string[]>;
  /** Clears internal caches (call after role/collection mutations). */
  invalidate(): void;
}

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const DEFAULT_TTL_MS = 30_000;

function addRole(map: Map<string, Set<Role>>, collectionId: string, role: Role): void {
  let set = map.get(collectionId);
  if (!set) {
    set = new Set<Role>();
    map.set(collectionId, set);
  }
  set.add(role);
}

export function createRoleResolver(
  ds: DataSource,
  ttlMs: number = DEFAULT_TTL_MS,
): RoleResolver {
  const rolesCache = new Map<string, CacheEntry<ResolvedRoles>>();
  const membershipCache = new Map<string, CacheEntry<string[]>>();

  const bindingRepo = () => ds.getRepository(RoleBindingEntity);
  const groupMapRepo = () => ds.getRepository(GroupRoleMappingEntity);
  const collectionRepo = () => ds.getRepository(CollectionEntity);
  const assetRepo = () => ds.getRepository(CollectionAssetEntity);
  const machineRepo = () => ds.getRepository(MachineEntity);

  function rolesCacheKey(p: ResolvablePrincipal): string {
    // Group set affects the result, so include it in the key.
    return `${p.objectId}|${[...p.groups].sort().join(',')}|${[...p.appRoles].sort().join(',')}`;
  }

  async function resolveRoles(principal: ResolvablePrincipal): Promise<ResolvedRoles> {
    const key = rolesCacheKey(principal);
    const cached = rolesCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    const global = new Set<Role>();
    const byCollection = new Map<string, Set<Role>>();

    // 1. Token app roles are always global.
    for (const r of principal.appRoles) {
      if (isRole(r)) global.add(r);
    }

    // 2. Direct role bindings for this user (active only).
    const bindings = await bindingRepo().find({
      where: { subjectOid: principal.objectId },
    });
    for (const b of bindings) {
      if (b.revokedAt) continue;
      if (b.collectionId === null || b.collectionId === undefined) {
        global.add(b.role);
      } else {
        addRole(byCollection, b.collectionId, b.role);
      }
    }

    // 3. Group-based mappings for any group the principal carries.
    if (principal.groups.length > 0) {
      const mappings = await groupMapRepo()
        .createQueryBuilder('m')
        .where('m.groupObjectId IN (:...groups)', { groups: principal.groups })
        .getMany();
      for (const m of mappings) {
        if (m.collectionId === null || m.collectionId === undefined) {
          global.add(m.role);
        } else {
          addRole(byCollection, m.collectionId, m.role);
        }
      }
    }

    const resolved: ResolvedRoles = { global, byCollection };
    rolesCache.set(key, { value: resolved, expires: Date.now() + ttlMs });
    return resolved;
  }

  async function collectionsForMachine(machineId: string): Promise<string[]> {
    const cached = membershipCache.get(machineId);
    if (cached && cached.expires > Date.now()) return cached.value;

    const ids = new Set<string>();

    // Explicit membership.
    const explicit = await assetRepo().find({ where: { machineId } });
    for (const a of explicit) ids.add(a.collectionId);

    // Tag-rule membership: load the machine's tags and match against tag rules.
    const machine = await machineRepo().findOne({ where: { id: machineId } });
    const tags = machine?.tags ?? {};
    const tagCollections = await collectionRepo().find({
      where: { selectionMode: 'tag', status: 'active' },
    });
    for (const c of tagCollections) {
      if (matchesTagRule(tags, c.tagRule)) ids.add(c.id);
    }

    const result = [...ids];
    membershipCache.set(machineId, { value: result, expires: Date.now() + ttlMs });
    return result;
  }

  function invalidate(): void {
    rolesCache.clear();
    membershipCache.clear();
  }

  return { resolveRoles, collectionsForMachine, invalidate };
}

/** A machine matches a tag rule when its tags contain every key/value pair. */
function matchesTagRule(
  tags: Record<string, string>,
  rule: Record<string, string> | null | undefined,
): boolean {
  if (!rule) return false;
  const entries = Object.entries(rule);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => tags[k] === v);
}
