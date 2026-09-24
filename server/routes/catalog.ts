import type { Express, Request, Response } from 'express';
import { getPrisma, onDatabaseSwapped, sendError, broadcast } from '../context.js';
import { ensureTables, type TableSpec, type Col } from '../ddl.js';
import { seedCatalog, SEED_VERSION } from '../../catalog/seed.js';
import { defaultBlankTemplate } from '../../catalog/blank/defaults.js';
import type { Catalog, Family } from '../../catalog/model.js';

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

let ready = false;
let seeded = false;
onDatabaseSwapped(() => { ready = false; seeded = false; });

async function ensure(prisma: any): Promise<void> {
  if (!ready) {
    const err = await ensureTables(prisma, TABLES);
    if (err) throw new Error(err);
    ready = true;
  }
  if (!seeded) {
    await syncSeed(prisma);
    seeded = true;
  }
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};
const me = (req: Request) => (req as any).authUser || null;

/**
 * Затравка из кода — в базу.
 *
 * Пустой каталог заполняется целиком. Потом при каждом обновлении программы
 * докладываются новые семейства и обновляются те, что пришли из затравки и
 * НЕ правлены человеком (`edited`). Правленое не трогаем никогда: инженер
 * сверил семейство со страницей каталога, и обновление программы не должно
 * молча вернуть распознанные с ошибкой цифры.
 */
async function syncSeed(prisma: any): Promise<void> {
  const seed = seedCatalog();
  for (const c of seed.classes) {
    const row = await prisma.catalogClass.findUnique({ where: { id: c.id } });
    if (!row) await prisma.catalogClass.create({ data: { id: c.id, code: c.code, dataJson: JSON.stringify(c), sort: c.sort || 0 } });
  }
  for (const m of seed.manufacturers) {
    const row = await prisma.catalogManufacturer.findUnique({ where: { id: m.id } });
    if (!row) await prisma.catalogManufacturer.create({ data: { id: m.id, name: m.name, dataJson: JSON.stringify(m) } });
  }
  const existing = await prisma.catalogFamily.findMany({ select: { id: true, seedVersion: true, edited: true } });
  const byId = new Map<string, any>(existing.map((r: any) => [r.id, r]));
  for (const f of seed.families) {
    const row = byId.get(f.id);
    const data = { classId: f.classId, manufacturerId: f.manufacturerId, code: f.code, dataJson: JSON.stringify(f), status: f.status, seedVersion: SEED_VERSION, sort: f.sort || 0 };
    if (!row) await prisma.catalogFamily.create({ data: { id: f.id, ...data } });
    else if (!row.edited && row.seedVersion < SEED_VERSION) await prisma.catalogFamily.update({ where: { id: f.id }, data });
  }
  for (const c of seed.components) {
    const row = await prisma.catalogComponent.findUnique({ where: { id: c.id } });
    if (!row) await prisma.catalogComponent.create({ data: { id: c.id, classId: c.classId, kind: c.kind, code: c.code, dataJson: JSON.stringify(c) } });
  }
  for (const r of seed.tagRules) {
    const row = await prisma.catalogTagRule.findUnique({ where: { id: r.id } });
    if (!row) await prisma.catalogTagRule.create({ data: { id: r.id, classId: r.classId, code: r.code, dataJson: JSON.stringify(r) } });
  }
  const templates = await prisma.blankTemplate.count();
  if (!templates) {
    const t = defaultBlankTemplate();
    await prisma.blankTemplate.create({ data: { id: 'tpl-veza-order', name: t.name, scope: 'SHARED', layoutJson: JSON.stringify(t), isDefault: true } });
  }
}

async function readCatalog(prisma: any, withDeleted = false): Promise<Catalog & { meta: Record<string, any> }> {
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
    classes: classes.map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, code: r.code })),
    manufacturers: mfs.map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, name: r.name })),
    families: fams.map((r: any) => ({ ...parse<Family>(r.dataJson, {} as Family), id: r.id, classId: r.classId, manufacturerId: r.manufacturerId, code: r.code, status: r.status })),
    components: comps.map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, classId: r.classId, kind: r.kind, code: r.code })),
    tagRules: rules.map((r: any) => ({ ...parse(r.dataJson, {}), id: r.id, classId: r.classId, code: r.code })),
    meta,
  };
}

/** Метка версии каталога: окно перечитывает каталог, только когда она сменилась */
async function stampOf(prisma: any): Promise<string> {
  const parts = await Promise.all([
    prisma.catalogFamily.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogComponent.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogTagRule.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogClass.aggregate({ _max: { updatedAt: true }, _count: true }),
    prisma.catalogManufacturer.aggregate({ _max: { updatedAt: true }, _count: true }),
  ]);
  return parts.map((p: any) => `${p._count}:${p._max?.updatedAt ? new Date(p._max.updatedAt).getTime() : 0}`).join('/');
}

const ENTITY: Record<string, { model: string; fields: (d: any) => Record<string, unknown> }> = {
  family: { model: 'catalogFamily', fields: (d) => ({ classId: String(d.classId || ''), manufacturerId: String(d.manufacturerId || ''), code: String(d.code || '').trim(), status: String(d.status || 'draft'), sort: Number(d.sort) || 0 }) },
  component: { model: 'catalogComponent', fields: (d) => ({ classId: String(d.classId || ''), kind: String(d.kind || 'other'), code: String(d.code || '').trim() }) },
  tagRule: { model: 'catalogTagRule', fields: (d) => ({ classId: String(d.classId || ''), code: String(d.code || '').trim().toUpperCase() }) },
  class: { model: 'catalogClass', fields: (d) => ({ code: String(d.code || '').trim(), sort: Number(d.sort) || 0 }) },
  manufacturer: { model: 'catalogManufacturer', fields: (d) => ({ name: String(d.name || '').trim() }) },
};

async function snapshot(prisma: any, entity: string, entityId: string, action: string, row: any, userId?: string) {
  await prisma.catalogRevision.create({ data: { entity, entityId, action, snapshotJson: JSON.stringify(row || {}), userId: userId || null } });
}

/** Что не так с записью — до записи, а не после */
function whyNot(entity: string, d: any): string {
  if (entity === 'family') {
    if (!String(d.code || '').trim()) return 'У семейства нет кода';
    if (!d.classId) return 'Не указан класс оборудования';
    if (!Array.isArray(d.positions) || !d.positions.length) return 'У семейства нет ни одной позиции обозначения';
    if (!Array.isArray(d.params)) return 'Параметры семейства испорчены';
  }
  if ((entity === 'component' || entity === 'tagRule') && !String(d.code || '').trim()) return 'Нет кода';
  if (entity === 'class' && !String(d.code || '').trim()) return 'У класса нет кода';
  if (entity === 'manufacturer' && !String(d.name || '').trim()) return 'У производителя нет названия';
  return '';
}

export function registerCatalogRoutes(app: Express): void {
  app.get('/api/catalog', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const cat = await readCatalog(prisma, req.query.deleted === '1');
      res.json({ ...cat, stamp: await stampOf(prisma) });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/catalog/stamp', async (_req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      res.json({ stamp: await stampOf(prisma) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Сохранить запись каталога (создать или изменить).
   *
   * Семейство, пришедшее из затравки, после правки помечается `edited` — и с
   * этого момента обновление программы его не трогает.
   */
  app.put('/api/catalog/:entity/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const entity = String(req.params.entity);
      const spec = ENTITY[entity];
      if (!spec) return res.status(404).json({ error: 'Нет такого вида записи' });
      const body = (req.body || {}) as any;
      const why = whyNot(entity, body);
      if (why) return res.status(400).json({ error: why });
      const id = String(req.params.id);
      const model = prisma[spec.model];
      const before = await model.findUnique({ where: { id } });
      const userId = me(req)?.id;
      const data: any = { ...spec.fields(body), dataJson: JSON.stringify({ ...body, id }) };
      if (entity === 'family') { data.edited = true; data.updatedById = userId || null; data.deletedAt = null; }
      let row;
      if (before) {
        await snapshot(prisma, entity, id, 'update', before, userId);
        row = await model.update({ where: { id }, data });
      } else {
        row = await model.create({ data: { id, ...data } });
      }
      broadcast('catalog:changed', { entity, id });
      res.json({ ok: true, id: row.id });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Удаление. Семейство удаляется мягко: на него ссылаются позиции ведомостей
   * всех проектов, и жёсткое удаление оставило бы их без описания.
   */
  app.delete('/api/catalog/:entity/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const entity = String(req.params.entity);
      const spec = ENTITY[entity];
      if (!spec) return res.status(404).json({ error: 'Нет такого вида записи' });
      const id = String(req.params.id);
      const model = prisma[spec.model];
      const before = await model.findUnique({ where: { id } });
      if (!before) return res.json({ ok: true });
      await snapshot(prisma, entity, id, 'delete', before, me(req)?.id);
      if (entity === 'family') await model.update({ where: { id }, data: { deletedAt: new Date(), edited: true } });
      else await model.delete({ where: { id } });
      broadcast('catalog:changed', { entity, id });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/catalog/:entity/:id/revisions', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const rows = await prisma.catalogRevision.findMany({
        where: { entity: String(req.params.entity), entityId: String(req.params.id) },
        orderBy: { createdAt: 'desc' }, take: 50,
      });
      res.json({ revisions: rows.map((r: any) => ({ id: r.id, action: r.action, userId: r.userId, createdAt: r.createdAt })) });
    } catch (err: any) { sendError(res, err); }
  });

  /** Вернуть запись к снимку. Текущее состояние перед этим тоже снимается — откат отменяем */
  app.post('/api/catalog/revisions/:id/restore', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const rev = await prisma.catalogRevision.findUnique({ where: { id: String(req.params.id) } });
      if (!rev) return res.status(404).json({ error: 'Снимок не найден' });
      // Шаблоны бланков откатываются тем же снимком, но правятся своим
      // маршрутом — поэтому их модель здесь, а не в ENTITY
      const modelName = rev.entity === 'template' ? 'blankTemplate' : ENTITY[rev.entity]?.model;
      if (!modelName) return res.status(400).json({ error: 'Этот снимок не восстанавливается' });
      const model = prisma[modelName];
      const snap = parse<any>(rev.snapshotJson, null);
      if (!snap?.id) return res.status(400).json({ error: 'Снимок испорчен' });
      const cur = await model.findUnique({ where: { id: snap.id } });
      if (cur) await snapshot(prisma, rev.entity, snap.id, 'restore', cur, me(req)?.id);
      const { id, createdAt, updatedAt, ...fields } = snap;
      if (rev.entity === 'family') fields.edited = true;
      if (cur) await model.update({ where: { id }, data: fields });
      else await model.create({ data: { id, ...fields } });
      broadcast('catalog:changed', { entity: rev.entity, id });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Вернуть семейство к затравке: снять пометку «правлено» и переписать из
   * кода. Нужна, когда правка оказалась ошибкой, а снимков уже много.
   */
  app.post('/api/catalog/family/:id/reseed', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const f = seedCatalog().families.find((x) => x.id === req.params.id);
      if (!f) return res.status(404).json({ error: 'Этого семейства нет в затравке программы' });
      const before = await prisma.catalogFamily.findUnique({ where: { id: f.id } });
      if (before) await snapshot(prisma, 'family', f.id, 'seed', before, me(req)?.id);
      const data = { classId: f.classId, manufacturerId: f.manufacturerId, code: f.code, dataJson: JSON.stringify(f), status: f.status, seedVersion: SEED_VERSION, edited: false, deletedAt: null, sort: f.sort || 0 };
      if (before) await prisma.catalogFamily.update({ where: { id: f.id }, data });
      else await prisma.catalogFamily.create({ data: { id: f.id, ...data } });
      broadcast('catalog:changed', { entity: 'family', id: f.id });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Обмен каталогом между серверами ──────────────────────────────────────

  app.get('/api/catalog/export', async (_req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const cat = await readCatalog(prisma);
      res.json({ format: 'flux-catalog', version: 1, exportedAt: new Date().toISOString(), ...cat, meta: undefined });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Загрузить каталог из файла. Режим `plan` ничего не пишет и отвечает, что
   * будет добавлено и что изменится; запись — вторым запросом с `apply`.
   */
  app.post('/api/catalog/import', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const body = (req.body || {}) as any;
      if (body.format !== 'flux-catalog') return res.status(400).json({ error: 'Это не файл каталога Flux' });
      const apply = body.mode === 'apply';
      const plan: Array<{ entity: string; id: string; code: string; action: 'new' | 'update' | 'same' }> = [];
      const lists: Array<[string, any[]]> = [['class', body.classes], ['manufacturer', body.manufacturers], ['family', body.families], ['component', body.components], ['tagRule', body.tagRules]];
      for (const [entity, list] of lists) {
        const spec = ENTITY[entity];
        for (const d of Array.isArray(list) ? list : []) {
          if (!d?.id || whyNot(entity, d)) continue;
          const model = prisma[spec.model];
          const before = await model.findUnique({ where: { id: String(d.id) } });
          const json = JSON.stringify(d);
          const action = !before ? 'new' : before.dataJson === json ? 'same' : 'update';
          plan.push({ entity, id: d.id, code: d.code || d.name || d.id, action });
          if (!apply || action === 'same') continue;
          const data: any = { ...spec.fields(d), dataJson: json };
          if (entity === 'family') data.edited = true;
          if (before) { await snapshot(prisma, entity, d.id, 'update', before, me(req)?.id); await model.update({ where: { id: d.id }, data }); }
          else await model.create({ data: { id: d.id, ...data } });
        }
      }
      if (apply) broadcast('catalog:changed', { entity: 'all' });
      res.json({ plan, applied: apply });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Обучение подбора ─────────────────────────────────────────────────────

  app.get('/api/catalog/learn', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
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
      await ensure(prisma);
      const b = (req.body || {}) as any;
      const signature = String(b.signature || '').slice(0, 600);
      if (!signature || !b.familyId || !b.classId) return res.status(400).json({ error: 'Нечего запоминать' });
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
      await ensure(prisma);
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
      await ensure(prisma);
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
      await ensure(prisma);
      const b = (req.body || {}) as any;
      const name = String(b.name || b.layout?.name || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'У шаблона нет имени' });
      if (!b.layout || !Array.isArray(b.layout.sheets) || !Array.isArray(b.layout.columns)) return res.status(400).json({ error: 'Шаблон испорчен: нет листов или колонок' });
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
      await ensure(prisma);
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
      await ensure(prisma);
      const rows = await prisma.importProfile.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 });
      res.json({ profiles: rows.map((r: any) => ({ id: r.id, name: r.name, signature: r.signature, mapping: parse(r.mappingJson, {}), updatedAt: r.updatedAt })) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/import-profiles', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
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
