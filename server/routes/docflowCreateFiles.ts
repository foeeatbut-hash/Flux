import type { Express, Request, Response } from 'express';
import { broadcast, sendError } from '../context.js';
import { docflowScope } from '../docflowScope.js';
import { planCreateFiles, claimCreateFiles, completeCreateFiles, undoCreatePlan, undoCreatedFiles, cancelCreateFiles, stateCreateFiles, lastCreateFiles } from '../docflowCreateFiles.js';

export function registerDocflowCreateFileRoutes(app: Express) {
  const run = (action: string) => async (req: Request, res: Response) => {
    try {
      const { projectId, actorId, prisma } = await docflowScope(req, 'docflow.files');
      const id = req.method === 'GET' ? String(req.query.planId || '') : req.body?.planId;
      const answer = action === 'plan' ? await planCreateFiles(prisma, projectId, actorId, req.body)
        : action === 'claim' ? await claimCreateFiles(prisma, projectId, actorId, id, req.body?.files)
        : action === 'complete' ? await completeCreateFiles(prisma, projectId, actorId, id)
        : action === 'undo-plan' ? await undoCreatePlan(prisma, projectId, actorId, id)
        : action === 'undo' ? await undoCreatedFiles(prisma, projectId, actorId, id)
        : action === 'cancel' ? await cancelCreateFiles(prisma, projectId, actorId, id, req.body?.prepareOnly === true)
        : req.query.last === '1' ? await lastCreateFiles(prisma, projectId, actorId, typeof req.query.itemId === 'string' ? req.query.itemId : undefined)
        : await stateCreateFiles(prisma, projectId, actorId, id);
      if (action === 'complete' || action === 'undo') broadcast('vdr:changed', { projectId });
      res.json(answer);
    } catch (err: any) {
      if (['P2002', 'P2034', 'P1008', 'P2028'].includes(err?.code)) return res.status(409).json({ error: 'Ревизию или путь уже занял другой запрос. Обновите план.' });
      sendError(res, err, err.status || 500);
    }
  };
  app.post('/api/docflow/create-files/plan', run('plan'));
  app.post('/api/docflow/create-files/claim', run('claim'));
  app.post('/api/docflow/create-files/complete', run('complete'));
  app.get('/api/docflow/create-files/state', run('state'));
  app.post('/api/docflow/create-files/undo-plan', run('undo-plan'));
  app.post('/api/docflow/create-files/undo', run('undo'));
  app.post('/api/docflow/create-files/cancel', run('cancel'));
}
