import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';

// Журнал системных изменений (кто что менял) — читается на «Главной» и в логах.
export function registerLogRoutes(app: Express): void {
  // Последние записи (200)
  app.get('/api/logs', async (_req: Request, res: Response) => {
    try {
      const logs = await getPrisma().systemChangeLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
      res.json({ logs });
    } catch (err: any) { sendError(res, err); }
  });

  // Добавить запись в журнал
  app.post('/api/logs', async (req: Request, res: Response) => {
    try {
      const { description, targetRoute } = req.body;
      // Автор — тот, кто вошёл, а не тот, кем назвалось окно: имя из тела
      // запроса позволяло записать действие на любого сотрудника
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });
      const log = await getPrisma().systemChangeLog.create({
        data: {
          userName: me.name || me.symbol || 'Сотрудник',
          userSymbol: me.symbol || '',
          description,
          targetRoute: targetRoute || '',
        },
      });
      res.json({ log });
    } catch (err: any) { sendError(res, err); }
  });
}
