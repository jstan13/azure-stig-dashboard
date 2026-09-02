/**
 * User Management API
 *
 * GET    /api/users           — list users (admin only)
 * GET    /api/users/:id       — get user profile
 * PATCH  /api/users/:id       — update user (displayName, role)
 * POST   /api/users/:id/roles — assign roles
 * DELETE /api/users/:id       — remove user
 */

import { Router, Request, Response } from 'express';
import { AppDataSource, mockStore } from '../database/dataSource';
import { UserEntity } from '../models/User';
import { requirePermission } from '../middleware/authz';
import { recordAudit } from '../auth';
import { ROLES, isRole } from '../auth/permissions';
import { sendServerError } from '../middleware/errorHandler';
import { parsePage, parsePageSize } from '../utils/paging';
import { z } from 'zod';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

const userResponse = (user: UserEntity) => ({
  id: user.id,
  oid: user.oid,
  email: user.email,
  displayName: user.displayName,
  role: user.roles?.[0] ?? 'auditor',
  roles: user.roles ?? [],
  enabled: user.isActive,
  lastLogin: user.lastLogin,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

// The persisted `role` column is informational/display only and does NOT grant
// access by itself. Real access control is enforced from Entra ID app-role and
// group claims in the JWT, resolved into global + Collection-scoped grants (see
// middleware/authn.ts and auth/roleResolver.ts). Editing it here keeps the
// directory in sync, but you must also assign the matching Entra app role (or a
// Collection role binding) for access to take effect.
const VALID_ROLES = ROLES;
function isValidRole(role: unknown): role is (typeof VALID_ROLES)[number] {
  return isRole(role);
}

const patchUserSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  role: z.enum(VALID_ROLES).optional(),
  enabled: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

const assignRoleSchema = z.object({
  roles: z.union([
    z.enum(VALID_ROLES),
    z.array(z.enum(VALID_ROLES)).min(1),
  ]),
});

// Mock users seeded into mockStore on startup (see mockSeed.ts)
const MOCK_USERS = [
  { id: 'user-001', oid: 'oid-admin-001', displayName: 'Alice Admin', email: 'alice@example.com', role: 'admin', enabled: true },
  { id: 'user-002', oid: 'oid-operator-002', displayName: 'Bob Operator', email: 'bob@example.com', role: 'operator', enabled: true },
  { id: 'user-003', oid: 'oid-auditor-003', displayName: 'Carol Auditor', email: 'carol@example.com', role: 'auditor', enabled: true },
  { id: 'user-004', oid: 'oid-auditor-004', displayName: 'Dave Auditor', email: 'dave@example.com', role: 'auditor', enabled: true },
];

// GET /api/users — admin only
router.get('/', requirePermission('users:manage'), async (req: Request, res: Response) => {
  try {
    const { search, role, page = '1', limit = '50' } = req.query;
    const safeLimit = parsePageSize(limit, 50, 200);
    const skip = (parsePage(page) - 1) * safeLimit;

    if (isMock()) {
      let users = [...MOCK_USERS];
      if (role) users = users.filter((u) => u.role === role);
      if (search) {
        const s = String(search).toLowerCase();
        users = users.filter((u) => u.displayName.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
      }
      return res.json({ users: users.slice(skip, skip + safeLimit), total: users.length });
    }

    const repo = AppDataSource.getRepository(UserEntity);
    const qb = repo.createQueryBuilder('u').skip(skip).take(safeLimit).orderBy('u.displayName', 'ASC');
    if (role) qb.where('u.roles = :role', { role });
    if (search) {
      qb.andWhere('(LOWER(u.displayName) LIKE :s OR LOWER(u.email) LIKE :s)', {
        s: `%${String(search).toLowerCase()}%`,
      });
    }
    const [users, total] = await qb.getManyAndCount();
    return res.json({ users: users.map(userResponse), total });
  } catch (err: any) {
    return sendServerError(res, '[GET /users]', err);
  }
});

// GET /api/users/:id \u2014 admin OR self (Audit #15)
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = (req as any).auth || {};
    const callerRoles: string[] = auth.roles || (auth.role ? [auth.role] : []);
    const callerId: string | undefined = auth.sub || auth.oid || auth.id;
    const isAdmin = callerRoles.includes('admin');
    const isSelf  = callerId !== undefined && (callerId === id);
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (isMock()) {
      const user = MOCK_USERS.find((u) => u.id === id || u.oid === id);
      return user ? res.json(user) : res.status(404).json({ error: 'User not found' });
    }
    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    return user ? res.json(userResponse(user)) : res.status(404).json({ error: 'User not found' });
  } catch (err: any) {
    return sendServerError(res, '[GET /users/:id]', err);
  }
});

// PATCH /api/users/:id — admin only
router.patch('/:id', requirePermission('users:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parse = patchUserSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid user update payload', details: parse.error.flatten() });
    }

    const { displayName, role, enabled } = parse.data;

    if (role !== undefined && !isValidRole(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }

    if (isMock()) {
      const user = MOCK_USERS.find((u) => u.id === id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const before = { displayName: user.displayName, role: user.role, enabled: user.enabled };
      if (displayName !== undefined) user.displayName = displayName;
      if (role !== undefined)        user.role = role;
      if (enabled !== undefined)     user.enabled = enabled;
      await recordAudit(req, {
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        before,
        after: { displayName: user.displayName, role: user.role, enabled: user.enabled },
        result: 'Success',
      });
      return res.json(user);
    }

    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const before = {
      displayName: user.displayName,
      role: user.roles?.[0] ?? 'auditor',
      enabled: user.isActive,
    };
    if (displayName !== undefined) user.displayName = displayName;
    if (role !== undefined)        user.roles = [role];
    if (enabled !== undefined)     user.isActive = enabled;
    const saved = await repo.save(user);
    await recordAudit(req, {
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      before,
      after: {
        displayName: saved.displayName,
        role: saved.roles?.[0] ?? 'auditor',
        enabled: saved.isActive,
      },
      result: 'Success',
    });
    return res.json(userResponse(saved));
  } catch (err: any) {
    return sendServerError(res, '[PATCH /users/:id]', err);
  }
});

// POST /api/users/:id/roles — admin only
router.post('/:id/roles', requirePermission('roles:assign'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parse = assignRoleSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid role payload', details: parse.error.flatten() });
    }

    const { roles } = parse.data;

    const requestedRole = Array.isArray(roles) ? roles[0] : roles;
    if (!isValidRole(requestedRole)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }

    if (isMock()) {
      const user = MOCK_USERS.find((u) => u.id === id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const before = { role: user.role };
      user.role = Array.isArray(roles) ? roles[0] : roles;
      await recordAudit(req, {
        action: 'user.role_assigned',
        entityType: 'user',
        entityId: id,
        before,
        after: { role: user.role },
        result: 'Success',
      });
      return res.json(user);
    }

    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const before = { role: user.roles?.[0] ?? 'auditor' };
    user.roles = [Array.isArray(roles) ? roles[0] : roles];
    const saved = await repo.save(user);
    await recordAudit(req, {
      action: 'user.role_assigned',
      entityType: 'user',
      entityId: id,
      before,
      after: { role: saved.roles?.[0] ?? 'auditor' },
      result: 'Success',
    });
    return res.json(userResponse(saved));
  } catch (err: any) {
    return sendServerError(res, '[POST /users/:id/roles]', err);
  }
});

// DELETE /api/users/:id — admin only
router.delete('/:id', requirePermission('users:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (isMock()) {
      const idx = MOCK_USERS.findIndex((u) => u.id === id);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });
      const before = { ...MOCK_USERS[idx] };
      MOCK_USERS.splice(idx, 1);
      await recordAudit(req, {
        action: 'user.deleted',
        entityType: 'user',
        entityId: id,
        before,
        result: 'Success',
      });
      return res.status(204).send();
    }
    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await repo.remove(user);
    await recordAudit(req, {
      action: 'user.deleted',
      entityType: 'user',
      entityId: id,
      before: { id: (user as any).id, email: (user as any).email },
      result: 'Success',
    });
    return res.status(204).send();
  } catch (err: any) {
    return sendServerError(res, '[DELETE /users/:id]', err);
  }
});

export default router;
