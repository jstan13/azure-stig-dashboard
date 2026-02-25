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
import { requireRole } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
const isMock = () => process.env.MOCK_MODE === 'true';

// Mock users seeded into mockStore on startup (see mockSeed.ts)
const MOCK_USERS = [
  { id: 'user-001', oid: 'oid-admin-001', displayName: 'Alice Admin', email: 'alice@example.com', role: 'admin', enabled: true },
  { id: 'user-002', oid: 'oid-analyst-002', displayName: 'Bob Analyst', email: 'bob@example.com', role: 'analyst', enabled: true },
  { id: 'user-003', oid: 'oid-viewer-003', displayName: 'Carol Viewer', email: 'carol@example.com', role: 'viewer', enabled: true },
  { id: 'user-004', oid: 'oid-auditor-004', displayName: 'Dave Auditor', email: 'dave@example.com', role: 'auditor', enabled: true },
];

// GET /api/users — admin only
router.get('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { search, role, page = '1', limit = '50' } = req.query;
    const safeLimit = Math.min(Number(limit), 200);
    const skip = (Number(page) - 1) * safeLimit;

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
    if (role) qb.where('u.role = :role', { role });
    if (search) {
      qb.andWhere('(LOWER(u.displayName) LIKE :s OR LOWER(u.email) LIKE :s)', {
        s: `%${String(search).toLowerCase()}%`,
      });
    }
    const [users, total] = await qb.getManyAndCount();
    return res.json({ users, total });
  } catch (err: any) {
    logger.error('[GET /users]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (isMock()) {
      const user = MOCK_USERS.find((u) => u.id === id || u.oid === id);
      return user ? res.json(user) : res.status(404).json({ error: 'User not found' });
    }
    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    return user ? res.json(user) : res.status(404).json({ error: 'User not found' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id — admin only
router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { displayName, role, enabled } = req.body;

    if (isMock()) {
      const user = MOCK_USERS.find((u) => u.id === id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (displayName !== undefined) user.displayName = displayName;
      if (role !== undefined)        user.role = role;
      if (enabled !== undefined)     user.enabled = enabled;
      return res.json(user);
    }

    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (displayName !== undefined) (user as any).displayName = displayName;
    if (role !== undefined)        (user as any).role = role;
    if (enabled !== undefined)     (user as any).enabled = enabled;
    const saved = await repo.save(user);
    return res.json(saved);
  } catch (err: any) {
    logger.error('[PATCH /users/:id]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/users/:id/roles — admin only
router.post('/:id/roles', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { roles } = req.body; // string[] or string

    if (isMock()) {
      const user = MOCK_USERS.find((u) => u.id === id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      user.role = Array.isArray(roles) ? roles[0] : roles;
      return res.json(user);
    }

    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    (user as any).role = Array.isArray(roles) ? roles[0] : roles;
    const saved = await repo.save(user);
    return res.json(saved);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id — admin only
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (isMock()) {
      const idx = MOCK_USERS.findIndex((u) => u.id === id);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });
      MOCK_USERS.splice(idx, 1);
      return res.status(204).send();
    }
    const repo = AppDataSource.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await repo.remove(user);
    return res.status(204).send();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
