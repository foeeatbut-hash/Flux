import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { parsePermissions } from '../../src/lib/permissions.js';

// Права перечитываются из базы: изменение роли не ждёт нового входа.
export function registerPolicyRoutes(app: Express): void {
  app.get('/api/me/bootstrap', async (req: Request, res: Response) => {
    const actor = (req as any).authUser;
    if (!actor) return res.status(401).json({ error: 'Требуется вход в систему' });
    try {
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { permissions: true, role: true } });
      if (!user) return res.status(401).json({ error: 'Требуется вход в систему' });
      const role = await prisma.role.findUnique({ where: { code: user.role }, select: { permissions: true } });
      const current = (value: string | null) => Object.fromEntries(
        Object.entries(parsePermissions(value)).filter(([key]) => !/^(?:app\.play|play[._:]|game\.)/i.test(key)),
      );
      return res.json({ permissions: current(user.permissions), rolePermissions: current(role?.permissions ?? null) });
    } catch (_) {
      return res.status(503).json({ error: 'Не удалось прочитать доступ' });
    }
  });
}
