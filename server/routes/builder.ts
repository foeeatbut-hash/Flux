import type { Express, Request, Response } from 'express';
import { getPrisma, onDatabaseSwapped, sendError, broadcast } from '../context.js';
import { ensureTables, type TableSpec, type Col } from '../ddl.js';
import { planTagLinks, type TagLink } from '../equipmentTags.js';
import { importPolicyOfProject } from './tagPolicy.js';
import { validateTag } from '../../equipment/tagPolicy.js';

/**
 * Конструктор: ведомости подбора оборудования по проекту.
 *
 * Все записи в ведомость идут одним путём — пакетом (`apply`): и импорт MTO,
 * и групповая правка, и правка одной ячейки. У каждого пакета снимок ДО
 * записи, поэтому любое действие отменяется (flux-data-safety, п. 6), а
 * отмена одной правки ничем не отличается от отмены импорта на сто строк.
 */

const txt = (name: string, extra: Partial<Col> = {}): Col => ({ name, kind: 'text', ...extra });
const long = (name: string, def = '{}'): Col => ({ name, kind: 'longtext', def });
const time = (name: string, now = true): Col => ({ name, kind: 'time', ...(now ? { notNull: true, def: 'now' } : {}) });

const TABLES: TableSpec[] = [
  {
    table: 'SelectionList',
    cols: [
      txt('id', { pk: true, indexed: true }), txt('projectId', { notNull: true, indexed: true }), txt('classId', { notNull: true }),
      txt('name', { notNull: true, def: 'Ведомость' }), long('headerJson'), long('orderNosJson'), txt('templateId'), txt('lang', { notNull: true, def: 'ru' }),
      txt('createdById'), txt('updatedById'), time('deletedAt', false), time('createdAt'), time('updatedAt'),
    ],
    indexes: [{ name: 'SelectionList_projectId_idx', cols: ['projectId'] }],
  },
  {
    table: 'SelectionItem',
    cols: [
      txt('id', { pk: true, indexed: true }), txt('listId', { notNull: true, indexed: true }), txt('projectId', { notNull: true }), long('dataJson'),
      { name: 'tagsText', kind: 'longtext', def: '' }, txt('familyId'), txt('status', { notNull: true, def: 'draft' }), { name: 'sort', kind: 'int', notNull: true, def: 0 },
      txt('updatedById'), time('deletedAt', false), time('createdAt'), time('updatedAt'),
    ],
    indexes: [{ name: 'SelectionItem_listId_idx', cols: ['listId'] }],
  },
  {
    table: 'SelectionIssue',
    cols: [
      txt('id', { pk: true, indexed: true }), txt('listId', { notNull: true, indexed: true }), txt('projectId', { notNull: true }), txt('rev', { notNull: true, indexed: true }),
      txt('date', { notNull: true, def: '' }), { name: 'reason', kind: 'longtext', def: '' }, txt('prepared', { notNull: true, def: '' }), txt('checked', { notNull: true, def: '' }),
      txt('approved', { notNull: true, def: '' }), long('snapshotJson'), { name: 'diffText', kind: 'longtext', def: '' }, txt('fileId'), txt('createdById'), time('createdAt'),
    ],
    // Одна ревизия — один выпуск. Проверка «уже выпущена» до записи не
    // атомарна: два нажатия подряд записали бы две ревизии 0
    indexes: [{ name: 'SelectionIssue_listId_idx', cols: ['listId'] }, { name: 'SelectionIssue_listId_rev_key', cols: ['listId', 'rev'], unique: true }],
  },
  {
    table: 'SelectionBatch',
    cols: [
      txt('id', { pk: true, indexed: true }), txt('listId', { notNull: true, indexed: true }), txt('projectId', { notNull: true }), txt('title', { notNull: true }),
      long('beforeJson'), { name: 'undone', kind: 'bool', notNull: true, def: false }, txt('createdById'), time('createdAt'),
    ],
    indexes: [{ name: 'SelectionBatch_listId_idx', cols: ['listId'] }],
  },
];

/**
 * Срок транзакции пакета. По умолчанию Prisma даёт интерактивной транзакции
 * 5 секунд, а импорт MTO — это полторы сотни позиций в одной транзакции: на
 * SQLite они не успевали, транзакция закрывалась посреди записи, и «Записать»
 * отвечал ошибкой, ничего не сохранив
 */
const TX_LONG = { maxWait: 20_000, timeout: 120_000 };

let ready = false;
onDatabaseSwapped(() => { ready = false; });
async function ensure(prisma: any): Promise<void> {
  if (ready) return;
  const err = await ensureTables(prisma, TABLES);
  if (err) throw new Error(err);
  ready = true;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};
const me = (req: Request) => (req as any).authUser || null;

function toList(r: any, counts?: { items: number; qty: number }) {
  return {
    id: r.id, projectId: r.projectId, classId: r.classId, name: r.name,
    header: parse(r.headerJson, {}), orderNos: parse(r.orderNosJson, {}),
    templateId: r.templateId || null, lang: r.lang || 'ru', updatedAt: r.updatedAt, createdAt: r.createdAt,
    ...(counts ? counts : {}),
  };
}

function toItem(r: any) {
  const d = parse<any>(r.dataJson, {});
  return { ...d, id: r.id, familyId: r.familyId || d.familyId, status: r.status || d.status || 'draft', sort: r.sort ?? d.sort ?? 0, updatedAt: r.updatedAt };
}

/** Позиция → поля строки. Теги строкой — для поиска по ведомостям проекта */
function rowData(it: any, userId?: string) {
  const { id, updatedAt, ...data } = it || {};
  const tags: string[] = Array.isArray(data.tags) ? data.tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [];
  data.tags = tags;
  data.qty = Number(data.qty) || 0;
  return {
    dataJson: JSON.stringify(data),
    tagsText: tags.join(' ').toLowerCase(),
    familyId: data.familyId || null,
    status: String(data.status || 'draft'),
    sort: Number(data.sort) || 0,
    updatedById: userId || null,
  };
}

async function listOr404(prisma: any, id: string, res: Response) {
  const list = await prisma.selectionList.findUnique({ where: { id } });
  if (!list || list.deletedAt) { res.status(404).json({ error: 'Ведомость не найдена' }); return null; }
  return list;
}

export function registerBuilderRoutes(app: Express): void {
  app.get('/api/builder/lists', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const projectId = String(req.query.projectId || '');
      if (!projectId) return res.status(400).json({ error: 'Не выбран проект' });
      const lists = await prisma.selectionList.findMany({ where: { projectId, deletedAt: null }, orderBy: { updatedAt: 'desc' } });
      const items = await prisma.selectionItem.findMany({ where: { projectId, deletedAt: null }, select: { listId: true, dataJson: true } });
      const counts = new Map<string, { items: number; qty: number }>();
      for (const it of items) {
        const c = counts.get(it.listId) || { items: 0, qty: 0 };
        c.items++;
        c.qty += Number(parse<any>(it.dataJson, {}).qty) || 0;
        counts.set(it.listId, c);
      }
      res.json({ lists: lists.map((l: any) => toList(l, counts.get(l.id) || { items: 0, qty: 0 })) });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/builder/lists', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const b = (req.body || {}) as any;
      const projectId = String(b.projectId || '');
      if (!projectId) return res.status(400).json({ error: 'Не выбран проект' });
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) return res.status(404).json({ error: 'Проект не найден' });
      const header = { object: project.name || '', ...(b.header || {}) };
      const row = await prisma.selectionList.create({
        data: {
          projectId, classId: String(b.classId || 'cls-valve'), name: String(b.name || 'Ведомость').slice(0, 200),
          headerJson: JSON.stringify(header), templateId: b.templateId || null, lang: b.lang || 'ru',
          createdById: me(req)?.id || null, updatedById: me(req)?.id || null,
        },
      });
      res.json({ list: toList(row, { items: 0, qty: 0 }) });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/builder/lists/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const list = await listOr404(prisma, String(req.params.id), res);
      if (!list) return;
      const items = await prisma.selectionItem.findMany({ where: { listId: list.id, deletedAt: null }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
      res.json({ list: toList(list), items: items.map(toItem) });
    } catch (err: any) { sendError(res, err); }
  });

  app.put('/api/builder/lists/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const list = await listOr404(prisma, String(req.params.id), res);
      if (!list) return;
      const b = (req.body || {}) as any;
      const data: any = { updatedById: me(req)?.id || null };
      if (b.name !== undefined) data.name = String(b.name).slice(0, 200) || list.name;
      if (b.header !== undefined) data.headerJson = JSON.stringify(b.header || {});
      if (b.orderNos !== undefined) data.orderNosJson = JSON.stringify(b.orderNos || {});
      if (b.templateId !== undefined) data.templateId = b.templateId || null;
      if (b.lang !== undefined) data.lang = ['ru', 'en', 'ru+en'].includes(b.lang) ? b.lang : 'ru';
      const row = await prisma.selectionList.update({ where: { id: list.id }, data });
      broadcast('builder:list', { listId: list.id });
      res.json({ list: toList(row) });
    } catch (err: any) { sendError(res, err); }
  });

  /** Ведомость удаляется мягко: в ней может быть выпущенный комплект */
  app.delete('/api/builder/lists/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      await prisma.selectionList.updateMany({ where: { id: String(req.params.id) }, data: { deletedAt: new Date() } });
      res.json({ ok: true });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Записать пакет: новые и изменённые позиции, снятые позиции.
   *
   * Снимок прежних строк снимается до записи и лежит в пакете. Запись — одна
   * транзакция: половина импорта хуже, чем ни одного.
   */
  app.post('/api/builder/lists/:id/apply', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const list = await listOr404(prisma, String(req.params.id), res);
      if (!list) return;
      const b = (req.body || {}) as any;
      const upserts: any[] = Array.isArray(b.upserts) ? b.upserts : [];
      const removeIds: string[] = Array.isArray(b.removeIds) ? b.removeIds.map(String) : [];
      if (!upserts.length && !removeIds.length) return res.json({ batchId: null, items: [] });
      const userId = me(req)?.id;
      const ids = [...upserts.map((u) => u.id).filter(Boolean), ...removeIds];
      const created: string[] = [];
      const saved: any[] = [];
      let batchId = '';
      const stale: Array<{ id: string; tags: string[] }> = [];
      await prisma.$transaction(async (tx: any) => {
        const before = ids.length ? await tx.selectionItem.findMany({ where: { id: { in: ids }, listId: list.id } }) : [];
        const beforeById = new Map<string, any>(before.map((r: any) => [r.id, r]));
        /**
         * Позиция приходит целиком, и без сверки версии второй инженер с
         * открытой пять минут назад ведомостью молча затирал бы правку
         * первого. Окно шлёт updatedAt той версии, которую видело; разошлась —
         * ничего не пишем и говорим, какие позиции изменились
         */
        for (const u of upserts) {
          const cur = u.id ? beforeById.get(u.id) : undefined;
          if (cur && u.updatedAt && new Date(cur.updatedAt).getTime() !== new Date(u.updatedAt).getTime()) {
            stale.push({ id: cur.id, tags: parse<any>(cur.dataJson, {}).tags || [] });
          }
        }
        if (stale.length) return;
        for (const u of upserts) {
          const data = rowData(u, userId);
          if (u.id && beforeById.has(u.id)) {
            saved.push(await tx.selectionItem.update({ where: { id: u.id }, data: { ...data, deletedAt: null } }));
          } else {
            const row = await tx.selectionItem.create({ data: { ...(u.id ? { id: u.id } : {}), listId: list.id, projectId: list.projectId, ...data } });
            created.push(row.id);
            saved.push(row);
          }
        }
        if (removeIds.length) await tx.selectionItem.updateMany({ where: { id: { in: removeIds }, listId: list.id }, data: { deletedAt: new Date(), updatedById: userId || null } });
        await tx.selectionList.update({ where: { id: list.id }, data: { updatedById: userId || null } });
        // Пакет отмены — в той же транзакции: запись без снимка отменить нечем
        const batch = await tx.selectionBatch.create({
          data: {
            listId: list.id, projectId: list.projectId, title: String(b.title || 'Правка ведомости').slice(0, 300),
            beforeJson: JSON.stringify({ rows: before, created }), createdById: userId || null,
          },
        });
        batchId = batch.id;
      }, TX_LONG);
      if (stale.length) {
        const names = stale.map((x) => x.tags[0] || x.id).slice(0, 5).join(', ');
        return res.status(409).json({ error: `Позиции уже изменил другой сотрудник: ${names}${stale.length > 5 ? '…' : ''}. Ведомость перечитана — повторите правку.`, stale: stale.map((x) => x.id) });
      }
      broadcast('builder:list', { listId: list.id });
      res.json({ batchId, items: saved.map(toItem), removed: removeIds });
    } catch (err: any) { sendError(res, err); }
  });

  app.get('/api/builder/lists/:id/batches', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const rows = await prisma.selectionBatch.findMany({ where: { listId: String(req.params.id) }, orderBy: { createdAt: 'desc' }, take: 40 });
      res.json({ batches: rows.map((r: any) => ({ id: r.id, title: r.title, undone: r.undone, createdAt: r.createdAt, createdById: r.createdById })) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Отменить пакет. Изменённые строки возвращаются к снимку, созданные —
   * снимаются, снятые — возвращаются. Отменённый пакет второй раз не
   * отменяется: снимок уже потрачен.
   */
  app.post('/api/builder/batches/:id/undo', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const batch = await prisma.selectionBatch.findUnique({ where: { id: String(req.params.id) } });
      if (!batch) return res.status(404).json({ error: 'Действие не найдено' });
      if (batch.undone) return res.status(409).json({ error: 'Это действие уже отменено' });
      const snap = parse<{ rows: any[]; created: string[]; createdTags?: string[] }>(batch.beforeJson, { rows: [], created: [] });
      const keptTags: string[] = [];
      let removedTags = 0;
      await prisma.$transaction(async (tx: any) => {
        for (const r of snap.rows) {
          const { id, createdAt, updatedAt, ...fields } = r;
          await tx.selectionItem.update({ where: { id }, data: { ...fields, deletedAt: r.deletedAt ? new Date(r.deletedAt) : null } });
        }
        if (snap.created.length) await tx.selectionItem.updateMany({ where: { id: { in: snap.created } }, data: { deletedAt: new Date() } });
        /**
         * Теги, заведённые связью с тегами проекта, — тоже часть действия, и
         * отмена снимает их. Но только те, на которые с тех пор никто не
         * сослался: тег, к которому уже привязали оборудование или файл,
         * живёт своей жизнью, и снять его молча — потерять чужую работу
         */
        for (const tagId of snap.createdTags || []) {
          const tag = await tx.tag.findUnique({
            where: { id: tagId },
            include: { componentElements: { select: { id: true } }, mainFiles: { select: { id: true } }, additionalFiles: { select: { id: true } } },
          });
          if (!tag) continue;
          const usedElsewhere = await tx.selectionItem.count({ where: { deletedAt: null, dataJson: { contains: tagId }, id: { notIn: snap.rows.map((r) => r.id) } } });
          if (tag.componentElements.length || tag.mainFiles.length || tag.additionalFiles.length || tag.equipmentId || usedElsewhere) { keptTags.push(tag.identifier); continue; }
          await tx.tag.delete({ where: { id: tagId } });
          removedTags++;
        }
        await tx.selectionBatch.update({ where: { id: batch.id }, data: { undone: true } });
      }, TX_LONG);
      broadcast('builder:list', { listId: batch.listId });
      res.json({ ok: true, listId: batch.listId, removedTags, keptTags });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Выпуски ──────────────────────────────────────────────────────────────

  app.get('/api/builder/lists/:id/issues', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const rows = await prisma.selectionIssue.findMany({ where: { listId: String(req.params.id) }, orderBy: { createdAt: 'asc' } });
      res.json({
        issues: rows.map((r: any) => ({
          id: r.id, rev: r.rev, date: r.date, reason: r.reason, prepared: r.prepared, checked: r.checked, approved: r.approved,
          diffText: r.diffText, fileId: r.fileId || null, createdAt: r.createdAt, snapshot: req.query.snapshots === '1' ? parse(r.snapshotJson, {}) : undefined,
        })),
      });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Записать выпуск: снимок позиций, ушедших заводу, и отметка «выпущено» у
   * позиций. По снимку следующий выпуск считает «что изменилось».
   */
  app.post('/api/builder/lists/:id/issues', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const list = await listOr404(prisma, String(req.params.id), res);
      if (!list) return;
      const b = (req.body || {}) as any;
      const rev = String(b.rev || '').trim();
      if (!rev) return res.status(400).json({ error: 'Не указан номер ревизии' });
      const already = `Ревизия ${rev} уже выпущена — выберите следующий номер`;
      const dup = await prisma.selectionIssue.findFirst({ where: { listId: list.id, rev } });
      if (dup) return res.status(409).json({ error: already });
      const items = await prisma.selectionItem.findMany({ where: { listId: list.id, deletedAt: null } });
      let row: any;
      try {
        row = await prisma.selectionIssue.create({
          data: {
            listId: list.id, projectId: list.projectId, rev, date: String(b.date || ''), reason: String(b.reason || ''),
            prepared: String(b.prepared || ''), checked: String(b.checked || ''), approved: String(b.approved || ''),
            // В снимке всё, из чего бланк собирался: номера б/з, шаблон и язык.
            // Без них «скачать ещё раз» собирал бы прошлый выпуск с сегодняшними
            // номерами и получал не тот файл, что ушёл заводу
            snapshotJson: JSON.stringify({
              items: items.map(toItem), header: parse(list.headerJson, {}),
              orderNos: parse(list.orderNosJson, {}), templateId: list.templateId || null, lang: list.lang || 'ru',
            }),
            diffText: String(b.diffText || ''), fileId: b.fileId || null, createdById: me(req)?.id || null,
          },
        });
      } catch (e: any) {
        // Второе нажатие успело между проверкой и записью — индекс не дал задвоить
        if (e?.code === 'P2002' || /unique|duplicate/i.test(String(e?.message))) return res.status(409).json({ error: already });
        throw e;
      }
      await prisma.selectionItem.updateMany({ where: { listId: list.id, deletedAt: null }, data: { status: 'issued' } });
      broadcast('builder:list', { listId: list.id });
      res.json({ issue: { id: row.id, rev: row.rev } });
    } catch (err: any) { sendError(res, err); }
  });

  // ── Теги проекта ─────────────────────────────────────────────────────────

  /**
   * План связей с тегами проекта: что привязать, что завести, что неоднозначно.
   * Ничего не пишет — тот же planTagLinks, что у импорта оборудования, с
   * правилами тегов проекта.
   */
  app.post('/api/builder/lists/:id/tag-plan', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const list = await listOr404(prisma, String(req.params.id), res);
      if (!list) return;
      const items = (await prisma.selectionItem.findMany({ where: { listId: list.id, deletedAt: null } })).map(toItem);
      const extra: Record<string, string[]> = (req.body || {}).extraTags || {};
      const blocks = items.map((it: any) => ({ key: it.id, tags: [...(it.tags || []), ...(extra[it.id] || [])] }));
      const existing = await prisma.tag.findMany({ where: { projectId: list.projectId }, select: { id: true, identifier: true } });
      const policy = await importPolicyOfProject(list.projectId);
      res.json({ links: planTagLinks(blocks, existing, policy) });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Применить решения по тегам. Новый тег заводится с маркой — обозначением
   * позиции, чтобы в «Тегах» было видно, какой клапан за ним стоит. Марку уже
   * существующего тега не трогаем: её мог поставить другой раздел.
   */
  app.post('/api/builder/lists/:id/tag-apply', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      await ensure(prisma);
      const list = await listOr404(prisma, String(req.params.id), res);
      if (!list) return;
      const links: TagLink[] = Array.isArray((req.body || {}).links) ? req.body.links : [];
      const items = new Map<string, any>((await prisma.selectionItem.findMany({ where: { listId: list.id, deletedAt: null } })).map((r: any) => [r.id, r]));
      const policy = await importPolicyOfProject(list.projectId);
      const before: any[] = [];
      const byItem = new Map<string, Record<string, string>>();
      const createdTags: string[] = [];
      const refused: string[] = [];
      let batchId = '';
      let linked = 0;
      await prisma.$transaction(async (tx: any) => {
        for (const l of links) {
          const row = items.get(l.blockKey);
          if (!row || (l.action !== 'link' && l.action !== 'create' && l.action !== 'ambiguous')) continue;
          /**
           * План строился в окне, а запрос мог прийти мимо него, и правила
           * тегов проекта с тех пор могли поменять. Поэтому здесь всё то же,
           * что в applyTagLinks импорта оборудования: правило проверяется ещё
           * раз, неоднозначное без выбора не пишется, чужой тег не берётся
           */
          const check = validateTag(l.identifier, policy);
          if (!check.ok) { refused.push(`«${l.identifier}»: ${check.problem}`); continue; }
          let tagId = '';
          if (l.existingTagId) {
            const own = await tx.tag.findFirst({ where: { id: String(l.existingTagId), projectId: list.projectId } });
            if (!own) { refused.push(`«${l.identifier}»: тег не из этого проекта`); continue; }
            tagId = own.id;
            linked++;
          } else if (l.action === 'create') {
            const dup = await tx.tag.findFirst({ where: { projectId: list.projectId, identifier: l.identifier } });
            const brand = parse<any>(row.dataJson, {}).designation || null;
            if (dup) { tagId = dup.id; linked++; }
            else { tagId = (await tx.tag.create({ data: { projectId: list.projectId, identifier: l.identifier, brand } })).id; createdTags.push(tagId); }
          } else {
            refused.push(`«${l.identifier}» совпадает с несколькими тегами проекта — выберите нужный`);
            continue;
          }
          byItem.set(row.id, { ...(byItem.get(row.id) || {}), [l.identifier]: tagId });
        }
        for (const [itemId, map] of byItem) {
          const row = items.get(itemId);
          before.push(row);
          const d = parse<any>(row.dataJson, {});
          d.tagIds = { ...(d.tagIds || {}), ...map };
          await tx.selectionItem.update({ where: { id: itemId }, data: { dataJson: JSON.stringify(d) } });
        }
        // Заведённые теги — в том же пакете: «Отменить» снимет и их (см. undo)
        if (before.length || createdTags.length) {
          batchId = (await tx.selectionBatch.create({ data: { listId: list.id, projectId: list.projectId, title: 'Связь с тегами проекта', beforeJson: JSON.stringify({ rows: before, created: [], createdTags }), createdById: me(req)?.id || null } })).id;
        }
      }, TX_LONG);
      broadcast('builder:list', { listId: list.id });
      res.json({ created: createdTags.length, linked, refused, batchId: batchId || null });
    } catch (err: any) { sendError(res, err); }
  });
}

/**
 * Удалить всё Конструктора по проекту. Вызывается из удаления проекта: без
 * этого ведомости, выпуски и пакеты оставались в базе без хозяина.
 */
export async function forgetProjectSelections(projectId: string): Promise<void> {
  const prisma = getPrisma();
  try {
    await ensure(prisma);
    await prisma.$transaction([
      prisma.selectionBatch.deleteMany({ where: { projectId } }),
      prisma.selectionIssue.deleteMany({ where: { projectId } }),
      prisma.selectionItem.deleteMany({ where: { projectId } }),
      prisma.selectionList.deleteMany({ where: { projectId } }),
    ]);
  } catch (e: any) {
    console.warn('[builder] ведомости удалённого проекта не убраны:', e?.message || e);
  }
}
