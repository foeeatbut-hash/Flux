/**
 * Открытые записи: какие позиции и установки сейчас на экранах сотрудников.
 *
 * Зачем. Удаление записи, которую коллега держит открытой, оставляет ему на
 * экране то, чего уже нет, и его правка потом падает «записи нет». Поэтому
 * удаление такой записи не проходит (server/versionGuard.ts, `openCheck`).
 *
 * Почему в общей базе. Сервер у каждого свой, база одна на всех, а удаление
 * проверяет тот сервер, куда оно пришло, — память другого сервера ему не
 * видна. Та же причина, что у присутствия (server/presence.ts), и тот же
 * приём: строки в общей таблице, свежесть по времени.
 *
 * Что окно присылает. Полный список открытого одним запросом — при смене
 * выбранного и каждые 15 с. Сервер ставит этим строкам свежее время и стирает
 * остальные строки этого окна: что окно не назвало, то оно закрыло. Пустой
 * список — «ничего не держу». Строка действует, пока свежа (src/lib/openRecordTime.ts).
 *
 * Имя модели — как в schema.prisma и в VERSIONED_MODELS («ComponentElement»),
 * а не делегат клиента: так её присылает окно.
 */

import { ensureTables } from './ddl.js';
import { VERSIONED_MODELS } from './versionBump.js';
import { OPEN_FRESH_MS, OPEN_MAX_RECORDS, OPEN_PURGE_MS } from '../src/lib/openRecordTime.js';
import type { RefusalNoun } from '../src/lib/refusalTexts.js';

/** Запись, которую держат открытой, или которую проверяют на это. `name` — для текста отказа. */
export interface OpenRef { model: string; id: string; name?: string }
export interface OpenHolder { userId: string; name: string }
/** Запись из проверяемых и те, у кого она открыта */
export interface OpenHit extends OpenRef { holders: OpenHolder[] }

/**
 * Как модель называется в тексте отказа. Новая программа, которой нужна защита
 * открытой записи, добавляет сюда строку (а слово — в NOUNS словаря отказов).
 */
export const NOUN_OF_MODEL: Record<string, RefusalNoun> = {
  ComponentElement: 'position',
  EquipmentSystem: 'system',
  Monoblock: 'block',
  Tag: 'tag',
  DocRegister: 'register',
  DocRegisterItem: 'registerItem',
  Project: 'project',
  Dictionary: 'dictionary',
  DictionaryItem: 'dictionaryItem',
  TagTemplate: 'tagTemplate',
};

/** Делегат клиента → имя модели: `componentElement` → `ComponentElement` */
export const schemaModelOf = (delegate: string): string => delegate.charAt(0).toUpperCase() + delegate.slice(1);

/** Ключ окна: случайная строка, которую окно придумывает само и держит до закрытия */
export const HOLDER_KEY_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

const ID_MAX = 200;

/**
 * Разбор присланного списка. `null` — нечитаемо (маршрут ответит 400, а не
 * примет за «ничего не открыто»: иначе кривой запрос молча освободил бы записи).
 * Повторы схлопываются.
 */
export function parseOpenList(raw: unknown): OpenRef[] | null {
  if (!Array.isArray(raw) || raw.length > OPEN_MAX_RECORDS) return null;
  const seen = new Set<string>();
  const out: OpenRef[] = [];
  for (const item of raw) {
    const model = typeof item?.model === 'string' ? item.model : '';
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!VERSIONED_MODELS.includes(model) || !id || id.length > ID_MAX) return null;
    const key = `${model}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ model, id });
  }
  return out;
}

/** «Таблицы нет» на любом из трёх движков */
export const isMissingTable = (e: any): boolean =>
  e?.code === 'P2021' || /no such table|does not exist|doesn't exist|не существует/i.test(String(e?.message || ''));

/** Общая база могла быть создана версией без этой таблицы — тогда создаём её сами, как присутствие. */
export function ensureOpenTable(prisma: any): Promise<string> {
  return ensureTables(prisma, [{
    table: 'OpenRecord',
    cols: [
      { name: 'id', kind: 'text', pk: true },
      { name: 'model', kind: 'text', notNull: true, indexed: true },
      { name: 'recordId', kind: 'text', notNull: true, indexed: true },
      { name: 'userId', kind: 'text', notNull: true },
      { name: 'holderKey', kind: 'text', notNull: true, indexed: true },
      { name: 'at', kind: 'time', notNull: true, def: 'now', indexed: true },
    ],
    indexes: [
      { name: 'OpenRecord_model_recordId_holderKey_key', cols: ['model', 'recordId', 'holderKey'], unique: true },
      { name: 'OpenRecord_holderKey_idx', cols: ['holderKey'] },
      { name: 'OpenRecord_at_idx', cols: ['at'] },
    ],
  }], (m) => console.error('[Открытые записи]', m));
}

const uniqueViolation = (e: any): boolean => e?.code === 'P2002' || /unique constraint|duplicate/i.test(String(e?.message || ''));

let lastPurge = 0;

async function write(db: any, userId: string, holderKey: string, records: OpenRef[], now: Date): Promise<void> {
  for (const r of records) {
    // Сначала обновить свою строку: чужую (тот же ключ у другого человека — случайность
    // на уровне подбора) эта правка не тронет, а создание тогда упрётся в уникальность
    const done = await db.openRecord.updateMany({
      where: { model: r.model, recordId: r.id, holderKey, userId },
      data: { at: now },
    });
    if (done.count > 0) continue;
    try {
      await db.openRecord.create({ data: { model: r.model, recordId: r.id, userId, holderKey, at: now } });
    } catch (e) {
      // Параллельный запрос этого же окна успел создать строку первым: она уже свежая
      if (!uniqueViolation(e)) throw e;
    }
  }
  // Что окно не назвало, то закрыто. Только своё: чужой ключ чужих строк не стирает
  await db.openRecord.deleteMany({
    where: records.length
      ? { holderKey, userId, NOT: records.map((r) => ({ model: r.model, recordId: r.id })) }
      : { holderKey, userId },
  });
}

/**
 * Записать полный список открытого окном `holderKey` человека `userId`.
 * Таблицы нет — создаёт её и повторяет один раз.
 */
export async function reportOpen(prisma: any, input: { userId: string; holderKey: string; records: OpenRef[] }, now = new Date()): Promise<void> {
  const run = () => write(prisma, input.userId, input.holderKey, input.records, now);
  try {
    await run();
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    const why = await ensureOpenTable(prisma);
    if (why) throw e;
    await run();
  }
  // Следы окон, закрытых без прощания (выключили питание): раз в десять минут на процесс
  if (now.getTime() - lastPurge > 10 * 60_000) {
    lastPurge = now.getTime();
    await purgeStale(prisma, now);
  }
}

/** Стереть строки старше суток: запись они давно не держат, а таблица от них росла бы вечно. Сбой уборки не мешает работе. */
export async function purgeStale(prisma: any, now = new Date()): Promise<void> {
  await prisma.openRecord.deleteMany({ where: { at: { lt: new Date(now.getTime() - OPEN_PURGE_MS) } } }).catch(() => null);
}

const CHUNK = 400;

/**
 * Кто держит открытыми записи из списка. `userId` — тот, кто проверяет: его
 * собственные окна не мешают (удаляющий сам держит запись выбранной). Только
 * свежие отметки. Каждая запись списка попадает в ответ не больше раза, с
 * людьми по одному разу и с именем из карточки пользователя (`User.name`).
 *
 * `db` — клиент транзакции, если вызывают из неё: читать мимо неё нельзя
 * (SQLite держит соединение за транзакцией). Ошибку чтения не глотает: что
 * с ней делать — таблицы нет или иной сбой, — решает вызывающий.
 */
export async function findOpen(db: any, input: { userId: string; records: OpenRef[] }, now = Date.now()): Promise<OpenHit[]> {
  const wanted = new Map<string, OpenRef>();
  for (const r of input.records) if (r.id && !wanted.has(`${r.model}\u0000${r.id}`)) wanted.set(`${r.model}\u0000${r.id}`, r);
  if (!wanted.size) return [];
  const byModel = new Map<string, string[]>();
  for (const r of wanted.values()) byModel.set(r.model, [...(byModel.get(r.model) || []), r.id]);

  const rows: Array<{ model: string; recordId: string; userId: string }> = [];
  for (const [model, ids] of byModel) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      rows.push(...await db.openRecord.findMany({
        where: {
          model, recordId: { in: ids.slice(i, i + CHUNK) },
          userId: { not: input.userId },
          at: { gte: new Date(now - OPEN_FRESH_MS) },
        },
        select: { model: true, recordId: true, userId: true },
      }));
    }
  }
  if (!rows.length) return [];

  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf = new Map<string, string>(users.map((u: any) => [String(u.id), String(u.name || '')]));

  const hits = new Map<string, OpenHit>();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.recordId}`;
    const ref = wanted.get(key);
    if (!ref) continue;
    const hit = hits.get(key) || { ...ref, holders: [] };
    if (!hit.holders.some((h) => h.userId === row.userId)) hit.holders.push({ userId: row.userId, name: nameOf.get(row.userId) || '' });
    hits.set(key, hit);
  }
  // В порядке, в каком записи названы: сама удаляемая первой, затем вложенные
  return Array.from(wanted.keys()).filter((k) => hits.has(k)).map((k) => hits.get(k)!);
}

/**
 * Все свежие отметки чужих окон — без списка записей, которыми они могли бы быть.
 *
 * Для обратного обхода: у удаляемого проекта могут быть десятки тысяч тегов, и
 * спрашивать «а этот открыт?» по каждому нельзя, а чужих окон мало (в каждом не
 * больше OPEN_MAX_RECORDS записей). Берём то, что открыто, и уже по нему решает
 * вызывающий, какие записи принадлежат проекту. Каждая запись — один раз.
 * `db` и ошибки — как у `findOpen`.
 */
export async function findFreshOpenRefs(db: any, input: { userId: string }, now = Date.now()): Promise<OpenRef[]> {
  const rows: Array<{ model: string; recordId: string }> = await db.openRecord.findMany({
    where: { userId: { not: input.userId }, at: { gte: new Date(now - OPEN_FRESH_MS) } },
    select: { model: true, recordId: true },
  });
  const seen = new Set<string>();
  const out: OpenRef[] = [];
  for (const row of rows) {
    const key = `${row.model}\u0000${row.recordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ model: row.model, id: row.recordId });
  }
  return out;
}
