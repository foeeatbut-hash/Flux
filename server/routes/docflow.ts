import type { Express, Request, Response } from 'express';
import { getPrisma, broadcast } from '../context.js';
import { actorMay, isAdminActor }  from '../projectAccess.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { docflowScope } from '../docflowScope.js';
import {
  DocflowSettingsConflict, readSettings, rawSettingsConfig, writeSettings, copyPlan, applyCopy, undoLast, undoNeedsCatalog, validSections,
  listTemplates, saveTemplate, migrationPlan, applyMigration, undoMigration,
} from '../docflowSettings.js';
import { DocflowPlanError } from '../docflowPlans.js';
import { validateDocflowReferences } from '../docflowConfigRefs.js';
import { normalizeDocflowConfig } from '../../shared/docflow/config.js';
import { maskErrors } from '../../shared/docflow/nameMask.js';

// ── Документооборот: настройки проекта, шаблоны, перенос стандартов ──
// Права — общая таблица server/vdrPermissions.ts (чтение docflow.view, запись
// docflow.settings). Доступ к проекту из `projectId` проверяет общий страж;
// проект-источник переноса назван иначе и проверяется здесь.

const actorOf = (req: Request) => (req as any).authUser || null;
const fail = (res: Response, err: any) => {
  if (err?.code === 'P2034') return res.status(409).json({ error: 'Данные изменились одновременно. Обновите предпросмотр.', conflict: true });
  if (err instanceof DocflowSettingsConflict || err instanceof DocflowPlanError) return res.status(err.status).json({ error: err.message, conflict: err.status === 409 });
  res.status(500).json({ error: err?.message || 'Ошибка настроек документооборота' });
};
const expectedOf = (raw: unknown): string | null | undefined => (raw === null ? null : typeof raw === 'string' && raw ? raw : undefined);

async function mayReadSource(req: Request, from: { projectId?: string }): Promise<boolean> {
  if (!from.projectId) return true;
  const me = actorOf(req);
  return !!me && canSeeProject(String(me.id), from.projectId, isAdminActor(me));
}

/** Маски проверяются до записи: с неисправной маской ни один файл не свяжется. */
function maskProblems(config: any): string[] {
  const c = normalizeDocflowConfig(config);
  return [
    ...maskErrors(c.masks.file).map((e) => `Маска имени: ${e}`),
    ...(c.masks.cipher.trim() ? maskErrors(c.masks.cipher, 'cipher').map((e) => `Маска шифра: ${e}`) : []),
    ...(['work', 'issue', 'returns', 'incoming'] as const).flatMap((k) => maskErrors(c.folders[k], 'folder').map((e) => `Папка (${k}): ${e}`)),
  ];
}

export function registerDocflowRoutes(app: Express): void {
  // Тот же сигнал, что у реестра: открытый Реестр перечитывает и настройки
  // проекта (статусы, коды рассмотрения), и строки
  const announce = (projectId: string | null) => broadcast('vdr:changed', projectId ? { projectId } : {});

  app.get('/api/docflow/settings', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.query.projectId || '');
      if (!projectId) return res.status(400).json({ error: 'Не указан проект' });
      res.json(await readSettings(getPrisma(), projectId));
    } catch (err) { fail(res, err); }
  });

  app.put('/api/docflow/settings', async (req: Request, res: Response) => {
    try {
      const { projectId, config } = req.body || {};
      if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'Не указан проект' });
      const problems = maskProblems(config);
      if (problems.length) return res.status(400).json({ error: problems.join('; '), problems });
      const view = await writeSettings(getPrisma(), { projectId, config, expected: expectedOf(req.body?.expectedUpdatedAt), actorId: String(actorOf(req)?.id || '') });
      announce(projectId);
      res.json(view);
    } catch (err) {
      if (err instanceof DocflowSettingsConflict && err.status === 409) {
        const current = await readSettings(getPrisma(), String(req.body?.projectId)).catch(() => null);
        return res.status(409).json({ error: err.message, conflict: true, current });
      }
      fail(res, err);
    }
  });

  app.post('/api/docflow/settings/copy-plan', async (req: Request, res: Response) => {
    try {
      const { projectId, from } = req.body || {};
      if (!(await mayReadSource(req, from || {}))) return res.status(403).json({ error: 'Нет доступа к проекту-источнику' });
      if (req.body?.includeCatalog) { await docflowScope(req, 'docflow.settings'); if (!await actorMay(actorOf(req), roleGrantsOf, 'catalog.project')) return res.status(403).json({ error: 'Нет права на каталог проекта' }); }
      res.json(await copyPlan(getPrisma(), String(projectId), from || {}, validSections(req.body?.sections, req.body?.includeCatalog === true), req.body?.includeCatalog === true));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/docflow/settings/copy-apply', async (req: Request, res: Response) => {
    try {
      const { projectId, from } = req.body || {};
      if (!(await mayReadSource(req, from || {}))) return res.status(403).json({ error: 'Нет доступа к проекту-источнику' });
      if (req.body?.includeCatalog) { await docflowScope(req, 'docflow.settings'); if (!await actorMay(actorOf(req), roleGrantsOf, 'catalog.project')) return res.status(403).json({ error: 'Нет права на каталог проекта' }); }
      const view = await applyCopy(getPrisma(), {
        projectId: String(projectId), from: from || {}, sections: validSections(req.body?.sections, req.body?.includeCatalog === true),
        expected: expectedOf(req.body?.expectedUpdatedAt), actorId: String(actorOf(req)?.id || ''), includeCatalog: req.body?.includeCatalog === true, catalogToken: req.body?.catalogToken,
      });
      announce(String(projectId));
      res.json(view);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/docflow/settings/undo', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.body?.projectId || '');
      const mayUndoCatalog = await actorMay(actorOf(req), roleGrantsOf, 'catalog.project');
      if (mayUndoCatalog || await undoNeedsCatalog(getPrisma(), projectId)) { await docflowScope(req, 'docflow.settings'); if (!mayUndoCatalog) return res.status(403).json({ error: 'Нет права на каталог проекта' }); }
      const view = await undoLast(getPrisma(), projectId, String(actorOf(req)?.id || ''), mayUndoCatalog);
      announce(projectId);
      res.json(view);
    } catch (err) { fail(res, err); }
  });

  app.get('/api/docflow/templates', async (_req: Request, res: Response) => {
    try { res.json({ templates: await listTemplates(getPrisma()) }); } catch (err) { fail(res, err); }
  });

  // «Сохранить как шаблон»: снимок настроек проекта, дальше они живут отдельно
  app.post('/api/docflow/templates', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.body?.projectId || '');
      if (!projectId) return res.status(400).json({ error: 'Не указан проект' });
      const prisma = getPrisma();
      if (!await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
      await validateDocflowReferences(prisma, await rawSettingsConfig(prisma, projectId));
      const view = await readSettings(prisma, projectId);
      const template = await saveTemplate(prisma, String(req.body?.name || ''), view.config);
      announce(null);
      res.json({ template });
    } catch (err) { fail(res, err); }
  });

  app.delete('/api/docflow/templates/:id', async (req: Request, res: Response) => {
    try {
      const gone = await getPrisma().docStandard.deleteMany({ where: { id: req.params.id } });
      if (!gone.count) return res.status(404).json({ error: 'Шаблон не найден' });
      announce(null);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // Перенос прежних глобальных стандартов в проекты: план → применение → отмена.
  // План перечисляет все проекты компании, поэтому он — дело администратора
  const adminOnly = (req: Request, res: Response) => {
    if (isAdminActor(actorOf(req))) return true;
    res.status(403).json({ error: 'Перенос стандартов в проекты выполняет администратор' });
    return false;
  };
  app.get('/api/docflow/migration', async (req: Request, res: Response) => {
    if (!adminOnly(req, res)) return;
    try { res.json(await migrationPlan(getPrisma())); } catch (err) { fail(res, err); }
  });
  app.post('/api/docflow/migration/apply', async (req: Request, res: Response) => {
    if (!adminOnly(req, res)) return;
    try {
      const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.filter((x: unknown) => typeof x === 'string') : [];
      const plan = await applyMigration(getPrisma(), ids, String(actorOf(req)?.id || ''));
      announce(null);
      res.json(plan);
    } catch (err) { fail(res, err); }
  });
  app.post('/api/docflow/migration/undo', async (req: Request, res: Response) => {
    if (!adminOnly(req, res)) return;
    try {
      const result = await undoMigration(getPrisma());
      announce(null);
      res.json(result);
    } catch (err) { fail(res, err); }
  });
}
