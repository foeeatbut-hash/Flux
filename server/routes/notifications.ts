import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';

// Личные уведомления: список и отметка «прочитано».
//
// Создание и рассылка (notify, notifyAll, pushNotification) остались в
// server.ts: они завязаны на сокет-сервер и нужны множеству других мест.
// Здесь только чтение и отметка.

export function registerNotificationRoutes(app: Express): void {
  app.get('/api/notifications', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const userId = String(req.query.userId || '');
      if (!userId) return res.json({ notifications: [] });
      const notifications = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.json({ notifications });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/notifications/read', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const { userId, id } = req.body;
      if (id) {
        await prisma.notification.update({ where: { id }, data: { isRead: true } });
      } else if (userId) {
        await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
