/** Схема шапки, выборки и планы заполнения для дополнения Flux в Office. */
import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma, resolveProjectId, sendError } from '../context.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { canReadFile, canWriteFile } from '../fileAccess.js';
import { canSeeProject } from './members.js';
import { cleanQuery, runQuery, blockFingerprint, projectFingerprint, loadProjectSlice, loadProjectAliases } from '../projectSlice.js';
import { fileBytes } from './fileChunks.js';
import { projectOfFile } from '../projectFields.js';
import { OFFICE_TEMPLATE_KEY, OFFICE_TEMPLATE_PINS_KEY, cleanOfficeTemplate, parseOfficeTemplates, type OfficeHeaderTemplate } from '../officeTemplates.js';
import { readOfficeBindings, writeOfficeBindings, type OfficePackageBindings } from '../officeBindings.js';
import { writeOfficeFile } from './officeFiles.js';
import { resolveOfficeUnit } from '../officeData.js';
import { mutateOfficeSettingArray } from '../officeTemplateStore.js';
import { canApplyOfficePlan, officeEntityId, planOfficeFill, type OfficeEntityRow, type OfficeHeaderSchema } from '../../src/lib/officeModel.js';

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

async function writeTemplates(userId: string, scope: 'SHARED' | 'PERSONAL', change: (current: OfficeHeaderTemplate[]) => OfficeHeaderTemplate[]) {
  const keyUser = scope === 'SHARED' ? null : userId;
  const db = getPrisma();
  await mutateOfficeSettingArray({ db, key: OFFICE_TEMPLATE_KEY, userId: keyUser,
    parse: (raw) => parseOfficeTemplates(raw).filter((item) => item.scope === scope),
    change: (current) => change(current).filter((item) => item.scope === scope),
    conflictMessage: 'Шаблоны изменились одновременно. Повторите действие.' });
}

async function writePins(userId: string, change: (current: string[]) => string[]) {
  const db = getPrisma();
  const parse = (raw: string | null | undefined) => {
    try { const parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; }
    catch { return []; }
  };
  await mutateOfficeSettingArray({ db, key: OFFICE_TEMPLATE_PINS_KEY, userId, parse,
    change: (current) => [...new Set(change(current))], conflictMessage: 'Закрепления изменились одновременно. Повторите действие.' });
}

async function rowsFor(projectId: string, queryBody: any): Promise<{ rows: OfficeEntityRow[]; sourceRevision: string; total: number }> {
  const requestedEntity = queryBody?.entity;
  if (requestedEntity && requestedEntity !== 'tag' && requestedEntity !== 'element') {
    throw Object.assign(new Error(`Источник «${String(requestedEntity)}» не поддерживается в текущем API Office`), { status: 400 });
  }
  const query = cleanQuery(queryBody);
  query.limit = Math.min(Number(queryBody?.limit) || 50000, 50000);
  const [result, fp, slice, aliases] = await Promise.all([runQuery(projectId, query), blockFingerprint(projectId, query, null), loadProjectSlice(projectId), loadProjectAliases(projectId)]);
  const sourceRevision = fp || digest(await projectFingerprint(projectId));
  const elementById = new Map(slice.elements.map((element: any) => [String(element.id), element]));
  const rows = result.rows.map((record: any) => {
    const colon = String(record.key || '').indexOf(':');
    const entityType = colon > 0 ? String(record.key).slice(0, colon) : query.entity;
    const rawEntityId = colon > 0 ? String(record.key).slice(colon + 1) : '';
    const sourceId = entityType === 'tag' ? 'tags' : 'equipment';
    // ID включает источник и тип: у тега и оборудования может совпасть raw ID.
    const entityId = rawEntityId ? officeEntityId(sourceId, entityType, rawEntityId) : '';
    const values: Record<string, { value: string | number | null; revision: string }> = {};
    query.columns.forEach((column: string, index: number) => {
      const unit = entityType === 'element' ? resolveOfficeUnit(column, elementById.get(rawEntityId), aliases) : undefined;
      values[column] = { value: record.cells?.[index] ?? null, revision: sourceRevision, ...(unit ? { unit } : {}) };
    });
    return { entityId, entityType, sourceId, values };
  }).filter((row: OfficeEntityRow) => row.entityId && !(queryBody?.excludedEntityIds || []).map(String).includes(row.entityId));
  return { rows, sourceRevision, total: result.total };
}

async function requireProjectRead(req: Request, projectId: string): Promise<void> {
  const actor = (req as any).authUser;
  if (!actor?.id || !(await canSeeProject(actor.id, projectId, isPrivilegedUser(actor)))) throw Object.assign(new Error('Проект не найден'), { status: 404 });
}

function schemaFromBody(value: any): OfficeHeaderSchema {
  const template = cleanOfficeTemplate({ name: 'Предпросмотр', schema: value }, '');
  return template.schema;
}

async function makePlan(req: Request, fileId: string, body: any) {
  const file = await accessibleFile(req, fileId);
  if (!file) throw Object.assign(new Error('Файл не найден'), { status: 404 });
  const bytes = await fileBytes(file);
  const baseHash = sha256(bytes);
  if (!body?.baseHash || body.baseHash !== baseHash) throw Object.assign(new Error('Документ изменился после предпросмотра'), { status: 409 });
  const projectId = await projectOfFile(String(file.id), String(body.projectId || file.projectId || ''));
  await requireProjectRead(req, projectId);
  const schema = schemaFromBody(body.schema);
  const selectedEntityIds: string[] = Array.isArray(body.selectedEntityIds) ? [...new Set<string>(body.selectedEntityIds.map(String))].slice(0, 5000) : [];
  if (!selectedEntityIds.length) throw Object.assign(new Error('Выберите хотя бы одну строку'), { status: 400 });
  const query = body.query && typeof body.query === 'object' ? body.query : {};
  const data = await rowsFor(projectId, query);
  if (body.sourceRevision !== data.sourceRevision) throw Object.assign(new Error('Источник изменился после предпросмотра'), { status: 409, sourceRevision: data.sourceRevision });
  const packageBindings = await readOfficeBindings(bytes);
  const existingRows = [
    ...(packageBindings?.rows || []).map((row) => ({ rowId: row.entityId, entityId: row.entityId })),
    ...(Array.isArray(body.manualRows) ? body.manualRows.slice(0, 10000).map((row: any) => ({ rowId: String(row?.rowId || ''), manuallyEdited: true })) : []),
  ];
  const plan = planOfficeFill({ baseHash, sourceRevision: data.sourceRevision, selectedEntityIds, rows: data.rows, anchors: schema.anchors, existingRows });
  const planId = digest({ fileId, plan, schema, query, projectId });
  return { file, projectId, schema, query, plan, planId, sourceRevision: data.sourceRevision };
}

export function registerProjectOfficeRoutes(app: Express): void {
  app.get('/api/project-data/office/query', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.query.projectId || ''));
      await requireProjectRead(req, projectId);
      const query: any = { entity: req.query.entity, columns: String(req.query.columns || '').split(',').filter(Boolean), filters: [], sort: [], limit: Number(req.query.limit) };
      const data = await rowsFor(projectId, query);
      res.json({ revision: data.sourceRevision, total: data.total, rows: data.rows });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/project-data/office/query', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));
      await requireProjectRead(req, projectId);
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
      await requireProjectRead(req, projectId);
      res.json({ baseHash: sha256(bytes), schema: bindings ? { version: bindings.schemaVersion, anchors: bindings.anchors } : { version: 1, anchors: [] }, rows: bindings?.rows || [], sourceRevision: await blockFingerprint(projectId, cleanQuery({ entity: 'element', columns: [] }), null) });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/project-data/files/:id/office-state', async (req: Request, res: Response) => {
    try {
      const file = await accessibleFile(req, String(req.params.id));
      if (!file || !(await canWriteFile(getPrisma(), (req as any).authUser, file.id))) return res.status(404).json({ error: 'Файл не найден' });
      if (!/\.(docx|xlsx)$/i.test(file.name)) return res.status(400).json({ error: 'Flux работает с DOCX и XLSX' });
      const before = await fileBytes(file);
      const baseHash = sha256(before);
      if (req.body?.baseHash !== baseHash) return res.status(409).json({ error: 'Документ изменился после чтения схемы', baseHash });
      const projectId = await projectOfFile(String(file.id), String(file.projectId || ''));
      await requireProjectRead(req, projectId);
      const schema = schemaFromBody(req.body?.schema);
      const prior = await readOfficeBindings(before);
      const bindings: OfficePackageBindings = {
        version: 1, schemaVersion: 1, sourceRevision: String(req.body?.sourceRevision || prior?.sourceRevision || ''),
        anchors: schema.anchors.map((anchor) => ({ id: anchor.id, kind: anchor.kind, part: anchor.documentPart, sheet: anchor.sheetName, address: anchor.address, parts: anchor.parts })),
        rows: prior?.rows || [],
      };
      const updated = await writeOfficeBindings(before, bindings);
      const saved = await writeOfficeFile({ fileId: file.id, body: updated, baseSha: baseHash, user: (req as any).authUser, server: true });
      if (saved.status !== 200) return res.status(saved.status).json(saved.json);
      res.json({ ok: true, baseHash: saved.json.sha256, schemaVersion: 1, anchorCount: bindings.anchors.length });
    } catch (err: any) { res.status(err?.status || 400).json({ error: String(err?.message || err) }); }
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
      if (!(await canWriteFile(getPrisma(), (req as any).authUser, made.file.id))) return res.status(404).json({ error: 'Файл не найден' });
      if (String(req.body?.planId || '') !== made.planId) return res.status(409).json({ error: 'Предпросмотр изменился: постройте план заново' });
      const checked = canApplyOfficePlan(made.plan, { baseHash: String(req.body?.baseHash || ''), sourceRevision: String(req.body?.sourceRevision || ''), selectedEntityIds: Array.isArray(req.body?.selectedEntityIds) ? req.body.selectedEntityIds.map(String) : [] });
      if ('reason' in checked) return res.status(409).json({ error: checked.reason });
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
        await writeTemplates(actor.id, 'SHARED', (current) => [...current, template]);
      } else {
        await writeTemplates(actor.id, 'PERSONAL', (current) => [...current.filter((item) => item.ownerId === actor.id), template]);
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
      await writeTemplates(actor.id, current.scope, (items) => items.filter((item) => item.id !== current.id).concat(updated));
      res.json({ template: updated });
    } catch (err: any) { res.status(400).json({ error: String(err?.message || err) }); }
  });

  app.delete('/api/project-data/office/templates/:id', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      const { templates } = await readTemplates(String(actor?.id || ''));
      const current = templates.find((item) => item.id === String(req.params.id));
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      if (!current || (current.scope === 'PERSONAL' && current.ownerId !== actor.id) || (current.scope === 'SHARED' && current.createdById !== actor.id && !isPrivilegedUser(actor))) return res.status(404).json({ error: 'Шаблон не найден' });
      await writeTemplates(actor.id, current.scope, (items) => items.filter((item) => item.id !== current.id));
      await writePins(actor.id, (items) => items.filter((id) => id !== current.id));
      res.json({ deleted: true });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/project-data/office/templates/:id/pin', async (req: Request, res: Response) => {
    try {
      const actor = (req as any).authUser;
      if (!actor?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const { templates } = await readTemplates(actor.id);
      if (!templates.some((item) => item.id === String(req.params.id) && templateScopeAllowed(item, actor))) return res.status(404).json({ error: 'Шаблон не найден' });
      await writePins(actor.id, (current) => req.body?.pinned === false ? current.filter((id) => id !== String(req.params.id)) : [...current, String(req.params.id)]);
      res.json({ pinned: (await readTemplates(actor.id)).pinned });
    } catch (err: any) { sendError(res, err); }
  });
}
