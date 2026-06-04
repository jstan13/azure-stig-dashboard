/**
 * GET /api/me — the caller's identity and effective authorization.
 *
 * The frontend uses this to drive permission-based UI gating: it shows/hides
 * navigation and action buttons based on the permissions returned here, rather
 * than hard-coding role names. The same resolution logic the route guards use
 * (token app roles + DB role bindings + Entra group mappings) is reused so the
 * UI never disagrees with the server's enforcement.
 *
 * Response shape:
 *   {
 *     oid, subject, upn, name,
 *     groupsOverage: boolean,
 *     globalRoles: string[],
 *     permissions: string[],            // permissions granted globally
 *     collections: [                    // per-boundary grants
 *       { id, name, roles: string[], permissions: string[] }
 *     ]
 *   }
 */
import { Router } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../database/dataSource';
import { CollectionEntity } from '../models/Collection';
import { resolveRoles } from '../middleware/authz';
import { permissionsForRoles } from '../auth/permissions';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const principal = req.principal;
    if (!principal) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const resolved = await resolveRoles({
      objectId: principal.objectId,
      appRoles: principal.appRoles,
      groups: principal.groups,
    });

    const globalRoles = [...resolved.global];
    const globalPermissions = [...permissionsForRoles(resolved.global)];

    // Look up friendly names for the scoped collections (best-effort; skipped
    // when running DB-free in mock mode).
    const scopedIds = [...resolved.byCollection.keys()];
    const names = new Map<string, string>();
    if (scopedIds.length > 0 && AppDataSource.isInitialized) {
      const rows = await AppDataSource.getRepository(CollectionEntity).find({
        where: { id: In(scopedIds) },
      });
      for (const c of rows) names.set(c.id, c.name);
    }

    const collections = scopedIds.map((id) => {
      const roles = resolved.byCollection.get(id) ?? new Set();
      return {
        id,
        name: names.get(id) ?? id,
        roles: [...roles],
        permissions: [...permissionsForRoles(roles)],
      };
    });

    return res.json({
      oid: principal.objectId,
      subject: principal.subject,
      upn: principal.upn ?? null,
      name: principal.name ?? null,
      groupsOverage: principal.groupsOverage,
      globalRoles,
      permissions: globalPermissions,
      collections,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
