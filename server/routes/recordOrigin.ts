import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { recordOrigin } from '../changeFeedRead.js';
import { VERSIONED_MODELS } from '../versionBump.js';
import { isAdminActor } from '../projectAccess.js';
import { canSeeProject } from './members.js';

/**
 * «Кто создал запись и когда» (server/changeFeedRead.ts): `GET /api/record-origin?model=&id=`.
 *
 * Ответ — `{ createdBy: { userId, name } | null, createdAt: ISO | null }`. Модель — из
 * перечня версионных (как в `OpenRecord`), иначе 400. Запись чужого проекта, который
 * человек не видит, не раскрывается: тот же 404, что и у записи, которой нет, — по
 * отказу нельзя угадать, существует ли она. Только вошедшему (личность — из сессии).
 */
export function registerRecordOriginRoutes(app: Express): void {
  app.get('/api/record-origin', async (req: Request, res: Response): Promise<unknown> => {
    try {
      const user = (req as any).authUser;
      if (!user?.id) return res.status(401).json({ error: 'Требуется вход' });
      const model = typeof req.query.model === 'string' ? req.query.model : '';
      const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
      if (!VERSIONED_MODELS.includes(model)) return res.status(400).json({ error: 'Модель записи не из перечня' });
      if (!id || id.length > 200) return res.status(400).json({ error: 'Не указан id записи' });
      const origin = await recordOrigin(getPrisma(), model, id);
      if (origin.projectId && !(await canSeeProject(String(user.id), origin.projectId, isAdminActor(user)))) {
        return res.status(404).json({ error: 'Запись не найдена' });
      }
      return res.json({ createdBy: origin.createdBy, createdAt: origin.createdAt });
    } catch (err: any) {
      sendError(res, err);
    }
  });
}
