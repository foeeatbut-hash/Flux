import type { Express, Request, Response } from 'express';
import { getPrisma, sendError, broadcast } from '../context.js';
import { ensureTables, type TableSpec, type Col } from '../ddl.js';
import { seedCatalog, SEED_VERSION } from '../../catalog/seed.js';
import { defaultBlankTemplate } from '../../catalog/blank/defaults.js';
import type { Catalog, Family } from '../../catalog/model.js';
import { SIGNATURE_MAX } from '../../catalog/text.js';
import { registerCatalogSpreadsheetRoutes } from './catalogSpreadsheet.js';
import { templateProblem } from '../../catalog/blank/safe.js';
import { oncePerDatabase } from '../schemaRuntime.js';
import { registerCatalogAssetRoutes } from './catalogAssets.js';
import { registerCatalogWorkspaceRoutes } from './catalogWorkspace.js';
import { catalogSetting } from '../catalogWorkspace.js';
import { syncCatalogSeed } from '../catalogSeed.js';

/**
 * Каталог оборудования: справочник программы, а не проекта.
 *
 * Отдельным модулем, а не в server.ts: тот у предела храповика, а каталог —
 * своя область со своим сроком жизни. Записи хранятся документами JSON, а
 * каждая правка оставляет снимок ДО неё (CatalogRevision) — откат справочника
 * не должен зависеть от того, помнит ли кто-то, как было.
 */

const txt = (name: string, extra: Partial<Col> = {}): Col => ({ name, kind: 'text', ...extra });
const long = (name: string, def = '{}'): Col => ({ name, kind: 'longtext', def });
const time = (name: string, now = true): Col => ({ name, kind: 'time', ...(now ? { notNull: true, def: 'now' } : {}) });
const base = (cols: Col[]): Col[] => [txt('id', { pk: true, indexed: true }), ...cols, time('createdAt'), time('updatedAt')];

/**
 * Страховка поверх автомиграции: schema-sync создаёт таблицы, но не индексы,
 * а подбор ищет выученное по [classId, signature] на каждой строке импорта.
 */
const TABLES: TableSpec[] = [
  { table: 'CatalogClass', cols: base([txt('code', { notNull: true, indexed: true }), long('dataJson'), { name: 'sort', kind: 'int', notNull: true, def: 0 }]) },
  { table: 'CatalogManufacturer', cols: base([txt('name', { notNull: true }), long('dataJson')]) },
  {
    table: 'CatalogFamily',
    cols: base([
      txt('classId', { notNull: true, indexed: true }), txt('manufacturerId', { notNull: true }), txt('code', { notNull: true }), long('dataJson'),
      txt('status', { notNull: true, def: 'draft' }), { name: 'seedVersion', kind: 'int', notNull: true, def: 0 },
      { name: 'edited', kind: 'bool', notNull: true, def: false }, { name: 'sort', kind: 'int', notNull: true, def: 0 },
      txt('updatedById'), time('deletedAt', false),
    ]),
    indexes: [{ name: 'CatalogFamily_classId_idx', cols: ['classId'] }],
  },
  { table: 'CatalogComponent', cols: base([txt('classId', { notNull: true, indexed: true }), txt('kind', { notNull: true, def: 'other' }), txt('code', { notNull: true }), long('dataJson')]), indexes: [{ name: 'CatalogComponent_classId_idx', cols: ['classId'] }] },
  { table: 'CatalogTagRule', cols: base([txt('classId', { notNull: true, indexed: true }), txt('code', { notNull: true }), long('dataJson')]), indexes: [{ name: 'CatalogTagRule_classId_idx', cols: ['classId'] }] },
  {
    table: 'CatalogLearn',
    cols: base([txt('classId', { notNull: true, indexed: true }), txt('signature', { notNull: true, indexed: true }), txt('familyId', { notNull: true }), long('valuesJson'), { name: 'count', kind: 'int', notNull: true, def: 1 }, txt('createdById')]),
    indexes: [{ name: 'CatalogLearn_classId_signature_idx', cols: ['classId', 'signature'] }],
  },
  {
    table: 'CatalogRevision',
    cols: [txt('id', { pk: true, indexed: true }), txt('entity', { notNull: true, indexed: true }), txt('entityId', { notNull: true, indexed: true }), txt('action', { notNull: true, def: 'update' }), long('snapshotJson'), txt('userId'), time('createdAt')],
    indexes: [{ name: 'CatalogRevision_entity_entityId_idx', cols: ['entity', 'entityId'] }],
  },
  {
    table: 'BlankTemplate',
    cols: base([txt('name', { notNull: true }), txt('classId'), txt('scope', { notNull: true, def: 'SHARED', indexed: true }), txt('ownerId', { indexed: true }), long('layoutJson'), { name: 'isDefault', kind: 'bool', notNull: true, def: false }, { name: 'version', kind: 'int', notNull: true, def: 1 }, txt('createdById')]),
    indexes: [{ name: 'BlankTemplate_scope_ownerId_idx', cols: ['scope', 'ownerId'] }],
  },
  { table: 'ImportProfile', cols: base([txt('name', { notNull: true }), txt('signature', { notNull: true, indexed: true }), long('mappingJson'), txt('createdById')]), indexes: [{ name: 'ImportProfile_signature_idx', cols: ['signature'] }] },
];

export async function ensureCatalog(prisma: any): Promise<void> {
  return oncePerDatabase(prisma, `catalog:${SEED_VERSION}`, async () => {
    const err = await ensureTables(prisma, TABLES, undefined, true);
    if (err) throw new Error(err);
    await prisma.$transaction((db: any) => syncSeed(db), { timeout: 60000 });
  });
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};
const me = (req: Request) => (req as any).authUser || null;

/**
 * Затравка из кода — в базу.
 *
 * Пустой каталог заполняется целиком. Обновление программы больше не меняет
 * предметные данные. Новые редакции загружаются как черновики и публикуются
 * отдельно, с автором, проверкой конфликтов и общей версией в БД.
 */
async function syncSeed(prisma: any): Promise<void> {
  await syncCatalogSeed(prisma, seedCatalog(), SEED_VERSION, defaultBlankTemplate());
}

export async function readCatalog(prisma: any, withDeleted = false): Promise<Catalog & { meta: Record<string, any> }> {
  const [classes, mfs, fams, comps, rules] = await Promise.all([
    prisma.catalogClass.findMany({ orderBy: { sort: 'asc' } }),
    prisma.catalogManufacturer.findMany({ orderBy: { name: 'asc' } }),
    prisma.catalogFamily.findMany({ where: withDeleted ? {} : { deletedAt: null }, orderBy: [{ sort: 'asc' }, { code: 'asc' }] }),
    prisma.catalogComponent.findMany({ orderBy: { code: 'asc' } }),
    prisma.catalogTagRule.findMany({ orderBy: { code: 'asc' } }),
  ]);
  const meta: Record<string, any> = {};
  for (const r of fams) meta[r.id] = { edited: r.edited, seedVersion: r.seedVersion, updatedAt: r.updatedAt, deleted: !!r.deletedAt };
  return {
    classes: classes.filter((r: any) => parse<any>(r.dataJson, {}).publicationState !== 'archived').map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, code: r.code })),
    manufacturers: mfs.filter((r: any) => parse<any>(r.dataJson, {}).publicationState !== 'archived').map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, name: r.name })),
    families: fams.map((r: any) => ({ ...parse<Family>(r.dataJson, {} as Family), id: r.id, classId: r.classId, manufacturerId: r.manufacturerId, code: r.code, status: r.status })),
    components: comps.filter((r: any) => parse<any>(r.dataJson, {}).publicationState !== 'archived').map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, classId: r.classId, kind: r.kind, code: r.code })),
    tagRules: rules.filter((r: any) => parse<any>(r.dataJson, {}).publicationState !== 'archived').map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, classId: r.classId, code: r.code })),
    meta,
  };
}

/** Метка версии каталога: окно перечитывает каталог, только когда она сменилась */
async function stampOf(prisma: any): Promise<string> {
  const publication = await catalogSetting(prisma, 'catalog_publication', { number: 0 });
  const parts = await Promise.all([
    prisma.catalogFamily.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogComponent.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogTagRule.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogClass.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogManufacturer.aggregate({ _max: { updatedAt: true }, _count: true }),
  ]);
  return `${publication.number}/` + parts.map((p: any) => `${p._count}:${p._max?.updatedAt ? new Date(p._max.updatedAt).getTime() : 0}`).join('/');
}

async function snapshot(prisma: any, entity: string, entityId: string, action: string, row: any, userId?: string) {
  await prisma.catalogRevision.create({ data: { entity, entityId, action, snapshotJson: JSON.stringify(row || {}), userId: userId || null } });
}

export function registerCatalogRoutes(app: Express, can: (user: any, feature: string) => boolean): void {
  registerCatalogAssetRoutes(app, { ensure: ensureCatalog, read: readCatalog, can });
  registerCatalogWorkspaceRoutes(app, { ensure: ensureCatalog, read: readCatalog, can });
  registerCatalogSpreadsheetRoutes(app, { ensure: ensureCatalog, readCatalog, can });
  app.get('/api/catalog', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const cat = await readCatalog(prisma, req.query.deleted === '1');
      res.json({ ...cat, stamp: await stampOf(prisma) });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/catalog/stamp', async (_req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      res.json({ stamp: await stampOf(prisma) });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/catalog/:entity/:id/revisions', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const rows = await prisma.catalogRevision.findMany({
        where: { entity: String(req.params.entity), entityId: String(req.params.id) },
        orderBy: { createdAt: 'desc' }, take: 50,
      });
      res.json({ revisions: rows.map((r: any) => ({ id: r.id, action: r.action, userId: r.userId, createdAt: r.createdAt })) });
    } catch (err: any) { sendError(res, err); }
  });

  // Экспорт всегда содержит только опубликованные данные.
  app.get('/api/catalog/export', async (_req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const cat = await readCatalog(prisma);
      res.json({ format: 'flux-catalog', version: 1, exportedAt: new Date().toISOString(), ...cat, meta: undefined });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Обучение подбора ─────────────────────────────────────────────────────

  app.get('/api/catalog/learn', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const rows = await prisma.catalogLearn.findMany({
        where: req.query.classId ? { classId: String(req.query.classId) } : {},
        orderBy: { updatedAt: 'desc' }, take: 5000,
      });
      res.json({ learned: rows.map((r: any) => ({ id: r.id, classId: r.classId, signature: r.signature, familyId: r.familyId, values: parse(r.valuesJson, {}), count: r.count, updatedAt: r.updatedAt })) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Запомнить выбор. Размеры не запоминаются никогда — они у каждой строки
   * свои и берутся из описания; запомнить их значило бы подставлять 900×400
   * в строку, где написано 1000×500.
   */
  app.post('/api/catalog/learn', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const b = (req.body || {}) as any;
      const signature = String(b.signature || '');
      if (!signature || !b.familyId || !b.classId) return res.status(400).json({ error: 'Нечего запоминать' });
      // Подпись собирает signatureOf, и длиннее она не бывает; длиннее — значит
      // прислал не он, а на MariaDB такая строка всё равно не запишется
      if (signature.length > SIGNATURE_MAX + 1) return res.status(400).json({ error: 'Подпись описания длиннее допустимого' });
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.values || {})) if (!['W', 'H', 'D'].includes(k)) values[k] = v;
      const row = await prisma.catalogLearn.findFirst({ where: { classId: String(b.classId), signature } });
      if (row) {
        await prisma.catalogLearn.update({ where: { id: row.id }, data: { familyId: String(b.familyId), valuesJson: JSON.stringify(values), count: row.familyId === b.familyId ? row.count + 1 : 1 } });
      } else {
        await prisma.catalogLearn.create({ data: { classId: String(b.classId), signature, familyId: String(b.familyId), valuesJson: JSON.stringify(values), createdById: me(req)?.id || null } });
      }
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  app.delete('/api/catalog/learn/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      await prisma.catalogLearn.deleteMany({ where: { id: String(req.params.id) } });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Шаблоны бланков ──────────────────────────────────────────────────────

  const toTemplate = (r: any) => ({
    id: r.id, name: r.name, classId: r.classId || null, scope: r.scope, ownerId: r.ownerId || null,
    isDefault: !!r.isDefault, version: r.version, layout: parse(r.layoutJson, null), updatedAt: r.updatedAt,
  });

  app.get('/api/blank-templates', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const rows = await prisma.blankTemplate.findMany({
        where: { OR: [{ scope: 'SHARED' }, { scope: 'PERSONAL', ownerId: me(req)?.id || '—' }] },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      });
      res.json({ templates: rows.map(toTemplate) });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/blank-templates/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const b = (req.body || {}) as any;
      const name = String(b.name || b.layout?.name || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'У шаблона нет имени' });
      if (!b.layout || !Array.isArray(b.layout.sheets) || !Array.isArray(b.layout.columns)) return res.status(400).json({ error: 'Шаблон испорчен: нет листов или колонок' });
      const unsafe = templateProblem(b.layout);
      if (unsafe) return res.status(400).json({ error: unsafe });
      const id = String(req.params.id);
      const user = me(req);
      const before = await prisma.blankTemplate.findUnique({ where: { id } });
      if (before?.scope === 'PERSONAL' && before.ownerId !== user?.id) return res.status(403).json({ error: 'Это личный шаблон другого сотрудника' });
      const personal = String(b.scope || before?.scope || 'SHARED') === 'PERSONAL';
      const data = {
        name, classId: b.classId || null, scope: personal ? 'PERSONAL' : 'SHARED',
        ownerId: personal ? user?.id || null : null, layoutJson: JSON.stringify({ ...b.layout, name }),
      };
      if (b.isDefault) await prisma.blankTemplate.updateMany({ where: { isDefault: true, classId: data.classId }, data: { isDefault: false } });
      if (before) {
        await snapshot(prisma, 'template', id, 'update', before, user?.id);
        await prisma.blankTemplate.update({ where: { id }, data: { ...data, isDefault: !!b.isDefault || before.isDefault, version: before.version + 1 } });
      } else {
        await prisma.blankTemplate.create({ data: { id, ...data, isDefault: !!b.isDefault, createdById: user?.id || null } });
      }
      res.json({ ok: true, id });
    } catch (err: any) { sendError(res, err); }
  });

  app.delete('/api/blank-templates/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const row = await prisma.blankTemplate.findUnique({ where: { id: String(req.params.id) } });
      if (!row) return res.json({ ok: true });
      if (row.scope === 'PERSONAL' && row.ownerId !== me(req)?.id) return res.status(403).json({ error: 'Это личный шаблон другого сотрудника' });
      await snapshot(prisma, 'template', row.id, 'delete', row, me(req)?.id);
      await prisma.blankTemplate.delete({ where: { id: row.id } });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Профили форматов таблиц ──────────────────────────────────────────────

  app.get('/api/import-profiles', async (_req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const rows = await prisma.importProfile.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 });
      res.json({ profiles: rows.map((r: any) => ({ id: r.id, name: r.name, signature: r.signature, mapping: parse(r.mappingJson, {}), updatedAt: r.updatedAt })) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/import-profiles', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensureCatalog(prisma);
      const b = (req.body || {}) as any;
      const signature = String(b.signature || '');
      if (!signature) return res.status(400).json({ error: 'Нет подписи формата' });
      const row = await prisma.importProfile.findFirst({ where: { signature } });
      const data = { name: String(b.name || 'Формат таблицы').slice(0, 200), signature, mappingJson: JSON.stringify(b.mapping || {}) };
      if (row) await prisma.importProfile.update({ where: { id: row.id }, data });
      else await prisma.importProfile.create({ data: { ...data, createdById: me(req)?.id || null } });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });
}
