import type { Express, Request, Response } from 'express';
import { getPrisma, sendError, broadcast } from '../context.js';
import { CATALOG_LISTS, overlayCatalog, catalogDocumentProblem, type CatalogEntity, type CatalogGrant } from '../../catalog/publication.js';
import { CATALOG_ENTITIES, catalogAllowed, catalogGrants, catalogSetting, putCatalogSetting, listCatalogDrafts, stageCatalogDraft, publishCatalogDrafts, discardCatalogDraft, catalogFailure } from '../catalogWorkspace.js';
import { createHash } from 'node:crypto';
import { hashCatalogRow } from '../catalogWorkspace.js';
import { seedCatalog } from '../../catalog/seed.js';
interface Deps { ensure: (db: any) => Promise<void>; read: (db: any) => Promise<any>; can: (user: any, feature: string) => boolean }
const actor = (req: Request) => (req as any).authUser;
/** Встраивается раньше старых маршрутов: старый save теперь всегда сохраняет черновик. */
export function registerCatalogWorkspaceRoutes(app: Express, deps: Deps) {
  const handle = (fn: (req: Request, res: Response, db: any) => Promise<any>) => async (req: Request, res: Response) => {
    try { if (!actor(req)?.id) return res.status(401).json({ error: 'Нужно войти в программу' }); const db = getPrisma(); await deps.ensure(db); await fn(req, res, db); }
    catch (e: any) { sendError(res, e, e?.status || (e?.code === 'P2002' ? 409 : 500)); }
  };
  app.get('/api/catalog/workspace', handle(async (req, res, db) => {
    const user = actor(req); const drafts = (await listCatalogDrafts(db)).filter(d => d.authorId === user.id);
    const all = await listCatalogDrafts(db); const visible = [];
    for (const d of all) if (d.authorId === user.id || await catalogAllowed(db, user, 'edit', d.document, deps.can, d.entity) || await catalogAllowed(db, user, 'publish', d.document, deps.can, d.entity)) visible.push(d);
    const rights = { edit: false, import: false, publish: false };
    const grants = (await catalogGrants(db)).filter(g => g.userId === user.id || ['OWNER', 'ADMIN'].includes(user.role));
    for (const key of Object.keys(rights) as Array<keyof typeof rights>) rights[key] = await catalogAllowed(db, user, key, {}, deps.can) || grants.some(g => g.userId === user.id && g.action === key);
    const published = await deps.read(db);
    for (const [entity, list] of Object.entries(CATALOG_LISTS) as Array<[CatalogEntity, keyof typeof published]>) {
      const rows = await db[CATALOG_ENTITIES[entity].model].findMany();
      const hashes = new Map(rows.map((r: any) => [r.id, hashCatalogRow(r)]));
      for (const d of published[list]) d._publishedHash = hashes.get(d.id);
    }
    res.json({ catalog: overlayCatalog(published, visible), drafts: visible, rights, grants, policy: await catalogSetting(db, 'catalog_policy', { requireSecondReview: false }), ownDraftCount: drafts.length });
  }));
  app.post('/api/catalog/workspace/publish', handle(async (req, res, db) => {
    const result = await publishCatalogDrafts(db, req.body?.selections, actor(req), deps.can, deps.read);
    broadcast('catalog:changed', { entity: 'all', publication: result.publication }); res.json(result);
  }));
  app.post('/api/catalog/workspace/discard', handle(async (req, res, db) => {
    const draft = (await listCatalogDrafts(db)).find(d => d.id === req.body?.id && d.entity === req.body?.entity);
    if (!draft || draft.revision !== req.body?.revision) catalogFailure(409, 'Черновик изменён или отсутствует');
    if (!await catalogAllowed(db, actor(req), 'edit', draft.document, deps.can, draft.entity)) catalogFailure(403, 'Нет права отмены черновика');
    await discardCatalogDraft(db, draft); res.json({ ok: true });
  }));
  app.post('/api/catalog/workspace/review', handle(async (req, res, db) => {
    const draft = (await listCatalogDrafts(db)).find(d => d.id === req.body?.id && d.entity === req.body?.entity);
    if (!draft || draft.revision !== req.body?.revision) catalogFailure(409, 'Черновик изменён или отсутствует');
    if (!await catalogAllowed(db, actor(req), 'edit', draft.document, deps.can, draft.entity)) catalogFailure(403, 'Нет права правки');
    await db.$transaction(async (tx: any) => {
      const next = await stageCatalogDraft(tx, draft.entity, draft.id, draft.document, actor(req).id, draft.operation, draft.revision);
      await putCatalogSetting(tx, `catalog_draft:${draft.entity}:${draft.id}`, { ...next, authorId: draft.authorId, state: 'review' });
    }); res.json({ ok: true });
  }));
  app.post('/api/catalog/workspace/approve', handle(async (req, res, db) => {
    await db.$transaction(async (tx: any) => {
      const draft = (await listCatalogDrafts(tx)).find(d => d.id === req.body?.id && d.entity === req.body?.entity);
      if (!draft || draft.revision !== req.body?.revision) catalogFailure(409, 'Черновик изменён или отсутствует');
      if (!await catalogAllowed(tx, actor(req), 'publish', draft.document, deps.can, draft.entity)) catalogFailure(403, 'Проверку подтверждает сотрудник с правом публикации');
      const policy = await catalogSetting(tx, 'catalog_policy', { requireSecondReview: false });
      if (policy.requireSecondReview && draft.authorId === actor(req).id) catalogFailure(409, 'Проверку должен подтвердить другой сотрудник');
      const next = await stageCatalogDraft(tx, draft.entity, draft.id, draft.document, actor(req).id, draft.operation, draft.revision);
      await putCatalogSetting(tx, `catalog_draft:${draft.entity}:${draft.id}`, { ...next, authorId: draft.authorId, state: 'review', reviewedById: actor(req).id });
    }); res.json({ ok: true });
  }));
  app.put('/api/catalog/policy', handle(async (req, res, db) => {
    if (!['OWNER','ADMIN'].includes(actor(req).role)) catalogFailure(403, 'Порядок публикации меняет владелец или администратор');
    if (typeof req.body?.requireSecondReview !== 'boolean') catalogFailure(400, 'Укажите режим проверки');
    await putCatalogSetting(db, 'catalog_policy', { requireSecondReview: req.body.requireSecondReview }); res.json({ ok: true });
  }));
  app.get('/api/catalog/access', handle(async (req, res, db) => {
    if (!['OWNER', 'ADMIN'].includes(actor(req).role)) catalogFailure(403, 'Права выдаёт владелец или администратор');
    const grants = await catalogGrants(db);
    res.json({ grants, version: createHash('sha256').update(JSON.stringify(grants)).digest('hex'), users: await db.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, take: 5000 }) });
  }));
  app.put('/api/catalog/access', handle(async (req, res, db) => {
    if (!['OWNER', 'ADMIN'].includes(actor(req).role)) catalogFailure(403, 'Права выдаёт владелец или администратор');
    const grants: CatalogGrant[] = req.body?.grants;
    if (!Array.isArray(grants) || grants.length > 5000 || grants.some(g => !g.userId || !['edit', 'import', 'publish'].includes(g.action) || (g.classId && typeof g.classId !== 'string') || (g.manufacturerId && typeof g.manufacturerId !== 'string'))) catalogFailure(400, 'Неверный список прав');
    const ids = new Set((await db.user.findMany({ where: { id: { in: grants.map(g => g.userId) } }, select: { id: true } })).map((u: any) => u.id));
    if (grants.some(g => !ids.has(g.userId))) catalogFailure(400, 'Сотрудник не найден');
    await db.$transaction(async (tx: any) => {
      const current = await catalogGrants(tx);
      if (req.body?.version !== createHash('sha256').update(JSON.stringify(current)).digest('hex')) catalogFailure(409, 'Права уже изменены коллегой. Обновите список');
      const id = `cat-${createHash('sha256').update('catalog_grants').digest('hex')}`;
      const row = await tx.appSetting.findUnique({ where: { id } });
      if (row) {
        const claim = await tx.appSetting.updateMany({ where: { id, value: row.value }, data: { value: JSON.stringify(grants) } });
        if (claim.count !== 1) catalogFailure(409, 'Права одновременно изменены коллегой');
      } else await tx.appSetting.create({ data: { id, key: 'catalog_grants', value: JSON.stringify(grants) } });
    }); res.json({ ok: true, version: createHash('sha256').update(JSON.stringify(grants)).digest('hex') });
  }));
  app.post('/api/catalog/learn', async (req, res, next) => {
    try {
      const db = getPrisma(); await deps.ensure(db);
      if (!await catalogAllowed(db, actor(req), 'edit', { classId: req.body?.classId }, deps.can)) catalogFailure(403, 'Общие правила подбора меняет редактор каталога');
      const family = (await deps.read(db)).families.find((f: any) => f.id === req.body?.familyId && f.classId === req.body?.classId);
      if (!family) catalogFailure(400, 'Опубликованная модель не найдена');
      next();
    } catch (e: any) { sendError(res, e, e.status || 500); }
  });
  app.post('/api/catalog/import', handle(async (req, res, db) => {
    const body = req.body; if (body?.format !== 'flux-catalog') catalogFailure(400, 'Это не пакет каталога Flux');
    const allDrafts = await listCatalogDrafts(db); const cat = overlayCatalog(await deps.read(db), allDrafts);
    const changes: Array<{ entity: CatalogEntity; id: string; code: string; action: string; document: any; expected?: string; beforeHash: string; publishedHash: string }> = [];
    for (const [entity, list] of Object.entries(CATALOG_LISTS) as Array<[CatalogEntity, keyof typeof cat]>) {
      if (body[list] !== undefined && !Array.isArray(body[list])) catalogFailure(400, 'В пакете вместо списка записей другое значение');
      for (const document of body[list] || []) {
        const problem = catalogDocumentProblem(entity, document); if (problem) catalogFailure(400, `${document?.code || entity}: ${problem}`);
        if (!await catalogAllowed(db, actor(req), 'import', document, deps.can, entity)) catalogFailure(403, 'Нет права импорта этой области');
        const before = cat[list].find((x: any) => x.id === document.id); const clean: any = { ...before }; delete clean._draftVersion; delete clean._publishedHash;
        if (before && !await catalogAllowed(db, actor(req), 'import', before, deps.can, entity)) catalogFailure(403, 'Нет права импорта исходной области записи');
        const expected = allDrafts.find(d => d.entity === entity && d.id === document.id)?.revision;
        const publishedRow = await db[CATALOG_ENTITIES[entity].model].findUnique({ where: { id: document.id } });
        changes.push({ entity, id: document.id, code: document.code || document.name, action: !before ? 'new' : JSON.stringify(clean) === JSON.stringify(document) ? 'same' : 'update', document, expected, publishedHash: hashCatalogRow(publishedRow), beforeHash: createHash('sha256').update(JSON.stringify(clean)).digest('hex') });
      }
    }
    if (changes.length > 2000) catalogFailure(413, 'Пакет содержит более 2000 записей');
    // Клиент подтверждает тот же предпросмотр. Изменение после него требует повторной проверки.
    const token = JSON.stringify(changes.map(c => [c.entity, c.id, c.action, c.expected, c.beforeHash, c.publishedHash, c.document]));
     const preview = createHash('sha256').update(token).digest('hex');
    if (body.mode === 'apply') {
      if (body.preview !== preview) catalogFailure(409, 'Предпросмотр изменился. Проверьте разницу ещё раз');
      await db.$transaction(async (tx: any) => { for (const c of changes) if (c.action !== 'same') await stageCatalogDraft(tx, c.entity, c.id, { ...c.document, _publishedHash: c.publishedHash }, actor(req).id, 'save', c.expected); }, { timeout: 120000 });
    }
    res.json({ plan: changes.map(({ document, expected, ...c }) => c), preview, applied: body.mode === 'apply', draft: true });
  }));
  app.post('/api/catalog/family/:id/reseed', handle(async (req, res, db) => {
    const f = seedCatalog().families.find(x => x.id === req.params.id); if (!f) catalogFailure(404, 'Нет начального образца');
    if (!await catalogAllowed(db, actor(req), 'edit', f, deps.can)) catalogFailure(403, 'Нет права правки');
    const draft = await stageCatalogDraft(db, 'family', f.id, f, actor(req).id, 'save', req.body?._draftVersion); res.json({ ok: true, id: f.id, revision: draft.revision, draft: true });
  }));
  app.post('/api/catalog/revisions/:id/restore', handle(async (req, res, db) => {
    const rev = await db.catalogRevision.findUnique({ where: { id: String(req.params.id) } });
    if (rev?.entity === 'template') {
      const snapshot = JSON.parse(rev.snapshotJson);
      const current = await db.blankTemplate.findUnique({ where: { id: rev.entityId } });
      if (!deps.can(actor(req), 'blanks.manage') || (snapshot.scope === 'PERSONAL' && snapshot.ownerId !== actor(req).id) || (current?.scope === 'PERSONAL' && current.ownerId !== actor(req).id)) catalogFailure(403, 'Нет права восстановления шаблона');
      if (!snapshot.layoutJson) catalogFailure(400, 'Снимок шаблона не содержит данных');
      const { id, createdAt, updatedAt, ...fields } = snapshot;
      await db.$transaction(async (tx: any) => {
        if (current) await tx.catalogRevision.create({ data: { entity: 'template', entityId: id, action: 'restore', snapshotJson: JSON.stringify(current), userId: actor(req).id } });
        await tx.blankTemplate.upsert({ where: { id }, create: { id, ...fields }, update: fields });
      }); return res.json({ ok: true, id });
    }
    if (!rev || !CATALOG_ENTITIES[rev.entity as CatalogEntity]) catalogFailure(400, 'Для шаблона используйте его редактор; запись каталога не найдена');
    const snapshot = JSON.parse(rev.snapshotJson); const document = JSON.parse(snapshot.dataJson || '{}');
    if (!await catalogAllowed(db, actor(req), 'edit', document, deps.can, (req.params.entity || 'family') as CatalogEntity)) catalogFailure(403, 'Нет права правки');
    const draft = await stageCatalogDraft(db, rev.entity, rev.entityId, document, actor(req).id, snapshot.operation === 'archive' ? 'archive' : 'save', req.body?._draftVersion);
    res.json({ ok: true, id: rev.entityId, revision: draft.revision, draft: true });
  }));
  app.put('/api/catalog/:entity/:id', handle(async (req, res, db) => {
    const entity = req.params.entity as CatalogEntity; if (!CATALOG_ENTITIES[entity]) catalogFailure(404, 'Неизвестный вид записи');
    // Смена области не даёт редактору перенести чужую модель к себе.
    const existing = await db[CATALOG_ENTITIES[entity].model].findUnique({ where: { id: String(req.params.id) } });
    if (!await catalogAllowed(db, actor(req), 'edit', req.body, deps.can, entity) || (existing && !await catalogAllowed(db, actor(req), 'edit', JSON.parse(existing.dataJson), deps.can, entity))) catalogFailure(403, 'Нет права правки этой области');
    if (existing && !req.body?._draftVersion && req.body?._publishedHash === undefined) catalogFailure(409, 'Обновите запись перед сохранением');
    const draft = await stageCatalogDraft(db, entity, String(req.params.id), req.body, actor(req).id, 'save', req.body?._draftVersion); res.json({ ok: true, id: draft.id, revision: draft.revision, draft: true });
  }));
  app.delete('/api/catalog/learn/:id', handle(async (req, res, db) => {
    const row = await db.catalogLearn.findUnique({ where: { id: String(req.params.id) } });
    if (row && !await catalogAllowed(db, actor(req), 'edit', { classId: row.classId }, deps.can)) catalogFailure(403, 'Общие правила подбора меняет редактор каталога');
    if (row) await db.catalogLearn.delete({ where: { id: row.id } }); res.json({ ok: true });
  }));
  app.delete('/api/catalog/:entity/:id', handle(async (req, res, db) => {
    const entity = req.params.entity as CatalogEntity; if (!CATALOG_ENTITIES[entity]) catalogFailure(404, 'Неизвестный вид записи');
    const existing = await db[CATALOG_ENTITIES[entity].model].findUnique({ where: { id: String(req.params.id) } });
    const prior = (await listCatalogDrafts(db)).find(d => d.id === req.params.id && d.entity === entity);
    const document = prior?.document || (existing ? JSON.parse(existing.dataJson) : null);
    if (!document) catalogFailure(404, 'Запись не найдена');
    if (!await catalogAllowed(db, actor(req), 'edit', document, deps.can, (req.params.entity || 'family') as CatalogEntity)) catalogFailure(403, 'Нет права архива этой области');
    const draft = await stageCatalogDraft(db, entity, String(req.params.id), document, actor(req).id, 'archive', req.body?._draftVersion); res.json({ ok: true, id: draft.id, revision: draft.revision, draft: true });
  }));
}
