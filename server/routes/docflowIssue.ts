import type { Express, Request, Response } from 'express';
import { broadcast, sendError } from '../context.js';
import { docflowScope } from '../docflowScope.js';
import { planIssue, applyIssue, undoIssue, stateIssue, lastIssue } from '../docflowIssue.js';

/**
 * Выпуск ревизий (docs/docflow-program.md, 7.1). Право docflow.issue проверяет
 * общая таблица server/vdrPermissions.ts и ещё раз docflowScope; проект, строки
 * и файлы сверяет сам выпуск. Чтение состояния — только автору плана.
 */
export function registerDocflowIssueRoutes(app: Express) {
  const run = (action: 'plan' | 'apply' | 'undo' | 'state' | 'last') => async (req: Request, res: Response) => {
    try {
      const { projectId, actorId, prisma } = await docflowScope(req, 'docflow.issue');
      const planId = String(req.method === 'GET' ? req.query.planId || '' : req.body?.planId || '');
      const answer = action === 'plan' ? await planIssue(prisma, projectId, actorId, req.body)
        : action === 'apply' ? await applyIssue(prisma, projectId, actorId, planId, req.body?.hashes)
        : action === 'undo' ? await undoIssue(prisma, projectId, actorId, planId)
        : action === 'state' ? await stateIssue(prisma, projectId, actorId, planId)
        : await lastIssue(prisma, projectId, actorId);
      if (action === 'apply' || action === 'undo') broadcast('vdr:changed', { projectId });
      res.json(answer);
    } catch (err: any) {
      // Уникальный ключ «строка + ревизия», сверка плана и сериализация транзакций — это проигранная гонка, а не сбой сервера
      if (['P2002', 'P2034', 'P1008', 'P2028'].includes(err?.code)) return res.status(409).json({ error: 'Эту ревизию уже выпускает или выпустил другой запрос. Обновите реестр.', conflict: true });
      sendError(res, err, err.status || 500);
    }
  };
  app.post('/api/docflow/issue/plan', run('plan'));
  app.post('/api/docflow/issue/apply', run('apply'));
  app.post('/api/docflow/issue/undo', run('undo'));
  app.get('/api/docflow/issue/state', run('state'));
  app.get('/api/docflow/issue/last', run('last'));
}
