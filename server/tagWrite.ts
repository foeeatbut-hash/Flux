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
 *     менялся, запись не проходит: ответ — 409 общего вида (`code`, `current` —
 *     голая запись тега), экран сравнивает её с показанным и говорит человеку,
 *     что изменил коллега. Тега уже нет — 404 `RECORD_GONE`. Клиенты без версии
 *     продолжают работать, их защищает слияние;
 *  3. чтение и запись — одна транзакция, а запись условна по updatedAt: два
 *     запроса, пришедшие одновременно, не затрут друг друга (PostgreSQL по
 *     умолчанию читает «как было» и без этого терял бы ключи одного из них).
 *
 * Перенос карточки по холсту (x, y) версией не сверяется и саму версию не
 * меняет: положение никому не дорого, а иначе каждое перетаскивание давало бы
 * коллеге ложный конфликт. По той же причине он не считается правкой в истории.
 */

import { bumpElementsOfTags } from './equipmentVersion.js';
import { keepVersion } from './versionBump.js';
import { renameTagInVdr } from './vdrTags.js';
import { parseMetadata, inTagTransaction } from './tagHistory.js';
import { TagDuplicate, tagCodeKey, withCodeKey, duplicateOf, isCodeKeyViolation } from './tagCodeKey.js';
import { VersionConflict, RecordGone } from './versionGuard.js';
import { VERSION_CONFLICT, editChangedText, bulkChangedText } from '../src/lib/refusalTexts.js';

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

export class TagBadRequest extends Error {}
/**
 * Массовая запись по устаревшим данным: хоть одну запись изменили или удалили —
 * не записано ничего. Перечень по записям нужен экрану, чтобы показать, что
 * изменилось, и дать человеку подтвердить заново.
 */
export class TagBulkConflict extends Error {
  constructor(public readonly changed: Array<{ id: string; current: any }>, public readonly gone: string[]) {
    super(bulkChangedText());
    this.name = 'TagBulkConflict';
  }
}
/** Ключ кода и отказ «код занят» живут в tagCodeKey.ts; здесь — прежний адрес для остальных модулей. */
export { TagDuplicate, tagCodeKey };

/**
 * Код тега, пригодный к записи: не пустой и не занятый другим тегом проекта.
 * Прежний `PUT`/`POST` принимали и пустой код, и повтор — оба дефекта
 * находились двойным нажатием «Создать» и переименованием в код соседа.
 *
 * Это ранний понятный отказ, а не защита: между чтением и записью код успевает
 * занять другой запрос. Защита — ключ `Tag.codeKey` (см. tagCodeKey.ts).
 */
export async function assertFreeTagCode(db: any, projectId: string, identifier: unknown, exceptId?: string): Promise<string> {
  const code = String(identifier ?? '').trim();
  if (!code) throw new TagBadRequest('Код тега не может быть пустым');
  const key = tagCodeKey(code);
  const same = await db.tag.findMany({ where: { projectId }, select: { id: true, identifier: true } });
  const taken = same.find((t: any) => t.id !== exceptId && tagCodeKey(t.identifier) === key);
  if (taken) throw new TagDuplicate(code, { id: String(taken.id), identifier: String(taken.identifier) });
  return code;
}

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
  if (!cur) throw new RecordGone('tag');

  const data: Record<string, unknown> = {};
  let fieldsChanged = false;
  for (const f of FIELD_NAMES) {
    const v = input.fields?.[f];
    if (v === undefined) continue;
    // Пустое значение необязательного поля — это null, как и прежде; код тега пустым не обнуляется:
    // пустой код — ошибка запроса, а занятый — отказ, и менять тот же код с пробелами нечего
    let next: unknown;
    if (f === 'identifier') {
      const code = String(v ?? '').trim();
      if (code === String(cur.identifier ?? '').trim()) continue;
      next = await assertFreeTagCode(tx, cur.projectId, code, id);
    } else next = v || null;
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
  if (stale && (fieldsChanged || changedKeys.some((k) => !LAYOUT_KEYS.has(k)))) throw new VersionConflict(editChangedText('tag', cur.identifier), cur);

  // Перенос карточки — не правка данных тега: версия при нём не меняется.
  // Иначе каждое перетаскивание отбирало бы версию у всех, кто держит тег открытым,
  // и у самого автора переноса (массовая раскладка версий обратно не отдаёт)
  // Целая версия (server/versionBump.ts) тоже не растёт: по той же причине
  const layoutOnly = !fieldsChanged && changedKeys.every((k) => LAYOUT_KEYS.has(k));
  if (layoutOnly) data.updatedAt = cur.updatedAt ?? null;

  // Условная запись: если между чтением и записью тег успели изменить, не пишем
  // поверх, а читаем заново и сливаем ещё раз
  // update, а не updateMany: только он принимает заданную руками updatedAt (updateMany
  // выставляет её сам), а переносу карточки версию менять нельзя. «Не нашлось» (P2025)
  // — это и есть «успели изменить»
  try {
    // Код меняется — ключ меняется с ним: в базе нет пути, где identifier правится без codeKey
    const written = withCodeKey(data);
    const tag = await tx.tag.update({ where: { id, updatedAt: cur.updatedAt ?? null }, data: layoutOnly ? keepVersion(written) : written });
    // Код тега — часть позиции: изменился — версия позиции выросла
    if ('identifier' in data) {
      await bumpElementsOfTags(tx, [id]);
      // Связи строк ВДР идут по id тега и переименование переживают; обновляется копия кода для показа
      await renameTagInVdr(tx, id, String(cur.identifier ?? ''), String(data.identifier));
    }
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
  const fresh = await tx.tag.findUnique({ where: { id } });
  if (!fresh) throw new RecordGone('tag');
  throw new VersionConflict(editChangedText('tag', fresh.identifier), fresh);
}

/**
 * Записать правку в одном теге: слияние, сверка версии, условное обновление.
 * Бросает RecordGone (тега нет), VersionConflict (его изменили), TagBadRequest.
 */
export async function writeTag(
  prisma: any, id: string, input: TagWriteInput,
  /** Что записать в той же транзакции после правки (история тега): не записалось — не записался и тег */
  hooks: { record?: (tx: any, result: TagWriteResult) => Promise<void> } = {},
): Promise<TagWriteResult> {
  try {
    return await inTagTransaction(prisma, async (tx: any) => {
      const result = await writeInTx(tx, id, input);
      if (hooks.record) await hooks.record(tx, result);
      return result;
    }, { timeout: 15000 });
  } catch (e) {
    // Переименование проиграло гонку за код: проверка в attemptWrite его пропустила, остановил ключ
    if (isCodeKeyViolation(e)) {
      const own = await prisma.tag.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null);
      throw await duplicateOf(prisma, e, own?.projectId, input.fields?.identifier);
    }
    throw e;
  }
}

/**
 * Массовая запись: все теги одной транзакцией — либо всё, либо ничего.
 *
 * Каждая запись сверяется со своей версией (`input.version`, как у поштучной
 * правки; перенос карточек версию не сверяет). Хоть одну запись изменили или
 * удалили, пока человек смотрел, — откатывается вся транзакция, и отказ
 * (`TagBulkConflict`) называет ВСЕ такие записи, а не первую: экран показывает
 * перечень и просит подтвердить заново. Прежнее «несуществующие пропускаются»
 * молча теряло правку, поэтому удалённый тег теперь — отказ.
 */
export async function writeTags(
  prisma: any, items: Array<{ id: string; input: TagWriteInput }>,
  hooks: { record?: (tx: any, results: TagWriteResult[]) => Promise<void> } = {},
): Promise<{ results: TagWriteResult[] }> {
  return inTagTransaction(prisma, async (tx: any) => {
    const results: TagWriteResult[] = [];
    const changed: Array<{ id: string; current: any }> = [];
    const gone: string[] = [];
    for (const { id, input } of items) {
      try { results.push(await writeInTx(tx, id, input)); } catch (e) {
        if (e instanceof RecordGone) gone.push(id);
        else if (e instanceof VersionConflict) changed.push({ id, current: e.current });
        else throw e;
      }
    }
    // Бросок внутри транзакции откатывает и уже записанные теги пачки
    if (changed.length || gone.length) throw new TagBulkConflict(changed, gone);
    if (hooks.record) await hooks.record(tx, results);
    return { results };
  }, { timeout: 120000, maxWait: 15000 });
}

/**
 * То же, но сначала узнаёт нарушение ключа кода: создание, проигравшее гонку,
 * отвечает отказом «код занят» с занявшим тегом, а не 500.
 */
export async function tagFailure(prisma: any, err: unknown, projectId: string, identifier: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> {
  return tagWriteFailure(await duplicateOf(prisma, err, projectId, identifier));
}

/**
 * Ошибка записи → ответ HTTP; null — это не наша ошибка. Отказы по версии и
 * «тега нет» (`VersionConflict`, `RecordGone`) отвечает общее место
 * (`sendGuardRefusal`, server/versionGuard.ts): маршрут зовёт его раньше этой функции.
 */
export function tagWriteFailure(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof TagBadRequest) return { status: 400, body: { error: err.message } };
  // Занятый код — не конфликт версий: экрану нечего перечитывать, человек должен выбрать другой код
  // `code` — как заведён отказанный код, `existing` — тег, который его занял (если удалось прочитать)
  if (err instanceof TagDuplicate) return { status: 409, body: { error: err.message, duplicate: true, code: err.identifier, existing: err.existing ?? null } };
  // Массовая запись: что изменили и что удалили, пока человек смотрел; записано не было ничего
  if (err instanceof TagBulkConflict) return { status: 409, body: { error: err.message, code: VERSION_CONFLICT, changed: err.changed, gone: err.gone } };
  return null;
}
