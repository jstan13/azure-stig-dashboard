/**
 * Collection & role-assignment administration.
 *
 *   Collections (authorization boundaries / ATOs):
 *     GET    /api/collections                         list
 *     POST   /api/collections                         create
 *     GET    /api/collections/:id                     detail (+ assets)
 *     PATCH  /api/collections/:id                     update
 *     DELETE /api/collections/:id                     archive (soft delete)
 *     GET    /api/collections/:id/assets              list explicit assets
 *     POST   /api/collections/:id/assets              add a machine
 *     DELETE /api/collections/:id/assets/:machineId   remove a machine
 *
 *   Role assignments (who gets which role, optionally scoped):
 *     GET    /api/collections/role-bindings           list active bindings
 *     POST   /api/collections/role-bindings           grant a role
 *     DELETE /api/collections/role-bindings/:id       revoke (soft)
 *     GET    /api/collections/group-mappings          list Entra group->role maps
 *     POST   /api/collections/group-mappings          map a group to a role
 *     DELETE /api/collections/group-mappings/:id      remove a mapping
 *
 * Collection management requires `collection:manage`; role/group assignment
 * requires `roles:assign`. Every mutation flushes the authz resolver cache so
 * grants take effect on the next request.
 */
import { Router } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../database/dataSource';
import { CollectionEntity } from '../models/Collection';
import { CollectionAssetEntity } from '../models/CollectionAsset';
import { RoleBindingEntity } from '../models/RoleBinding';
import { GroupRoleMappingEntity } from '../models/GroupRoleMapping';
import { requirePermission, invalidateAuthzCache } from '../middleware/authz';
import { recordAudit } from '../auth';
import { createError } from '../middleware/errorHandler';
import { isRole, ROLES } from '../auth/permissions';

const router = Router();

const MOCK = () => process.env.MOCK_MODE === 'true';

/** These admin endpoints require a real database. */
function ensureDb(): void {
  if (MOCK() || !AppDataSource.isInitialized) {
    throw createError('Administration endpoints are unavailable in mock mode', 503, 'MOCK_MODE');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Role bindings  (declared before /:id so the literal paths win)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/role-bindings', requirePermission('roles:assign'), async (req, res, next) => {
  try {
    ensureDb();
    const { subjectOid, collectionId } = req.query as Record<string, string>;
    const where: Record<string, unknown> = { revokedAt: IsNull() };
    if (subjectOid) where.subjectOid = subjectOid;
    if (collectionId) where.collectionId = collectionId;
    const rows = await AppDataSource.getRepository(RoleBindingEntity).find({ where });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/role-bindings', requirePermission('roles:assign'), async (req, res, next) => {
  try {
    ensureDb();
    const { subjectOid, role } = req.body ?? {};
    const collectionId: string | null = req.body?.collectionId ?? null;

    if (!subjectOid || typeof subjectOid !== 'string') {
      return next(createError('subjectOid is required', 400, 'VALIDATION_ERROR'));
    }
    if (!isRole(role)) {
      return next(createError(`role must be one of: ${ROLES.join(', ')}`, 400, 'VALIDATION_ERROR'));
    }

    const repo = AppDataSource.getRepository(RoleBindingEntity);

    if (collectionId) {
      const exists = await AppDataSource.getRepository(CollectionEntity).findOne({ where: { id: collectionId } });
      if (!exists) return next(createError('Collection not found', 404, 'NOT_FOUND'));
    }

    // App-level active uniqueness (NULL collectionId is distinct in SQL UNIQUE).
    const active = await repo.findOne({
      where: {
        subjectOid,
        collectionId: collectionId ?? IsNull(),
        role,
        revokedAt: IsNull(),
      },
    });
    if (active) {
      return res.status(200).json(active);
    }

    const binding = repo.create({
      subjectOid,
      collectionId,
      role,
      grantedBy: req.principal?.objectId ?? null,
      revokedAt: null,
    });
    await repo.save(binding);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'rbac.role_granted',
      entityType: 'role_binding',
      entityId: binding.id,
      after: { subjectOid, role, collectionId },
      result: 'Success',
    });
    res.status(201).json(binding);
  } catch (err) { next(err); }
});

router.delete('/role-bindings/:id', requirePermission('roles:assign'), async (req, res, next) => {
  try {
    ensureDb();
    const repo = AppDataSource.getRepository(RoleBindingEntity);
    const binding = await repo.findOne({ where: { id: req.params.id } });
    if (!binding) return next(createError('Role binding not found', 404, 'NOT_FOUND'));
    if (binding.revokedAt) return res.status(200).json(binding);

    binding.revokedAt = new Date();
    await repo.save(binding);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'rbac.role_revoked',
      entityType: 'role_binding',
      entityId: binding.id,
      before: { subjectOid: binding.subjectOid, role: binding.role, collectionId: binding.collectionId },
      result: 'Success',
    });
    res.status(200).json(binding);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Group -> role mappings
// ─────────────────────────────────────────────────────────────────────────────
router.get('/group-mappings', requirePermission('roles:assign'), async (req, res, next) => {
  try {
    ensureDb();
    const rows = await AppDataSource.getRepository(GroupRoleMappingEntity).find();
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/group-mappings', requirePermission('roles:assign'), async (req, res, next) => {
  try {
    ensureDb();
    const { groupObjectId, groupDisplayName, role } = req.body ?? {};
    const collectionId: string | null = req.body?.collectionId ?? null;

    if (!groupObjectId || typeof groupObjectId !== 'string') {
      return next(createError('groupObjectId is required', 400, 'VALIDATION_ERROR'));
    }
    if (!isRole(role)) {
      return next(createError(`role must be one of: ${ROLES.join(', ')}`, 400, 'VALIDATION_ERROR'));
    }
    if (collectionId) {
      const exists = await AppDataSource.getRepository(CollectionEntity).findOne({ where: { id: collectionId } });
      if (!exists) return next(createError('Collection not found', 404, 'NOT_FOUND'));
    }

    const repo = AppDataSource.getRepository(GroupRoleMappingEntity);
    const existing = await repo.findOne({ where: { groupObjectId, collectionId: collectionId ?? IsNull(), role } });
    if (existing) return res.status(200).json(existing);

    const mapping = repo.create({
      groupObjectId,
      groupDisplayName: groupDisplayName ?? null,
      role,
      collectionId,
      createdBy: req.principal?.objectId ?? null,
    });
    await repo.save(mapping);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'rbac.group_mapped',
      entityType: 'group_role_mapping',
      entityId: mapping.id,
      after: { groupObjectId, role, collectionId },
      result: 'Success',
    });
    res.status(201).json(mapping);
  } catch (err) { next(err); }
});

router.delete('/group-mappings/:id', requirePermission('roles:assign'), async (req, res, next) => {
  try {
    ensureDb();
    const repo = AppDataSource.getRepository(GroupRoleMappingEntity);
    const mapping = await repo.findOne({ where: { id: req.params.id } });
    if (!mapping) return next(createError('Group mapping not found', 404, 'NOT_FOUND'));

    await repo.remove(mapping);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'rbac.group_unmapped',
      entityType: 'group_role_mapping',
      entityId: req.params.id,
      before: { groupObjectId: mapping.groupObjectId, role: mapping.role, collectionId: mapping.collectionId },
      result: 'Success',
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Collections
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requirePermission('collection:manage'), async (_req, res, next) => {
  try {
    ensureDb();
    const rows = await AppDataSource.getRepository(CollectionEntity).find({ order: { name: 'ASC' } });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const { name, description } = req.body ?? {};
    const selectionMode: 'tag' | 'explicit' = req.body?.selectionMode === 'tag' ? 'tag' : 'explicit';
    const tagRule = req.body?.tagRule ?? null;

    if (!name || typeof name !== 'string') {
      return next(createError('name is required', 400, 'VALIDATION_ERROR'));
    }
    if (selectionMode === 'tag' && (!tagRule || typeof tagRule !== 'object' || Object.keys(tagRule).length === 0)) {
      return next(createError('tagRule with at least one key/value is required for tag selection', 400, 'VALIDATION_ERROR'));
    }

    const repo = AppDataSource.getRepository(CollectionEntity);
    const collection = repo.create({
      name,
      description: description ?? null,
      tenantId: req.principal?.rawPayload?.tid as string ?? null,
      selectionMode,
      tagRule: selectionMode === 'tag' ? tagRule : null,
      status: 'active',
      createdBy: req.principal?.objectId ?? null,
    });
    await repo.save(collection);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'collection.created',
      entityType: 'collection',
      entityId: collection.id,
      after: { name, selectionMode },
      result: 'Success',
    });
    res.status(201).json(collection);
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const collection = await AppDataSource.getRepository(CollectionEntity).findOne({ where: { id: req.params.id } });
    if (!collection) return next(createError('Collection not found', 404, 'NOT_FOUND'));
    const assets = await AppDataSource.getRepository(CollectionAssetEntity).find({ where: { collectionId: collection.id } });
    res.json({ ...collection, assets });
  } catch (err) { next(err); }
});

router.patch('/:id', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const repo = AppDataSource.getRepository(CollectionEntity);
    const collection = await repo.findOne({ where: { id: req.params.id } });
    if (!collection) return next(createError('Collection not found', 404, 'NOT_FOUND'));

    const { name, description, selectionMode, tagRule, status } = req.body ?? {};
    if (name !== undefined) collection.name = name;
    if (description !== undefined) collection.description = description;
    if (selectionMode === 'tag' || selectionMode === 'explicit') collection.selectionMode = selectionMode;
    if (tagRule !== undefined) collection.tagRule = tagRule;
    if (status === 'active' || status === 'archived') collection.status = status;

    await repo.save(collection);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'collection.updated',
      entityType: 'collection',
      entityId: collection.id,
      after: { name: collection.name, status: collection.status, selectionMode: collection.selectionMode },
      result: 'Success',
    });
    res.json(collection);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const repo = AppDataSource.getRepository(CollectionEntity);
    const collection = await repo.findOne({ where: { id: req.params.id } });
    if (!collection) return next(createError('Collection not found', 404, 'NOT_FOUND'));

    collection.status = 'archived';
    await repo.save(collection);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'collection.archived',
      entityType: 'collection',
      entityId: collection.id,
      before: { status: 'active' },
      after: { status: 'archived' },
      result: 'Success',
    });
    res.status(200).json(collection);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Collection assets (explicit membership)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/assets', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const rows = await AppDataSource.getRepository(CollectionAssetEntity).find({ where: { collectionId: req.params.id } });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/:id/assets', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const collectionId = req.params.id;
    const { machineId } = req.body ?? {};
    if (!machineId || typeof machineId !== 'string') {
      return next(createError('machineId is required', 400, 'VALIDATION_ERROR'));
    }
    const collection = await AppDataSource.getRepository(CollectionEntity).findOne({ where: { id: collectionId } });
    if (!collection) return next(createError('Collection not found', 404, 'NOT_FOUND'));

    const repo = AppDataSource.getRepository(CollectionAssetEntity);
    const existing = await repo.findOne({ where: { collectionId, machineId } });
    if (existing) return res.status(200).json(existing);

    const asset = repo.create({ collectionId, machineId, addedBy: req.principal?.objectId ?? null });
    await repo.save(asset);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'collection.asset_added',
      entityType: 'collection_asset',
      entityId: asset.id,
      after: { collectionId, machineId },
      result: 'Success',
    });
    res.status(201).json(asset);
  } catch (err) { next(err); }
});

router.delete('/:id/assets/:machineId', requirePermission('collection:manage'), async (req, res, next) => {
  try {
    ensureDb();
    const { id: collectionId, machineId } = req.params;
    const repo = AppDataSource.getRepository(CollectionAssetEntity);
    const asset = await repo.findOne({ where: { collectionId, machineId } });
    if (!asset) return next(createError('Asset not found in collection', 404, 'NOT_FOUND'));

    await repo.remove(asset);
    invalidateAuthzCache();

    await recordAudit(req, {
      action: 'collection.asset_removed',
      entityType: 'collection_asset',
      entityId: `${collectionId}:${machineId}`,
      before: { collectionId, machineId },
      result: 'Success',
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
