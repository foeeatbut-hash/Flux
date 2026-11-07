import type { Express, Request, Response } from 'express';
import { broadcast, sendError } from '../context.js';
import { docflowScope } from '../docflowScope.js';
import { listKitDocuments, planKitRows, applyKitRows, undoKitRows } from '../docflowKitRows.js';

export function registerDocflowKitRoutes(app: Express) {
  const run = (action: 'list' | 'plan' | 'apply' | 'undo') => async (req: Request, res: Response) => {
    try {
      const { projectId, actorId, prisma } = await docflowScope(req, action === 'list' ? 'docflow.view' : 'docflow.edit');
      const result = action === 'list' ? await listKitDocuments(prisma, projectId, typeof req.query.tagId === 'string' ? req.query.tagId : undefined, typeof req.query.stage === 'string' ? req.query.stage : undefined, actorId)
        : action === 'plan' ? await planKitRows(prisma, projectId, actorId, req.body)
        : action === 'apply' ? await applyKitRows(prisma, projectId, actorId, req.body?.planId)
        : await undoKitRows(prisma, projectId, actorId, req.body?.planId);
      if (action === 'apply' || action === 'undo') broadcast('vdr:changed', { projectId });
      res.json(result);
    } catch (err: any) {
      if (['P2002', 'P2034', 'P1008', 'P2028'].includes(err?.code)) return res.status(409).json({ error: 'Строки уже создал или изменил коллега. Обновите предпросмотр.' });
      sendError(res, err, err.status || 500);
    }
  };
  app.get('/api/docflow/tags', run('list'));
  app.post('/api/docflow/kits/plan', run('plan'));
  app.post('/api/docflow/kits/apply', run('apply'));
  app.post('/api/docflow/kits/undo', run('undo'));
}
