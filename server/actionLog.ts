/**
 * Журнал действий: кто, что сделал, над чем, когда и где.
 *
 * Две вещи, которые здесь важнее кода.
 *
 * ПИШЕТ СЕРВЕР. Записи, которую делает окно, грош цена: окно можно закрыть,
 * запрос отправить мимо него, а строку — не отправить вовсе. Журнал, который
 * можно обойти закрытием вкладки, отвечает на вопрос «кто это сделал» только
 * тогда, когда отвечать не надо.
 *
 * ЧИТАЕТСЯ ПО ПРАВУ. Журнал показывает действия всех сотрудников, и это
 * средство разбирательства, а не работы. По умолчанию право выключено у всех,
 * кроме администратора (src/lib/permissions.ts, «Журнал действий»).
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { describeAction, isNoise } from './actionWords.js';
import { ensureTables as ensureDbTables } from './ddl.js';
import { intParam } from './queryParams.js';

export interface ActionLogDeps {
  getPrisma: () => any;
  /** Есть ли у человека право читать журнал */
  can: (user: any, feature: string) => boolean;
}

export function registerActionLog(app: Express, deps: ActionLogDeps): void {
  let ready = false;
  const ensure = async (): Promise<void> => {
    if (ready) return;
    try {
      await deps.getPrisma().actionLog.findFirst({ select: { what: true } });
      ready = true;
    } catch (_) {
      // Таблицы может не быть в базе, созданной прежней версией. И «таблица
      // есть» не значит «таблица правильная» — проверяем именно колонку
      const why = await ensureDbTables(deps.getPrisma(), [{
        table: 'ActionLog',
        cols: [
          { name: 'id', kind: 'text', pk: true },
          { name: 'userId', kind: 'text', notNull: true, def: '', indexed: true },
          { name: 'userName', kind: 'text', notNull: true, def: '' },
          { name: 'what', kind: 'text', notNull: true, def: '' },
          { name: 'target', kind: 'text', notNull: true, def: '' },
          { name: 'route', kind: 'text', notNull: true, def: '' },
          { name: 'createdAt', kind: 'time', notNull: true, def: 'now', indexed: true },
        ],
        indexes: [{ name: 'ActionLog_createdAt_idx', cols: ['createdAt'] }],
      }], (m) => console.error('[Журнал]', m));
      if (why) throw new Error(why);
      ready = true;
    }
  };

  /**
   * Пишем после ответа, а не до него: неудавшееся действие действием не было,
   * и записывать попытку как совершённое — значит наполнять журнал неправдой.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const method = req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (!String(req.path || '').startsWith('/api/')) return next();
    if (isNoise(req.path)) return next();

    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const user = (req as any).authUser;
      if (!user) return;
      const words = describeAction(method, req.path);
      if (!words) return;
      void (async () => {
        try {
          await ensure();
          await deps.getPrisma().actionLog.create({
            data: {
              userId: String(user.id || ''),
              userName: String(user.name || user.symbol || 'Сотрудник'),
              what: words.what.slice(0, 180),
              target: words.target.slice(0, 180),
              route: words.route.slice(0, 180),
            },
          });
        } catch (e: any) {
          // Журнал не должен ломать работу: не записалось — сказали в консоль
          console.error('[Журнал] Действие не записано:', e?.message || e);
        }
      })();
    });
    next();
  });

  app.get('/api/logs/actions', async (req: Request, res: Response) => {
    const user = (req as any).authUser;
    if (!deps.can(user, 'log.view')) {
      return res.status(403).json({ error: 'Журнал действий доступен по праву «Журнал действий»' });
    }
    try {
      await ensure();
      const take = intParam(req.query.take, 200, 1, 500);
      const who = String(req.query.userId || '');
      const rows = await deps.getPrisma().actionLog.findMany({
        where: who ? { userId: who } : undefined,
        orderBy: { createdAt: 'desc' },
        take,
      });
      res.json({ actions: rows });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Не удалось прочитать журнал' });
    }
  });
}
