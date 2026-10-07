/**
 * Безопасная запись в тег: слияние metadata и сверка версии.
 *
 * Дефект, ради которого модуль заведён. `PUT /api/tags/:id` заменял metadata
 * целиком тем, что прислал экран. «Закупки» сохраняли по копии тега, прочитанной
 * при открытии экрана, поэтому комментарий, который коллега добавил в «Тегах» за
 * это время, молча стирался при смене этапа закупки; обратное тоже. Тихо
 * испорченные данные здесь дороже отказа (skill flux-data-safety), поэтому:
 *
 *  1. присланные верхние ключи metadata СЛИВАЮТСЯ с текущими данными тега, а не
 *     заменяют их: чужие ключи остаются. Ключ, присланный как `null`, удаляется —
 *     иначе удалить ключ (снять родителя) стало бы нечем: пропущенный ключ теперь
 *     означает «не трогать», а не «стереть»;
 *  2. если клиент прислал версию (updatedAt тега, как он её читал) и тег с тех пор
 *     менялся, запись не проходит: ответ — конфликт с текущим тегом, экран
 *     перечитывает и говорит человеку. Клиенты без версии продолжают работать,
 *     их защищает слияние;
 *  3. чтение и запись — одна транзакция, а запись условна по updatedAt: два
 *     запроса, пришедшие одновременно, не затрут друг друга (PostgreSQL по
 *     умолчанию читает «как было» и без этого терял бы ключи одного из них).
 *
 * Перенос карточки по холсту (x, y) версией не сверяется и саму версию не
 * меняет: положение никому не дорого, а иначе каждое перетаскивание давало бы
 * коллеге ложный конфликт. По той же причине он не считается правкой в истории.
 */

import { parseMetadata } from './tagHistory.js';

export type MetadataPatch = Record<string, unknown>;

/** Поля тега, которые правятся отдельно от metadata. Не переданное — не трогается. */
export interface TagFieldsPatch {
  identifier?: string;
  department?: string | null;
  wbs?: string | null;
  fluid?: string | null;
  equipmentId?: string | null;
  brand?: string | null;
}

export interface TagWriteInput {
  fields?: TagFieldsPatch;
  /** Верхние ключи metadata; `null` — удалить ключ */
  metadata?: MetadataPatch;
  /** Какие ключи metadata вообще разрешено менять этому запросу («Закупки» — только procurement) */
  onlyKeys?: string[];
  /** updatedAt тега, как его прочитал клиент: ISO-строка, `null` — «тег ни разу не правился» */
  version?: string | null;
}

export class TagNotFound extends Error { constructor() { super('Тег не найден'); } }
export class TagConflict extends Error {
  constructor(public readonly tag: any) { super('Тег изменился с тех пор, как вы его читали'); }
}
export class TagBadRequest extends Error {}

/** Положение карточки: его правка версию не сверяет и тег «изменённым» не делает. */
const LAYOUT_KEYS = new Set(['x', 'y', '_noPos']);
/** Клиентский мусор, который в базу не попадает ни при каких обстоятельствах. */
const NEVER_STORED = new Set(['parsedMetadata', '_noPos', '__proto__', 'constructor', 'prototype']);
const FIELD_NAMES = ['identifier', 'department', 'wbs', 'fluid', 'equipmentId', 'brand'] as const;
const MAX_ATTEMPTS = 3;

/** metadata из тела запроса: объект или строка с JSON-объектом. */
export function metadataPatchOf(raw: unknown): MetadataPatch | undefined {
  if (raw === undefined) return undefined;
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { throw new TagBadRequest('metadata: не JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TagBadRequest('metadata должен быть объектом');
  return value as MetadataPatch;
}

/** Слить присланные ключи с текущими. Возвращает новый объект и список изменившихся ключей. */
export function mergeMetadata(current: Record<string, any>, patch: MetadataPatch, onlyKeys?: string[]): { merged: Record<string, any>; changed: string[] } {
  const merged: Record<string, any> = { ...current };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (NEVER_STORED.has(key)) continue;
    if (onlyKeys && !onlyKeys.includes(key)) continue;
    const had = Object.prototype.hasOwnProperty.call(merged, key);
    if (value === null) {
      if (!had) continue;
      delete merged[key];
      changed.push(key);
      continue;
    }
    if (had && JSON.stringify(merged[key]) === JSON.stringify(value)) continue;
    merged[key] = value;
    changed.push(key);
  }
  return { merged, changed };
}

const timeOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return Number.isNaN(t) ? NaN : t;
};

/** Версия клиента совпадает с текущей. Незнакомая или нечитаемая — не совпадает. */
export function sameVersion(version: unknown, updatedAt: unknown): boolean {
  const a = timeOf(version);
  const b = timeOf(updatedAt);
  return !(Number.isNaN(a as number) || Number.isNaN(b as number)) && a === b;
}

export interface TagWriteResult {
  /** Тег до записи — для истории */
  before: any;
  /** Тег после записи (или тот же, если менять было нечего) */
  tag: any;
  /** Менять было нечего: ни одного поля, ни одного ключа */
  unchanged: boolean;
}

/** Одна попытка записи внутри уже открытой транзакции; 'retry' — тег успели изменить между чтением и записью. */
async function attemptWrite(tx: any, id: string, input: TagWriteInput): Promise<TagWriteResult | 'retry'> {
  const cur = await tx.tag.findUnique({ where: { id } });
  if (!cur) throw new TagNotFound();

  const data: Record<string, unknown> = {};
  let fieldsChanged = false;
  for (const f of FIELD_NAMES) {
    const v = input.fields?.[f];
    if (v === undefined) continue;
    // Пустое значение необязательного поля — это null, как и прежде; код тега пустым не обнуляется
    const next = f === 'identifier' ? v : (v || null);
    if (next !== (cur[f] ?? null)) { data[f] = next; fieldsChanged = true; }
  }

  let changedKeys: string[] = [];
  if (input.metadata !== undefined) {
    const { merged, changed } = mergeMetadata(parseMetadata(cur.metadata), input.metadata, input.onlyKeys);
    changedKeys = changed;
    if (changed.length) data.metadata = JSON.stringify(merged);
  }

  if (!fieldsChanged && !changedKeys.length) return { before: cur, tag: cur, unchanged: true };

  // Сверка версии: тег менялся с тех пор, как клиент его прочитал, и эта
  // правка касается не только положения карточки
  const stale = input.version !== undefined && !sameVersion(input.version, cur.updatedAt);
  if (stale && (fieldsChanged || changedKeys.some((k) => !LAYOUT_KEYS.has(k)))) throw new TagConflict(cur);

  // Перенос карточки — не правка данных тега: версия при нём не меняется.
  // Иначе каждое перетаскивание отбирало бы версию у всех, кто держит тег открытым,
  // и у самого автора переноса (массовая раскладка версий обратно не отдаёт)
  if (!fieldsChanged && changedKeys.every((k) => LAYOUT_KEYS.has(k))) data.updatedAt = cur.updatedAt ?? null;

  // Условная запись: если между чтением и записью тег успели изменить, не пишем
  // поверх, а читаем заново и сливаем ещё раз
  // update, а не updateMany: только он принимает заданную руками updatedAt (updateMany
  // выставляет её сам), а переносу карточки версию менять нельзя. «Не нашлось» (P2025)
  // — это и есть «успели изменить»
  try {
    const tag = await tx.tag.update({ where: { id, updatedAt: cur.updatedAt ?? null }, data });
    return { before: cur, tag, unchanged: false };
  } catch (e: any) {
    if (e?.code === 'P2025') return 'retry';
    throw e;
  }
}

async function writeInTx(tx: any, id: string, input: TagWriteInput): Promise<TagWriteResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptWrite(tx, id, input);
    if (outcome !== 'retry') return outcome;
  }
  // Тег меняют так часто, что записать не удалось: честный конфликт лучше тихой потери
  throw new TagConflict(await tx.tag.findUnique({ where: { id } }));
}

/**
 * Записать правку в одном теге: слияние, сверка версии, условное обновление.
 * Бросает TagNotFound, TagConflict, TagBadRequest.
 */
export const writeTag = (prisma: any, id: string, input: TagWriteInput): Promise<TagWriteResult> =>
  prisma.$transaction((tx: any) => writeInTx(tx, id, input), { timeout: 15000 });

/**
 * Массовая запись: все теги одной транзакцией, как и было, — либо всё, либо
 * ничего. Несуществующие теги пропускаются и возвращаются списком `missing`.
 */
export async function writeTags(prisma: any, items: Array<{ id: string; input: TagWriteInput }>): Promise<{ results: TagWriteResult[]; missing: string[] }> {
  return prisma.$transaction(async (tx: any) => {
    const results: TagWriteResult[] = [];
    const missing: string[] = [];
    for (const { id, input } of items) {
      try { results.push(await writeInTx(tx, id, input)); } catch (e) {
        if (e instanceof TagNotFound) missing.push(id); else throw e;
      }
    }
    return { results, missing };
  }, { timeout: 120000, maxWait: 15000 });
}

/** Ошибка записи → ответ HTTP; null — это не наша ошибка. */
export function tagWriteFailure(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof TagNotFound) return { status: 404, body: { error: err.message } };
  if (err instanceof TagBadRequest) return { status: 400, body: { error: err.message } };
  // В ответе — текущий тег: экран заменяет им свою копию и просит повторить правку
  if (err instanceof TagConflict) return { status: 409, body: { error: err.message, conflict: true, tag: err.tag } };
  return null;
}
