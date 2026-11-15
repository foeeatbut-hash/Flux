/**
 * Одно место сверки версии записи (docs/roadmap/offline-work.md, 0.5).
 *
 * Обобщение приёма, найденного на ВДР (server/vdrWrite.ts): чтение, расчёт и
 * запись идут в одной транзакции, а сама запись — «сравни и поменяй»:
 * `updateMany` с условием `version`, равной прочитанной. Это защищает и там,
 * где транзакции читают снимок (PostgreSQL, MariaDB), а не только там, где они
 * идут по очереди (SQLite): проигравший гонку видит `count === 0`.
 *
 * Клиент присылает `expectedVersion` — целую версию, которую видел
 * (`version` в записи, которую отдал сервер). Не совпала — `VersionConflict`
 * с текущей записью, а маршрут отвечает 409 через `sendVersionConflict`.
 *
 * Клиент без версии (старая сборка) не ломается: его запись сверяется с тем,
 * что сервер прочёл в начале собственной транзакции. Правка полей при
 * проигрыше гонки повторяется (она «поставь эти поля» и от повтора не
 * меняет смысла), а удаление — нет: повторное удаление по уже изменённой
 * записи — другое действие, поэтому проигравший получает 409.
 *
 * Версию двигает и расширение клиента (server/versionBump.ts), но запись
 * здесь добавляет её рост сама: сверка не должна зависеть от того, подключено
 * ли расширение к клиенту (заглушки и проверки на голом клиенте).
 *
 * Удаление, кроме версии, сверяется с открытыми записями (`openCheck`): то, что
 * коллега сейчас держит на экране, не удаляется (server/openRecords.ts).
 * Правка записи, которой уже нет, отвечает 404 с кодом (`sendRecordGone`).
 */

import { bumpedData } from './versionBump.js';
import { findOpen, isMissingTable, NOUN_OF_MODEL, schemaModelOf, type OpenHolder, type OpenRef } from './openRecords.js';
import {
  RECORD_GONE, RECORD_OPEN, VERSION_CONFLICT, createInsideGoneText, deleteOpenNestedText, deleteOpenText,
  editGoneText, openCheckUnavailableText, racedText, type RefusalNoun,
} from '../src/lib/refusalTexts.js';

/** Запись не применена: запись до этого изменили. `current` — какой она стала (`null`, если уже не прочесть). */
export class VersionConflict extends Error {
  constructor(message: string, public current: any = null) {
    super(message);
    this.name = 'VersionConflict';
  }
}

/** Внутренний сигнал «проиграл гонку, можно перечитать и повторить». */
class RaceLost extends Error {}

/**
 * Записи, которую правят или внутрь которой добавляют, уже нет (404 `RECORD_GONE`).
 * Маршрут отвечает так на «не нашли»; guardedWrite — на проигранную гонку, когда
 * победитель запись удалил (если маршрут назвал существительное).
 */
export class RecordGone extends Error {
  constructor(public noun: RefusalNoun, public inside = false, public recordName?: unknown) {
    super(inside ? createInsideGoneText(noun) : editGoneText(noun, recordName));
    this.name = 'RecordGone';
  }
}

/** Удаление отклонено: запись (или то, что уйдёт вместе с ней) открыта у другого сотрудника. */
export class RecordOpen extends Error {
  constructor(message: string, public holders: OpenHolder[], public record: { model: string; id: string; name: string }) {
    super(message);
    this.name = 'RecordOpen';
  }
}

/** Открытые записи прочесть не удалось (не «таблицы нет», а иной сбой): удалять вслепую нельзя. */
export class OpenCheckUnavailable extends Error {
  constructor(public cause?: unknown) {
    super(openCheckUnavailableText());
    this.name = 'OpenCheckUnavailable';
  }
}

/** Внутренний сигнал: таблицы открытых записей нет, удаление идёт без этой защиты. */
class OpenTableMissing extends Error {}

/** Попыток повтора правки у клиента без ожидаемой версии. */
const RETRIES = 4;

/**
 * Ожидаемая версия из тела (или строки) запроса: целое ≥ 1 или ничего.
 * `null` — присланное нечитаемо (маршрут ответит 400, а не примет за «версии
 * нет» и не запишет вслепую). Число придёт и строкой — так её отдаёт `?expectedVersion=`.
 */
export function expectedVersionOf(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Транзакция, если база их умеет. Заглушки проверок без `$transaction`
 * получают сам клиент: сверка «сравни и поменяй» остаётся в силе.
 */
export function inTransaction<T>(prisma: any, fn: (db: any) => Promise<T>): Promise<T> {
  return typeof prisma.$transaction === 'function' ? prisma.$transaction(fn) : fn(prisma);
}

const sameInstant = (a: any, b: any): boolean => new Date(a).getTime() === new Date(b).getTime();

/**
 * Сравнение версии клиента с прочитанной записью — единственное место, где оно
 * записано. `guardedWrite` и `guardedDelete` зовут его сами; маршрут зовёт его
 * там, где до записи есть побочное действие, которое нельзя делать по
 * устаревшей карточке (завести тег, создать позицию по месту): проверка идёт
 * до него, а запись всё равно сверяется под `updateMany where version`.
 */
export function assertExpectedVersion(current: any, expectedVersion: number | undefined, staleMessage: (current: any) => string): void {
  if (expectedVersion !== undefined && current.version !== expectedVersion) throw new VersionConflict(staleMessage(current), current);
}

const RACE_WITH_EXPECTATION = 'Запись уже изменили, пока вы её правили.';
const RACE_WITHOUT_EXPECTATION = racedText();

export interface GuardedWriteOptions<R> {
  /** Делегат клиента: `tag`, `docRegisterItem`… */
  model: string;
  id: string;
  /** Что клиент видел (`version`); без него запись сверяется с собственным чтением. */
  expectedVersion?: number;
  /** Для ВДР, где клиент сверяет по `updatedAt`: то же сравнение, плюс `updatedAt` в условии записи. */
  expectedUpdatedAt?: string;
  /** Условие записи включает и `updatedAt`, а не только версию (ВДР: писатели без расширения). */
  matchUpdatedAt?: boolean;
  /**
   * Что писать, по прочитанной записи. Бросает `VersionConflict`, когда запись
   * по прочитанному состоянию недопустима. Читать из базы не через `db` здесь
   * нельзя: SQLite держит соединение за транзакцией, и чужой запрос ждал бы
   * её конца, пока она ждёт его.
   */
  build: (current: any, db: any) => Promise<{ data: any; extra?: R }> | { data: any; extra?: R };
  /** Текст отказа, когда запись изменили после того, как клиент её увидел. */
  staleMessage: (current: any) => string;
  /** Что сделать в той же транзакции после записи (например, привести связи к записанному). */
  after?: (db: any, before: any, after: any) => Promise<void>;
  /** Как называется запись в словаре отказов: проигранная гонка с удалением отвечает «записи уже нет», а не пустым конфликтом. */
  goneNoun?: RefusalNoun;
}

/**
 * Правка записи под сверкой версии. Возвращает запись до и после и то, что
 * вернул `build`. Нет записи — `null`.
 */
export async function guardedWrite<R = undefined>(prisma: any, opts: GuardedWriteOptions<R>): Promise<{ before: any; after: any; extra?: R } | null> {
  const expecting = opts.expectedVersion !== undefined || opts.expectedUpdatedAt !== undefined;
  const attempts = expecting ? 1 : RETRIES;
  for (let n = 1; ; n++) {
    try {
      return await inTransaction(prisma, async (db) => {
        const current = await db[opts.model].findUnique({ where: { id: opts.id } });
        if (!current) return null;
        assertExpectedVersion(current, opts.expectedVersion, opts.staleMessage);
        if (opts.expectedUpdatedAt && !sameInstant(current.updatedAt, opts.expectedUpdatedAt)) {
          throw new VersionConflict(opts.staleMessage(current), current);
        }
        const { data, extra } = await opts.build(current, db);
        const swapped = await db[opts.model].updateMany({
          where: { id: current.id, version: current.version, ...(opts.matchUpdatedAt ? { updatedAt: current.updatedAt } : {}) },
          data: bumpedData(data),
        });
        if (swapped.count !== 1) throw new RaceLost();
        const after = await db[opts.model].findUnique({ where: { id: current.id } });
        if (opts.after) await opts.after(db, current, after);
        return { before: current, after, extra };
      });
    } catch (e) {
      if (!(e instanceof RaceLost)) throw e;
      if (n < attempts) continue;
      const fresh = await prisma[opts.model].findUnique({ where: { id: opts.id } }).catch(() => null);
      if (!fresh && opts.goneNoun) throw new RecordGone(opts.goneNoun);
      throw new VersionConflict(expecting ? RACE_WITH_EXPECTATION : RACE_WITHOUT_EXPECTATION, fresh);
    }
  }
}

/**
 * Защита открытой записи при удалении.
 *
 * Проверяется в той же транзакции, до удаления и до всего, что делает `before`:
 * отказ откатывает транзакцию, и ничего не записано. Свои окна человеку не
 * мешают (`userId` — тот, кто удаляет).
 */
export interface OpenCheckOptions {
  /** Кто удаляет: его окна в расчёт не идут */
  userId: string;
  /**
   * Что ещё уйдёт вместе с записью (установка → блоки → позиции; позиция →
   * вложенные), с названиями для текста отказа. Читать — только через `db`.
   */
  cascade?: (db: any, current: any) => Promise<OpenRef[]>;
  /** Название записи в тексте; по умолчанию `name`, затем `itemCode`. */
  nameOf?: (row: any) => string;
}

export interface GuardedDeleteOptions {
  model: string;
  id: string;
  expectedVersion?: number;
  staleMessage: (current: any) => string;
  /**
   * Что сделать в той же транзакции до удаления (каскад, история): не
   * записалось оно — не удалилась и запись.
   */
  before?: (db: any, current: any) => Promise<void>;
  /**
   * Не удалять запись, открытую у другого сотрудника. Без него удаление идёт
   * как раньше: места вне оборудования внесены в перечень храповика
   * (scripts/test-architecture.ts) до своей очереди.
   */
  openCheck?: OpenCheckOptions;
}

const defaultName = (row: any): string => String(row?.name || row?.itemCode || '').trim();

/** Названия существительных нет — ошибка разработчика, а не пользователя: падаем всегда, не только при открытой записи. */
function nounOfModel(model: string): RefusalNoun {
  const noun = NOUN_OF_MODEL[model];
  if (!noun) throw new Error(`Для модели «${model}» нет существительного в NOUN_OF_MODEL (server/openRecords.ts): добавьте строку.`);
  return noun;
}

/** Отказ по первой найденной открытой записи: сама удаляемая — раньше вложенных. */
async function assertNotOpen(db: any, opts: GuardedDeleteOptions, current: any): Promise<void> {
  const check = opts.openCheck!;
  const nameOf = check.nameOf || defaultName;
  const self: OpenRef = { model: schemaModelOf(opts.model), id: current.id, name: nameOf(current) };
  const selfNoun = nounOfModel(self.model);
  const nested = check.cascade ? await check.cascade(db, current) : [];
  for (const r of nested) nounOfModel(r.model);
  let hits: Awaited<ReturnType<typeof findOpen>>;
  try {
    hits = await findOpen(db, { userId: check.userId, records: [self, ...nested] });
  } catch (e) {
    // Общая база создана версией без таблицы: защиты пока нет, а удаление не должно из-за этого вставать
    if (isMissingTable(e)) throw new OpenTableMissing();
    throw new OpenCheckUnavailable(e);
  }
  const hit = hits[0];
  if (!hit) return;
  const text = hit.model === self.model && hit.id === self.id
    ? deleteOpenText(selfNoun, self.name, hit.holders)
    : deleteOpenNestedText({ noun: selfNoun, name: self.name }, { noun: nounOfModel(hit.model), name: hit.name }, hit.holders);
  throw new RecordOpen(text, hit.holders, { model: hit.model, id: hit.id, name: hit.name || '' });
}

/**
 * Удаление записи под сверкой версии: `deleteMany where { id, version }`.
 * Без повторов (см. шапку файла): проигравший гонку получает отказ. Возвращает
 * удалённую запись; нет записи — `null`.
 */
export async function guardedDelete(prisma: any, opts: GuardedDeleteOptions): Promise<{ before: any } | null> {
  let guarded = !!opts.openCheck;
  for (;;) {
    try {
      return await inTransaction(prisma, async (db) => {
        const current = await db[opts.model].findUnique({ where: { id: opts.id } });
        if (!current) return null;
        assertExpectedVersion(current, opts.expectedVersion, opts.staleMessage);
        if (guarded) await assertNotOpen(db, opts, current);
        if (opts.before) await opts.before(db, current);
        const gone = await db[opts.model].deleteMany({ where: { id: current.id, version: current.version } });
        if (gone.count !== 1) throw new RaceLost();
        return { before: current };
      });
    } catch (e) {
      // Транзакция с отказом чтения откатилась целиком (в PostgreSQL после сбоя запроса она негодна) —
      // повторяем удаление без защиты
      if (e instanceof OpenTableMissing && guarded) { guarded = false; continue; }
      if (!(e instanceof RaceLost)) throw e;
      // Проигравший гонку: победитель уже записан, его и показываем в отказе
      const fresh = await prisma[opts.model].findUnique({ where: { id: opts.id } }).catch(() => null);
      throw new VersionConflict(RACE_WITH_EXPECTATION, fresh);
    }
  }
}

type Res = { status: (code: number) => { json: (body: unknown) => unknown } };

/**
 * Ответ 409: текст для человека (по-русски, без кода) и текущая запись, чтобы
 * экран показал отказ и перечитал её, а не затёр чужое. Код — отдельным полем.
 * `present` — как маршрут обычно отдаёт эту запись (разбор JSON-полей и т. п.).
 */
export function sendVersionConflict(res: Res, e: VersionConflict, present?: (record: any) => unknown): unknown {
  const current = e.current && present ? present(e.current) : e.current ?? null;
  return res.status(409).json({ error: e.message, code: VERSION_CONFLICT, current });
}

/**
 * Ответ 409 «запись открыта у другого сотрудника»: текст, кто держит и какая
 * именно запись открыта (при вложенной — она, а не удаляемая).
 */
export function sendRecordOpen(res: Res, e: RecordOpen): unknown {
  return res.status(409).json({
    error: e.message, code: RECORD_OPEN,
    holders: e.holders.map((h) => ({ userId: h.userId, name: h.name })),
    record: e.record,
  });
}

/**
 * Ответ 404 «записи уже нет» при правке или при создании внутри неё: текст из
 * словаря, код отдельным полем. Названия у несуществующей записи нет — только слово.
 */
export function sendRecordGone(res: Res, noun: RefusalNoun, opts: { inside?: boolean; name?: unknown } = {}): unknown {
  const error = opts.inside ? createInsideGoneText(noun) : editGoneText(noun, opts.name);
  return res.status(404).json({ error, code: RECORD_GONE });
}

/** 503: открытые записи прочесть не удалось, ничего не удалено. */
export function sendOpenCheckUnavailable(res: Res, e: OpenCheckUnavailable): unknown {
  return res.status(503).json({ error: e.message });
}

/**
 * Один ответ на все отказы защиты записи: версия, открытая запись, сбой чтения
 * открытых, запись удалена. Возвращает `true`, если ответ дан; иначе ошибка не наша.
 */
export function sendGuardRefusal(res: Res, e: unknown, present?: (record: any) => unknown): boolean {
  if (e instanceof VersionConflict) { sendVersionConflict(res, e, present); return true; }
  if (e instanceof RecordOpen) { sendRecordOpen(res, e); return true; }
  if (e instanceof OpenCheckUnavailable) { sendOpenCheckUnavailable(res, e); return true; }
  if (e instanceof RecordGone) { sendRecordGone(res, e.noun, { inside: e.inside, name: e.recordName }); return true; }
  return false;
}
