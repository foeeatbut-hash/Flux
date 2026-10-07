/**
 * История изменений тега: запись «было → стало» и чтение.
 *
 * Зачем. Журнал действий (`actionLog.ts`) помнит только «кто дёрнул маршрут»,
 * без тега и без значений: понять по нему, кто стёр комментарий и каким он был,
 * нельзя. Здесь пишется то, что изменилось в самом теге, на каждом пути,
 * который его меняет, — и кто это сделал, и откуда (экран «Теги», «Закупки»,
 * импорт оборудования, захват).
 *
 * Принципы.
 *  - Только дописывается. Ни правки, ни удаления записей здесь нет, и удалённый
 *    тег историю сохраняет (таблица не связана с Tag, см. tagChangeTable.ts).
 *  - Пустая правка записи не оставляет: сравнивается содержимое, а не факт
 *    запроса. Раскладка карточек (x, y) и служебные пометки правкой не считаются.
 *  - Запись идёт ПОСЛЕ изменения тега и ошибкой его не откатывает: тег важнее
 *    своего журнала, а внутри транзакции PostgreSQL один сбой записи журнала
 *    сорвал бы и саму правку. Сбой не молчит — он пишется в журнал сервера.
 *  - Автор — только из сессии запроса (`authUser`), никогда из тела: идентификатор
 *    коллеги виден всем, и подписать правку чужим именем было бы тривиально.
 *
 * Запросы — сырым SQL, а не делегатом Prisma: таблицу заводит ещё и общий слой
 * `ddl.ts` (в базе, куда клиент пересоздан раньше, чем база обновлена, модели в
 * клиенте может ещё не быть), и история не должна зависеть от того, успели ли
 * пересобрать клиент.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getDialect, type Dialect } from './ddl.js';
import { clientDialect } from './schemaRuntime.js';
import { ensureTagChangeTable } from './tagChangeTable.js';

/** Откуда пришла правка. Закрытый список: по нему строится фильтр в паспорте тега. */
export const TAG_SOURCE = {
  tags: 'Теги',
  procurement: 'Закупки',
  tagImport: 'импорт тегов',
  equipmentImport: 'импорт оборудования',
  equipmentEdit: 'правка оборудования',
  capture: 'захват',
  restore: 'восстановление',
  builder: 'Конструктор',
} as const;
export type TagSource = typeof TAG_SOURCE[keyof typeof TAG_SOURCE];

export const TAG_CHANGE_KIND = {
  created: 'создан',
  changed: 'изменён',
  deleted: 'удалён',
  linkAdded: 'связь добавлена',
  linkRemoved: 'связь убрана',
  commentAdded: 'комментарий добавлен',
  commentChanged: 'комментарий изменён',
  commentDeleted: 'комментарий удалён',
} as const;
export type TagChangeKind = typeof TAG_CHANGE_KIND[keyof typeof TAG_CHANGE_KIND];

/** Подписи полей для человека; неизвестное поле показывается как есть. */
export const TAG_FIELD_LABEL: Record<string, string> = {
  identifier: 'Код',
  brand: 'Марка',
  department: 'Отдел',
  wbs: 'WBS',
  fluid: 'Среда',
  equipmentId: 'Оборудование',
  mainName: 'Наименование',
  actuality: 'Актуальность',
  descriptions: 'Комментарии',
  parentId: 'Родитель',
  connections: 'Состав',
  dynamicFields: 'Поля карточки',
  procurement: 'Закупка',
  'procurement.stage': 'Закупка: этап',
  'procurement.supplier': 'Закупка: поставщик',
  'procurement.qty': 'Закупка: количество',
  'procurement.note': 'Закупка: примечание',
  'procurement.templateId': 'Закупка: шаблон этапов',
};

export function tagFieldLabel(field: string): string {
  if (TAG_FIELD_LABEL[field]) return TAG_FIELD_LABEL[field];
  const stage = /^procurement\.stageLog\.(.+)$/.exec(field);
  if (stage) return `Закупка: отметка этапа «${stage[1]}»`;
  const dyn = /^dynamicFields\.(.+)$/.exec(field);
  if (dyn) return dyn[1];
  return field;
}

export interface TagChangeEntry {
  kind: TagChangeKind;
  field: string;
  before: string | null;
  after: string | null;
  /** Значения — идентификаторы тегов (связи): перед записью заменяются кодами. */
  link?: boolean;
}

export interface TagChangeContext {
  projectId: string;
  userId?: string | null;
  source: TagSource;
}

/** Срез тега, достаточный для сравнения. */
export interface TagSnapshot {
  id: string;
  /** Проект тега: у операции над несколькими тегами он может быть не один */
  projectId?: string;
  identifier?: string | null;
  brand?: string | null;
  department?: string | null;
  wbs?: string | null;
  fluid?: string | null;
  equipmentId?: string | null;
  metadata?: unknown;
}

const SCALAR_FIELDS = ['identifier', 'brand', 'department', 'wbs', 'fluid', 'equipmentId'] as const;

/**
 * Ключи metadata, которые правкой тега не считаются: положение карточки на
 * холсте и служебные пометки, которые экран переписывает при каждом сохранении.
 * Иначе каждое перетаскивание карточки оставляло бы запись «изменён x».
 * `parentBy` — отметка «поставил импорт / рука», производная от родителя;
 * сегменты кода — производные от самого кода.
 */
const SERVICE_KEYS = new Set(['x', 'y', '_noPos', 'parsedMetadata', 'updatedAt', 'updatedBy', 'parentBy', 'tagSegments', 'markSegments']);

const STATUS_LABEL: Record<string, string> = {
  actual: 'Актуально', warning: 'Проверить', critical: 'Критично', info: 'В работе', draft: 'Устарело',
};

/** Потолок длины значения «было/стало»: комментарий длинным бывает, но не мегабайтным. */
const MAX_VALUE = 4000;

export function parseMetadata(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

const isPlain = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Значение в текст для «было/стало»; пустое — null, чтобы «не было» отличалось от «было пустым». */
function text(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v.slice(0, MAX_VALUE);
  // Отметка этапа закупки {at, by} читается человеком как «кто, когда»
  if (isPlain(v) && Object.keys(v).every((k) => k === 'at' || k === 'by')) return [v.by, v.at].filter(Boolean).join(', ') || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const json = JSON.stringify(v);
  return json === '[]' || json === '{}' ? null : json.slice(0, MAX_VALUE);
}

function describeComment(d: any): string | null {
  const head = [d?.text, d?.comment].map((s) => String(s ?? '').trim()).filter(Boolean).join(' — ');
  const status = STATUS_LABEL[String(d?.status || '')];
  const full = status ? `${head} [${status}]` : head;
  return full ? full.slice(0, MAX_VALUE) : null;
}

/** Комментарии сравниваются по элементам: добавлен, изменён, удалён — каждый своей записью. */
function diffComments(was: unknown, now: unknown, out: TagChangeEntry[]): void {
  const key = (d: any, i: number) => String(d?.id ?? `#${i}`);
  const list = (v: unknown) => new Map((Array.isArray(v) ? v : []).map((d: any, i: number) => [key(d, i), d]));
  const a = list(was);
  const b = list(now);
  for (const [id, d] of b) {
    if (!a.has(id)) { out.push({ kind: TAG_CHANGE_KIND.commentAdded, field: 'descriptions', before: null, after: describeComment(d) }); continue; }
    const prev = describeComment(a.get(id));
    const next = describeComment(d);
    if (prev !== next) out.push({ kind: TAG_CHANGE_KIND.commentChanged, field: 'descriptions', before: prev, after: next });
  }
  for (const [id, d] of a) {
    if (!b.has(id)) out.push({ kind: TAG_CHANGE_KIND.commentDeleted, field: 'descriptions', before: describeComment(d), after: null });
  }
}

/** Связи: добавленные и убранные идентификаторы — каждый своей записью. */
function diffLinks(field: 'parentId' | 'connections', was: unknown, now: unknown, out: TagChangeEntry[]): void {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v : (v ? [v] : [])).map(String).filter(Boolean);
  const a = new Set(ids(was));
  const b = new Set(ids(now));
  for (const id of a) if (!b.has(id)) out.push({ kind: TAG_CHANGE_KIND.linkRemoved, field, before: id, after: null, link: true });
  for (const id of b) if (!a.has(id)) out.push({ kind: TAG_CHANGE_KIND.linkAdded, field, before: null, after: id, link: true });
}

/**
 * Прочие ключи: объекты (закупка, поля карточки) разбираются по подключам — «этап
 * закупки изменён» полезнее, чем «закупка изменена» с кашей из JSON, — но не глубже
 * двух уровней: отметки этапов лежат как procurement.stageLog.<этап>.
 */
function diffValue(path: string, was: unknown, now: unknown, depth: number, out: TagChangeEntry[]): void {
  if (isPlain(was) || isPlain(now)) {
    const a = isPlain(was) ? was : {};
    const b = isPlain(now) ? now : {};
    const atBy = (o: Record<string, any>) => Object.keys(o).length > 0 && Object.keys(o).every((k) => k === 'at' || k === 'by');
    if (depth < 2 && !atBy(a) && !atBy(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffValue(`${path}.${k}`, a[k], b[k], depth + 1, out);
      return;
    }
  }
  const before = text(was);
  const after = text(now);
  if (before !== after) out.push({ kind: TAG_CHANGE_KIND.changed, field: path, before, after });
}

export function diffMetadata(was: unknown, now: unknown): TagChangeEntry[] {
  const a = parseMetadata(was);
  const b = parseMetadata(now);
  const out: TagChangeEntry[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SERVICE_KEYS.has(key)) continue;
    if (key === 'descriptions') diffComments(a[key], b[key], out);
    else if (key === 'parentId' || key === 'connections') diffLinks(key, a[key], b[key], out);
    else diffValue(key, a[key], b[key], 0, out);
  }
  return out;
}

/** Что изменилось между двумя срезами тега: поля, затем metadata. Пусто — менять нечего. */
export function diffTag(before: TagSnapshot, after: TagSnapshot): TagChangeEntry[] {
  const out: TagChangeEntry[] = [];
  for (const f of SCALAR_FIELDS) {
    // Ключ не передан в «после» — поле не трогали; сравниваем только то, что пришло
    if (!(f in after)) continue;
    const was = text(before[f]);
    const now = text(after[f]);
    if (was !== now) out.push({ kind: TAG_CHANGE_KIND.changed, field: f, before: was, after: now });
  }
  if ('metadata' in after) out.push(...diffMetadata(before.metadata, after.metadata));
  return out;
}

// ── SQL под движок базы ────────────────────────────────────────────────────

const quote = (d: Dialect, id: string): string => (d === 'mysql' ? `\`${id}\`` : `"${id}"`);

function sqlFor(prisma: any, sql: string): { sql: string } {
  const dialect = clientDialect(prisma, getDialect());
  let n = 0;
  return { sql: dialect === 'postgresql' ? sql.replace(/\?/g, () => `$${++n}`) : sql };
}

const COLUMNS = ['id', 'tagId', 'projectId', 'at', 'userId', 'source', 'kind', 'field', 'before', 'after'] as const;
/** Строк за один INSERT: параметров 10 на строку, пределы движков — десятки тысяч */
const CHUNK = 100;

/** Клиент базы, у которого можно спросить SQL (не подставной объект из проверок). */
const isDb = (prisma: any): boolean => typeof prisma?.$executeRawUnsafe === 'function' && typeof prisma?.$queryRawUnsafe === 'function';

/** Прочитать коды тегов по идентификаторам; нет тега — остаётся идентификатор. */
async function codesOf(prisma: any, ids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!ids.length || typeof prisma?.tag?.findMany !== 'function') return found;
  try {
    const rows = await prisma.tag.findMany({ where: { id: { in: ids } }, select: { id: true, identifier: true } });
    for (const r of rows) found.set(String(r.id), String(r.identifier || r.id));
  } catch (_) { /* коды — украшение записи; без них останутся идентификаторы */ }
  return found;
}

/** Изменения одного тега: из таких наборов складывается запись целой операции. */
export interface TagChangeSet { tagId: string; projectId?: string; entries: TagChangeEntry[] }

/** Набор для правки тега; пусто, если менять было нечего. */
export function updateSet(before: TagSnapshot, after: TagSnapshot): TagChangeSet | null {
  const entries = diffTag(before, after);
  return entries.length ? { tagId: before.id, projectId: before.projectId, entries } : null;
}

export const createdSet = (tag: { id: string; projectId?: string; identifier?: string | null }): TagChangeSet =>
  ({ tagId: tag.id, projectId: tag.projectId, entries: [{ kind: TAG_CHANGE_KIND.created, field: 'identifier', before: null, after: text(tag.identifier) }] });

export const deletedSet = (tag: { id: string; projectId?: string; identifier?: string | null }): TagChangeSet =>
  ({ tagId: tag.id, projectId: tag.projectId, entries: [{ kind: TAG_CHANGE_KIND.deleted, field: 'identifier', before: text(tag.identifier), after: null }] });

/**
 * Записать наборы изменений одной операции. Возвращает число записанных строк;
 * не бросает. Строки одной операции получают время с шагом в миллисекунду:
 * порядок внутри неё стабилен, и при чтении «по времени» они не перемешиваются.
 */
export async function recordChangeSets(prisma: any, ctx: TagChangeContext, sets: Array<TagChangeSet | null | undefined>): Promise<number> {
  const live = sets.filter((s): s is TagChangeSet => !!s && s.entries.length > 0);
  if (!live.length) return 0;
  if (!isDb(prisma)) return 0;
  try {
    const why = await ensureTagChangeTable();
    if (why) throw new Error(why);
    // Связи пишутся кодами: по идентификатору человек не поймёт, кого с кем связали
    const linkIds = live.flatMap((s) => s.entries).filter((e) => e.link).flatMap((e) => [e.before, e.after]).filter((v): v is string => !!v);
    const codes = await codesOf(prisma, [...new Set(linkIds)]);
    const base = Date.now();
    let n = 0;
    const rows = live.flatMap((s) => s.entries.map((e) => [
      randomUUID(), s.tagId, s.projectId || ctx.projectId, new Date(base + n++), ctx.userId || null, ctx.source, e.kind, e.field,
      e.link && e.before ? (codes.get(e.before) || e.before) : e.before,
      e.link && e.after ? (codes.get(e.after) || e.after) : e.after,
    ]));
    const d = clientDialect(prisma, getDialect());
    const cols = COLUMNS.map((c) => quote(d, c)).join(', ');
    const one = `(${COLUMNS.map(() => '?').join(', ')})`;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const { sql } = sqlFor(prisma, `INSERT INTO ${quote(d, 'TagChange')} (${cols}) VALUES ${part.map(() => one).join(', ')}`);
      await prisma.$executeRawUnsafe(sql, ...part.flat());
    }
    return rows.length;
  } catch (e: any) {
    console.error('[История тегов] запись не удалась:', e?.message || e);
    return 0;
  }
}

/** Сравнить «до» и «после» одного тега и записать разницу; одинаковое не пишется. */
export const recordTagUpdate = (prisma: any, ctx: TagChangeContext, before: TagSnapshot, after: TagSnapshot): Promise<number> =>
  recordChangeSets(prisma, ctx, [updateSet(before, after)]);
export const recordTagCreated = (prisma: any, ctx: TagChangeContext, tag: { id: string; projectId?: string; identifier?: string | null }): Promise<number> =>
  recordChangeSets(prisma, ctx, [createdSet(tag)]);
export const recordTagDeleted = (prisma: any, ctx: TagChangeContext, tag: { id: string; projectId?: string; identifier?: string | null }): Promise<number> =>
  recordChangeSets(prisma, ctx, [deletedSet(tag)]);

/** Контекст записи из запроса: автор берётся из сессии. */
export function tagChangeContext(req: Request | undefined, projectId: string, source: TagSource): TagChangeContext {
  return { projectId, userId: String((req as any)?.authUser?.id || '') || null, source };
}

export interface TagChangeRow {
  id: string;
  tagId: string;
  projectId: string;
  at: string;
  userId: string | null;
  source: string;
  kind: string;
  field: string;
  before: string | null;
  after: string | null;
}

/** Время из базы в ISO: SQLite отдаёт строку или число, остальные — Date. */
function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  const s = String(v ?? '');
  // «2026-10-06 12:30:00» — это время SQLite CURRENT_TIMESTAMP, оно в UTC
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/**
 * История тега, новое сверху. Тег может быть уже удалён — история от этого не
 * пропадает, поэтому читается по идентификатору, а не через таблицу тегов.
 */
export async function readTagHistory(prisma: any, tagId: string, opts: { limit?: number } = {}): Promise<TagChangeRow[]> {
  if (!isDb(prisma)) return [];
  const why = await ensureTagChangeTable();
  if (why) throw new Error(why);
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(opts.limit) || 500)));
  const d = clientDialect(prisma, getDialect());
  const { sql } = sqlFor(prisma, `SELECT * FROM ${quote(d, 'TagChange')} WHERE ${quote(d, 'tagId')} = ? ORDER BY ${quote(d, 'at')} DESC, ${quote(d, 'id')} DESC LIMIT ${limit}`);
  const rows: any[] = await prisma.$queryRawUnsafe(sql, tagId);
  return rows.map((r) => ({
    id: String(r.id), tagId: String(r.tagId), projectId: String(r.projectId), at: isoOf(r.at),
    userId: r.userId ? String(r.userId) : null, source: String(r.source || ''), kind: String(r.kind || ''),
    field: String(r.field || ''), before: r.before ?? null, after: r.after ?? null,
  }));
}
