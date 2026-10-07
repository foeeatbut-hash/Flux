/**
 * Справочник атрибутов E3.series в каталоге (docs/e3-integration.md, 5.5, 5.7).
 *
 * Весь справочник — одна настройка каталога (`e3_attributes`): записей
 * полторы сотни, правят его редко и целиком, отдельная таблица тут только
 * добавила бы миграцию. Защита от гонок та же, что у черновиков каталога:
 * версия книги (клиент называет, какую видел) и запись «по старому значению»
 * (пока читали, коллега мог записать своё). Каждая запись оставляет снимок
 * «до» в CatalogRevision — по нему откат возвращает книгу целиком.
 *
 * Загрузка файла двухшаговая (flux-data-safety): `plan` ничего не пишет,
 * `apply` пишет одной партией. Разбор самого файла — в окне
 * (e3/attributes.parseAttributeSheet); сюда приходят уже разобранные записи
 * и проверяются как чужой ввод.
 */
import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import { catalogAllowed, catalogFailure, catalogSetting, catalogSettingRaw, claimCatalogSetting } from '../catalogWorkspace.js';
import { ensureCatalog } from './catalog.js';
import {
  applyAttributePlan, planAttributes, sanitizeClasses, sanitizeSource, validateAttributes, E3_CONFLICTS,
  type E3Attribute, type E3AttributeBook,
} from '../../e3/attributes.js';

const KEY = 'e3_attributes';
const ENTITY = 'e3attributes';
const ENTITY_ID = 'book';
const CONFLICT = 'Справочник атрибутов изменён коллегой. Обновите';
const emptyBook = (): E3AttributeBook => ({ version: 0, items: [], updatedAt: '' });
const actor = (req: Request) => (req as any).authUser;

/** Что можно поправить в одном атрибуте руками (остальное приходит из файла) */
const PATCH_KEYS = ['fromFlux', 'source', 'classes', 'conflict', 'title'];

type Loaded = { book: E3AttributeBook; raw: string | null };
type Action = 'import' | 'update' | 'restore';

async function load(db: any): Promise<Loaded> {
  const raw = await catalogSettingRaw(db, KEY);
  return { raw, book: raw ? JSON.parse(raw) : emptyBook() };
}

/** Версию называет клиент: ту, что он видел. Чужая — 409, а не тихая перезапись */
function checkVersion(expected: unknown, book: E3AttributeBook): void {
  if (!Number.isInteger(expected)) catalogFailure(400, 'Не указана версия справочника атрибутов');
  if (expected !== book.version) catalogFailure(409, CONFLICT);
}

/**
 * Записать новую книгу и снимок «до» одной транзакцией: снимок без записи
 * или запись без снимка — это откат, которого нельзя доверять.
 */
async function write(db: any, user: any, before: Loaded, items: E3Attribute[], action: Action): Promise<{ book: E3AttributeBook; revisionId: string }> {
  const book: E3AttributeBook = { version: before.book.version + 1, items, updatedAt: new Date().toISOString(), updatedById: user.id };
  const revisionId = await db.$transaction(async (tx: any) => {
    await claimCatalogSetting(tx, KEY, before.raw, book, CONFLICT);
    const rev = await tx.catalogRevision.create({ data: { entity: ENTITY, entityId: ENTITY_ID, action, snapshotJson: JSON.stringify(before.book), userId: user.id } });
    return rev.id as string;
  });
  return { book, revisionId };
}

/** Входные записи из файла: проверенные, без пометок «правили» и «снят» — это знает только справочник */
function incomingItems(raw: unknown): E3Attribute[] {
  const checked = validateAttributes(raw);
  if ('error' in checked) return catalogFailure(400, checked.error);
  return checked.items.map(({ edited: _e, removed: _r, ...a }) => a);
}

function checkPatch(raw: any): Partial<E3Attribute> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return catalogFailure(400, 'Не указано, что менять');
  const keys = Object.keys(raw);
  if (!keys.length) return catalogFailure(400, 'Не указано, что менять');
  const bad = keys.find((k) => !PATCH_KEYS.includes(k));
  if (bad) return catalogFailure(400, `Поле «${bad}» здесь менять нельзя`);
  const patch: Partial<E3Attribute> = {};
  if ('fromFlux' in raw) {
    if (typeof raw.fromFlux !== 'boolean') catalogFailure(400, 'Поле «Заполняет Flux» — да или нет');
    patch.fromFlux = raw.fromFlux;
  }
  if ('title' in raw) {
    if (typeof raw.title !== 'string' || raw.title.length > 500) catalogFailure(400, 'Подпись атрибута — строка не длиннее 500 знаков');
    patch.title = raw.title;
  }
  if ('source' in raw) {
    const source = sanitizeSource(raw.source);
    if (!source) catalogFailure(400, 'Источник значения не распознан');
    patch.source = source!;
  }
  if ('classes' in raw) {
    const classes = sanitizeClasses(raw.classes);
    if (!classes) catalogFailure(400, 'Неизвестный тип оборудования');
    patch.classes = classes!;
  }
  if ('conflict' in raw) {
    if (!E3_CONFLICTS.includes(raw.conflict)) catalogFailure(400, 'Неизвестное правило спора со скриптом');
    patch.conflict = raw.conflict;
  }
  return patch;
}

/** `ensure` подменяется только в проверке: у неё нет настоящей базы, чтобы создавать таблицы каталога */
export function registerE3AttributeRoutes(app: Express, can: (user: any, feature: string) => boolean, deps: { ensure?: (db: any) => Promise<void> } = {}): void {
  const ensure = deps.ensure || ensureCatalog;
  const handle = (right: 'read' | 'import' | 'edit', fn: (req: Request, res: Response, db: any, user: any) => Promise<any>) => async (req: Request, res: Response) => {
    try {
      const user = actor(req);
      if (!user?.id) return res.status(401).json({ error: 'Нужно войти в программу' });
      const db = getPrisma();
      await ensure(db);
      if (right !== 'read' && !(await catalogAllowed(db, user, right, {}, can))) {
        return res.status(403).json({ error: right === 'import' ? 'Нет права загружать справочники каталога' : 'Нет права править справочник атрибутов' });
      }
      await fn(req, res, db, user);
    } catch (e: any) { sendError(res, e, e?.status || (e?.code === 'P2002' ? 409 : 500)); }
  };

  app.get('/api/catalog/e3-attributes', handle('read', async (_req, res, db) => {
    res.json(await catalogSetting(db, KEY, emptyBook()) as E3AttributeBook);
  }));

  app.post('/api/catalog/e3-attributes/plan', handle('import', async (req, res, db) => {
    const { book } = await load(db);
    res.json(planAttributes(book.items, incomingItems(req.body?.items)));
  }));

  app.post('/api/catalog/e3-attributes/apply', handle('import', async (req, res, db, user) => {
    const missing = req.body?.missing === undefined ? 'keep' : req.body.missing;
    if (missing !== 'keep' && missing !== 'remove') catalogFailure(400, 'Для атрибутов, которых нет в файле, выберите «оставить» или «снять»');
    const incoming = incomingItems(req.body?.items);
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book);
    res.json(await write(db, user, before, applyAttributePlan(before.book.items, incoming, { missing }), 'import'));
  }));

  app.put('/api/catalog/e3-attributes/item', handle('edit', async (req, res, db, user) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) catalogFailure(400, 'Не указано имя атрибута');
    const patch = checkPatch(req.body?.patch);
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book);
    if (!before.book.items.some((a) => a.name === name)) catalogFailure(404, `Атрибута «${name}» нет в справочнике`);
    // От перезаписи файлом закрывает только правка полей из файла (подпись,
    // «Да»). Источник, типы и правило спора файл не трогает вовсе, и если
    // считать их правкой, после настройки сотни источников повторная загрузка
    // файла перестала бы обновлять описания у всех настроенных атрибутов
    const touchesFile = patch.title !== undefined || patch.fromFlux !== undefined;
    const items = before.book.items.map((a) => (a.name === name ? { ...a, ...patch, ...(touchesFile ? { edited: true } : {}) } : a));
    const { book } = await write(db, user, before, items, 'update');
    res.json({ book });
  }));

  app.get('/api/catalog/e3-attributes/revisions', handle('read', async (_req, res, db) => {
    const rows = await db.catalogRevision.findMany({ where: { entity: ENTITY, entityId: ENTITY_ID }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json(rows.map((r: any) => {
      let count = 0;
      try { count = (JSON.parse(r.snapshotJson)?.items || []).length; } catch (_) { /* снимок повреждён — число неизвестно */ }
      return { id: r.id, action: r.action, createdAt: r.createdAt, userId: r.userId, count };
    }));
  }));

  app.post('/api/catalog/e3-attributes/undo', handle('import', async (req, res, db, user) => {
    const id = typeof req.body?.revisionId === 'string' ? req.body.revisionId : '';
    if (!id) catalogFailure(400, 'Не указана запись истории');
    const rev = await db.catalogRevision.findFirst({ where: { id, entity: ENTITY, entityId: ENTITY_ID } });
    if (!rev) catalogFailure(404, 'Записи истории нет');
    const before = await load(db);
    checkVersion(req.body?.expectedVersion, before.book);
    let snapshot: any;
    try { snapshot = JSON.parse(rev.snapshotJson); } catch (_) { snapshot = null; }
    if (!snapshot || !Array.isArray(snapshot.items)) catalogFailure(409, 'Снимок записи истории повреждён — откатить нельзя');
    // Версия растёт и при откате: клиент с открытым экраном должен увидеть, что книга менялась
    const { book } = await write(db, user, before, snapshot.items, 'restore');
    res.json({ book });
  }));
}
