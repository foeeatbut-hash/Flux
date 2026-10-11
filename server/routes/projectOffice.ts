/** Схема шапки, выборки и планы заполнения для дополнения Flux в Office. */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma, resolveProjectId, sendError, upsertSetting } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canReadFile } from '../fileAccess.js';
import { cleanQuery, runQuery, blockFingerprint, projectFingerprint } from '../projectSlice.js';
import { fileBytes } from './fileChunks.js';
import { projectOfFile } from '../projectFields.js';
import { OFFICE_TEMPLATE_KEY, OFFICE_TEMPLATE_PINS_KEY, cleanOfficeTemplate, parseOfficeTemplates, type OfficeHeaderTemplate } from '../officeTemplates.js';
import { readOfficeBindings } from '../officeBindings.js';
import { canApplyOfficePlan, planOfficeFill, type OfficeEntityRow, type OfficeHeaderSchema } from '../../src/lib/officeModel.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function accessibleFile(req: Request, id: string) {
  const db = getPrisma();
  const file = await db.fileNode.findUnique({ where: { id } });
  if (!file || file.deletedAt || !(await canReadFile(db, (req as any).authUser, file.id))) return null;
  return file;
}

function templateScopeAllowed(template: OfficeHeaderTemplate, actor: any): boolean {
  return template.scope === 'SHARED' || template.ownerId === actor?.id;
}

async function readTemplates(userId: string) {
  const db = getPrisma();
  const [shared, personal, pins] = await Promise.all([
    db.appSetting.findFirst({ where: { key: OFFICE_TEMPLATE_KEY, userId: null } }),
    db.appSetting.findFirst({ where: { key: OFFICE_TEMPLATE_KEY, userId } }),
    db.appSetting.findFirst({ where: { key: OFFICE_TEMPLATE_PINS_KEY, userId } }),
  ]);
  let pinned: string[] = [];
  try { const parsed = JSON.parse(pins?.value || '[]'); pinned = Array.isArray(parsed) ? parsed.map(String) : []; } catch { /* повреждённый список не скрывает шаблоны */ }
  const templates = [...parseOfficeTemplates(shared?.value), ...parseOfficeTemplates(personal?.value)];
  return { templates, pinned };
}

async function writeTemplates(userId: string, scope: 'SHARED' | 'PERSONAL', templates: OfficeHeaderTemplate[]) {
  const keyUser = scope === 'SHARED' ? null : userId;
  const scopedTemplates = templates.filter((item) => item.scope === scope);
  const db = getPrisma();
  const record = await db.appSetting.findFirst({ where: { key: OFFICE_TEMPLATE_KEY, userId: keyUser } });
  if (record) await db.appSetting.update({ where: { id: record.id }, data: { value: JSON.stringify(scopedTemplates) } });
  else await upsertSetting(OFFICE_TEMPLATE_KEY, keyUser, JSON.stringify(scopedTemplates));
}

async function rowsFor(projectId: string, queryBody: any): Promise<{ rows: OfficeEntityRow[]; sourceRevision: string; total: number }> {
  const query = cleanQuery(queryBody);
  query.limit = Math.min(Number(queryBody?.limit) || 50000, 50000);
  const [result, fp] = await Promise.all([runQuery(projectId, query), blockFingerprint(projectId, query, null)]);
  const sourceRevision = fp || digest(await projectFingerprint(projectId));
  const rows = result.rows.map((record: any) => {
    const colon = String(record.key || '').indexOf(':');
    const entityType = colon > 0 ? String(record.key).slice(0, colon) : query.entity;
    const entityId = colon > 0 ? String(record.key).slice(colon + 1) : '';
    const values: Record<string, { value: string | number | null; revision: string }> = {};
    query.columns.forEach((column: string, index: number) => { values[column] = { value: record.cells?.[index] ?? null, revision: sourceRevision }; });
    return { entityId, entityType, sourceId: `project:${projectId}:${entityType}`, values };
  }).filter((row: OfficeEntityRow) => row.entityId);
  return { rows, sourceRevision, total: result.total };
}

function schemaFromBody(value: any): OfficeHeaderSchema {
  if (!value || value.version !== 1 || !Array.isArray(value.anchors) || value.anchors.length > 1000) throw new Error('Схема шапки не поддерживается');
  const ids = new Set<string>();
  for (const anchor of value.anchors) {
    if (!anchor || typeof anchor.id !== 'string' || !anchor.id || ids.has(anchor.id) || !['word-row', 'excel-range'].includes(anchor.kind) || !Array.isArray(anchor.parts) || anchor.parts.length > 200) throw new Error('Схема содержит повреждённый якорь');
    ids.add(anchor.id);
  }
  return value as OfficeHeaderSchema;
}

async function makePlan(req: Request, fileId: string, body: any) {
  const file = await accessibleFile(req, fileId);
  if (!file) throw Object.assign(new Error('Файл не найден'), { status: 404 });
  const bytes = await fileBytes(file);
  const baseHash = sha256(bytes);
  if (!body?.baseHash || body.baseHash !== baseHash) throw Object.assign(new Error('Документ изменился после предпросмотра'), { status: 409 });
  const projectId = await projectOfFile(String(file.id), String(body.projectId || file.projectId || ''));
  const schema = schemaFromBody(body.schema);
  const selectedEntityIds = Array.isArray(body.selectedEntityIds) ? [...new Set(body.selectedEntityIds.map(String))].slice(0, 5000) : [];
  if (!selectedEntityIds.length) throw Object.assign(new Error('Выберите хотя бы одну строку'), { status: 400 });
  const query = body.query && typeof body.query === 'object' ? body.query : {};
  const data = await rowsFor(projectId, query);
  if (body.sourceRevision !== data.sourceRevision) throw Object.assign(new Error('Источник изменился после предпросмотра'), { status: 409, sourceRevision: data.sourceRevision });
  const packageBindings = await readOfficeBindings(bytes);
  const existingRows = (packageBindings?.rows || []).map((row) => ({ rowId: row.entityId, entityId: row.entityId }));
  const plan = planOfficeFill({ baseHash, sourceRevision: data.sourceRevision, selectedEntityIds, rows: data.rows, anchors: schema.anchors, existingRows });
  const planId = digest({ fileId, plan, schema, query, projectId });
  return { file, projectId, schema, query, plan, planId, sourceRevision: data.sourceRevision };
}

export function registerProjectOfficeRoutes(app: Express): void {
  app.get('/api/project-data/office/query', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      const query: any = { entity: req.query.entity, columns: String(req.query.columns || '').split(',').filter(Boolean), filters: [], sort: [], limit: Number(req.query.limit) };
      const data = await rowsFor(projectId, query);
      res.json({ revision: data.sourceRevision, total: data.total, rows: data.rows });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/project-data/office/query', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      const data = await rowsFor(projectId, req.body?.query || req.body);
      if (req.body?.sourceRevision && req.body.sourceRevision !== data.sourceRevision) return res.status(409).json({ error: 'Источник изменился', revision: data.sourceRevision });
      res.json({ revision: data.sourceRevision, total: data.total, rows: data.rows });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/project-data/files/:id/office-state', async (req: Request, res: Response) => {
    try {
      const file = await accessibleFile(req, String(req.params.id));
      if (!file) return res.status(404).json({ error: 'Файл не найден' });
      if (!/\.(docx|xlsx)$/i.test(file.name)) return res.status(400).json({ error: 'Flux работает с DOCX и XLSX' });
      const bytes = await fileBytes(file);
      const bindings = await readOfficeBindings(bytes);
      const projectId = await projectOfFile(String(file.id), String(file.projectId || ''));
      res.json({ baseHash: sha256(bytes), schema: bindings ? { version: bindings.schemaVersion, anchors: bindings.anchors } : { version: 1, anchors: [] }, rows: bindings?.rows || [], sourceRevision: await blockFingerprint(projectId, cleanQuery({ entity: 'element', columns: [] }), null) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/project-data/files/:id/preview', async (req: Request, res: Response) => {
    try {
      const made = await makePlan(req, String(req.params.id), req.body);
      res.json({ planId: made.planId, baseHash: made.plan.baseHash, sourceRevision: made.plan.sourceRevision, selectedEntityIds: made.plan.selectedEntityIds, writes: made.plan.writes, adds: made.plan.adds, replaces: made.plan.replaces, manualRows: made.plan.manualRows, skips: made.plan.skips, errors: made.plan.errors, conflicts: made.plan.conflicts });
    } catch (err: any) { res.status(err?.status || 400).json({ error: String(err?.message || err), sourceRevision: err?.sourceRevision }); }
  });

  /** Повторная проверка плана; запись в файл выполняет штатный GenOffice save. */
  app.post('/api/project-data/files/:id/confirm', async (req: Request, res: Response) => {
    try {
      const made = await makePlan(req, String(req.params.id), req.body);
      if (String(req.body?.planId || '') !== made.planId) return res.status(409).json({ error: 'Предпросмотр изменился: постройте план заново' });
      const checked = canApplyOfficePlan(made.plan, { baseHash: String(req.body?.baseHash || ''), sourceRevision: String(req.body?.sourceRevision || ''), selectedEntityIds: Array.isArray(req.body?.selectedEntityIds) ? req.body.selectedEntityIds.map(String) : [] });
      if (!checked.ok) return res.status(409).json({ error: checked.reason });
      res.json({ status: 'ready-for-editor', planId: made.planId, baseHash: made.plan.baseHash, sourceRevision: made.plan.sourceRevision, writes: made.plan.writes, adds: made.plan.adds, replaces: made.plan.replaces, manualRows: made.plan.manualRows, skips: made.plan.skips, errors: [], conflicts: [] });
    } catch (err: any) { res.status(err?.status || 400).json({ error: String(err?.message || err), sourceRevision: err?.sourceRevision }); }
  });

  app.get('/api/project-data/office/templates', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const { templates, pinned } = await readTemplates(actor.id);
      res.json({ templates: templates.filter((item) => templateScopeAllowed(item, actor)), pinned });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/project-data/office/templates', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const scope = req.body?.scope === 'SHARED' ? 'SHARED' : 'PERSONAL';
      const { templates } = await readTemplates(actor.id);
      const template = cleanOfficeTemplate({ ...req.body, scope }, actor.id);
      if (scope === 'SHARED') {
        await writeTemplates(actor.id, 'SHARED', [...templates.filter((item) => item.scope === 'SHARED'), template]);
      } else {
        await writeTemplates(actor.id, 'PERSONAL', [...templates.filter((item) => item.scope === 'PERSONAL' && item.ownerId === actor.id), template]);
      }
      res.json({ template });
    } catch (err: any) { res.status(400).json({ error: String(err?.message || err) }); }
  });

  app.put('/api/project-data/office/templates/:id', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      const { templates } = await readTemplates(String(actor?.id || ''));
      const current = templates.find((item) => item.id === String(req.params.id));
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      if (!current || (current.scope === 'PERSONAL' && current.ownerId !== actor.id) || (current.scope === 'SHARED' && current.createdById !== actor.id && !isPrivilegedUser(actor))) return res.status(404).json({ error: 'Шаблон не найден' });
      const updated = cleanOfficeTemplate({ ...req.body, scope: current.scope }, actor.id, current);
      await writeTemplates(actor.id, current.scope, templates.filter((item) => item.id !== current.id).concat(updated));
      res.json({ template: updated });
    } catch (err: any) { res.status(400).json({ error: String(err?.message || err) }); }
  });

  app.delete('/api/project-data/office/templates/:id', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      const { templates, pinned } = await readTemplates(String(actor?.id || ''));
      const current = templates.find((item) => item.id === String(req.params.id));
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      if (!current || (current.scope === 'PERSONAL' && current.ownerId !== actor.id) || (current.scope === 'SHARED' && current.createdById !== actor.id && !isPrivilegedUser(actor))) return res.status(404).json({ error: 'Шаблон не найден' });
      await writeTemplates(actor.id, current.scope, templates.filter((item) => item.id !== current.id));
      const db = getPrisma();
      const pinRow = await db.appSetting.findFirst({ where: { key: OFFICE_TEMPLATE_PINS_KEY, userId: actor.id } });
      if (pinRow) await db.appSetting.update({ where: { id: pinRow.id }, data: { value: JSON.stringify(pinned.filter((id) => id !== current.id)) } });
      res.json({ deleted: true });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/project-data/office/templates/:id/pin', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const { templates, pinned } = await readTemplates(actor.id);
      if (!templates.some((item) => item.id === String(req.params.id) && templateScopeAllowed(item, actor))) return res.status(404).json({ error: 'Шаблон не найден' });
      const next = new Set(pinned);
      if (req.body?.pinned === false) next.delete(String(req.params.id)); else next.add(String(req.params.id));
      await upsertSetting(OFFICE_TEMPLATE_PINS_KEY, actor.id, JSON.stringify([...next]));
      res.json({ pinned: [...next] });
    } catch (err: any) { sendError(res, err); }
  });
}
