import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';

// Личные уведомления: список и отметка «прочитано».
//
// Создание и рассылка (notify, notifyAll, pushNotification) остались в
// server.ts: они завязаны на сокет-сервер и нужны множеству других мест.
// Здесь только чтение и отметка.

export function registerNotificationRoutes(app: Express): void {
  // Раньше userId и id брались из запроса: можно было читать и отмечать чужие
  // уведомления. Теперь хозяин — только владелец сессии; присланный userId
  // либо совпадает с ним, либо игнорируется.
  app.get('/api/notifications', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const notifications = await prisma.notification.findMany({
        where: { userId: String(me.id) },
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
      const me = (req as any).authUser;
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const userId = String(me.id);
      const id = req.body?.id ? String(req.body.id) : '';
      if (id) {
        // Условие «и это его» стоит в самом запросе: чужой id ничего не затронет,
        // и по ответу не понять, существует ли такое уведомление у другого человека
        await prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true } });
      } else {
        await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
