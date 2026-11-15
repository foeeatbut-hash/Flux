import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { HOLDER_KEY_FORMAT, parseOpenList, reportOpen } from '../openRecords.js';
import { OPEN_MAX_RECORDS } from '../../src/lib/openRecordTime.js';

/**
 * Отметка «эти записи у меня сейчас открыты» (server/openRecords.ts).
 *
 * Два метода на один путь с одним телом: PUT — обычный удар окна, POST — тот
 * же запрос при закрытии окна (`pagehide`), когда PUT уже не дожидается ответа.
 * Куки и заголовок защиты от подделки запроса маяк `sendBeacon` приложить не
 * умеет, поэтому окно шлёт его `fetch` с `keepalive` и обычными заголовками.
 *
 * Только вошедшему: путь не в перечне открытых без входа, личность — из сессии
 * (`authUser`), никогда из тела.
 */
export function registerOpenRecordRoutes(app: Express): void {
  const handler = async (req: Request, res: Response): Promise<unknown> => {
    try {
      const userId = String((req as any).authUser?.id || '');
      if (!userId) return res.status(401).json({ error: 'Требуется вход' });
      const holderKey = typeof req.body?.holderKey === 'string' ? req.body.holderKey : '';
      if (!HOLDER_KEY_FORMAT.test(holderKey)) return res.status(400).json({ error: 'Ключ окна не читается: нужно 8–64 символа, латиница, цифры, «_» и «-»' });
      const records = parseOpenList(req.body?.records);
      if (!records) return res.status(400).json({ error: `Список открытых записей не читается: не больше ${OPEN_MAX_RECORDS}, у каждой модель из перечня версионных и непустой id` });
      await reportOpen(getPrisma(), { userId, holderKey, records });
      return res.json({ ok: true, count: records.length });
    } catch (err: any) {
      // Отметка не должна ронять экран: окно переживёт отказ и повторит через 15 с
      sendError(res, err, 503);
    }
  };
  app.put('/api/open-records', handler);
  app.post('/api/open-records', handler);
}
