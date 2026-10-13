/**
 * Flux Office для файлов Проводника: те же state / preview / confirm / запись
 * схемы, что у файлов проекта, но над присланным содержимым.
 *
 * Файл Windows или черновик «В Flux» не является FileNode, и байты локального
 * файла сервер не хранит (ТЗ §17): они лежат только в памяти запроса.
 * Запись схемы возвращает новые байты, а не пишет файл — их записывает сам
 * редактор через файловый мост. Права — по выбранному проекту.
 */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { canApplyOfficePlan } from '../../src/lib/officeModel.js';
import { officeStateOfContent, planOfficeContent, rebindOfficeContent, requireProjectRead } from './projectOffice.js';

/** Общий предел тела запроса сервера — 50 МБ, base64 прибавляет треть. */
export const LOCAL_OFFICE_MAX_BYTES = 30 * 1024 * 1024;
const LOCAL_PLAN_KEY = 'local-content';

class LocalOfficeError extends Error { constructor(message: string, readonly status: number) { super(message); } }

function projectOf(body: any): string {
  const projectId = String(body?.projectId || '');
  if (!projectId || projectId === 'null' || projectId === 'undefined' || projectId === 'default') throw new LocalOfficeError('Выберите проект', 400);
  return projectId;
}

/** Содержимое должно быть пакетом DOCX/XLSX заявленного размера; иное не разбираем. */
function contentOf(body: any): Buffer {
  const base64 = body?.base64;
  if (typeof base64 !== 'string' || !base64) throw new LocalOfficeError('Не передано содержимое файла', 400);
  if (base64.length > LOCAL_OFFICE_MAX_BYTES * 1.4) throw new LocalOfficeError('Файл слишком велик для Flux Office', 413);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > LOCAL_OFFICE_MAX_BYTES) throw new LocalOfficeError('Файл слишком велик для Flux Office', 413);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new LocalOfficeError('Flux работает с DOCX и XLSX', 400);
  return bytes;
}

function fail(res: Response, err: any, extra: Record<string, unknown> = {}) {
  res.status(err?.status || 400).json({ error: String(err?.message || err), ...extra });
}

export function registerProjectOfficeLocalRoutes(app: Express): void {
  app.post('/api/project-data/office-local/state', async (req: Request, res: Response) => {
    try {
      const projectId = projectOf(req.body);
      await requireProjectRead(req, projectId);
      res.json(await officeStateOfContent(contentOf(req.body), projectId));
    } catch (err: any) { fail(res, err); }
  });

  /** Новые байты со схемой и строками: запись в файл выполняет вызывающий. */
  app.post('/api/project-data/office-local/write-state', async (req: Request, res: Response) => {
    try {
      const projectId = projectOf(req.body);
      await requireProjectRead(req, projectId);
      const before = contentOf(req.body);
      const baseHash = createHash('sha256').update(before).digest('hex');
      if (req.body?.baseHash !== baseHash) return res.status(409).json({ error: 'Документ изменился после чтения схемы', baseHash });
      const { bytes, anchorCount } = await rebindOfficeContent(before, req.body);
      res.json({ ok: true, baseHash: createHash('sha256').update(bytes).digest('hex'), schemaVersion: 1, anchorCount, base64: bytes.toString('base64') });
    } catch (err: any) { fail(res, err); }
  });

  app.post('/api/project-data/office-local/preview', async (req: Request, res: Response) => {
    try {
      const made = await planOfficeContent(req, contentOf(req.body), LOCAL_PLAN_KEY, async () => projectOf(req.body), req.body);
      res.json({ planId: made.planId, baseHash: made.plan.baseHash, sourceRevision: made.plan.sourceRevision, selectedEntityIds: made.plan.selectedEntityIds, writes: made.plan.writes, adds: made.plan.adds, replaces: made.plan.replaces, manualRows: made.plan.manualRows, skips: made.plan.skips, errors: made.plan.errors, conflicts: made.plan.conflicts });
    } catch (err: any) { fail(res, err, { sourceRevision: err?.sourceRevision }); }
  });

  /** Повторная проверка плана; записи в файл нет — применяет редактор. */
  app.post('/api/project-data/office-local/confirm', async (req: Request, res: Response) => {
    try {
      const made = await planOfficeContent(req, contentOf(req.body), LOCAL_PLAN_KEY, async () => projectOf(req.body), req.body);
      if (String(req.body?.planId || '') !== made.planId) return res.status(409).json({ error: 'Предпросмотр изменился: постройте план заново' });
      const checked = canApplyOfficePlan(made.plan, { baseHash: String(req.body?.baseHash || ''), sourceRevision: String(req.body?.sourceRevision || ''), selectedEntityIds: Array.isArray(req.body?.selectedEntityIds) ? req.body.selectedEntityIds.map(String) : [] });
      if ('reason' in checked) return res.status(409).json({ error: checked.reason });
      res.json({ status: 'ready-for-editor', planId: made.planId, baseHash: made.plan.baseHash, sourceRevision: made.plan.sourceRevision, writes: made.plan.writes, adds: made.plan.adds, replaces: made.plan.replaces, manualRows: made.plan.manualRows, skips: made.plan.skips, errors: [], conflicts: [] });
    } catch (err: any) { fail(res, err, { sourceRevision: err?.sourceRevision }); }
  });
}
