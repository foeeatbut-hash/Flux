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
 */

import { bumpedData } from './versionBump.js';

/** Запись не применена: запись до этого изменили. `current` — какой она стала (`null`, если уже не прочесть). */
export class VersionConflict extends Error {
  constructor(message: string, public current: any = null) {
    super(message);
    this.name = 'VersionConflict';
  }
}

/** Внутренний сигнал «проиграл гонку, можно перечитать и повторить». */
class RaceLost extends Error {}

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

const RACE_WITH_EXPECTATION = 'Запись уже изменили, пока вы её правили.';
const RACE_WITHOUT_EXPECTATION = 'Запись меняют одновременно, повторите действие.';

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
        if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
          throw new VersionConflict(opts.staleMessage(current), current);
        }
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
      throw new VersionConflict(expecting ? RACE_WITH_EXPECTATION : RACE_WITHOUT_EXPECTATION, fresh);
    }
  }
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
}

/**
 * Удаление записи под сверкой версии: `deleteMany where { id, version }`.
 * Без повторов (см. шапку файла): проигравший гонку получает отказ. Возвращает
 * удалённую запись; нет записи — `null`.
 */
export async function guardedDelete(prisma: any, opts: GuardedDeleteOptions): Promise<{ before: any } | null> {
  try {
    return await inTransaction(prisma, async (db) => {
      const current = await db[opts.model].findUnique({ where: { id: opts.id } });
      if (!current) return null;
      if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
        throw new VersionConflict(opts.staleMessage(current), current);
      }
      if (opts.before) await opts.before(db, current);
      const gone = await db[opts.model].deleteMany({ where: { id: current.id, version: current.version } });
      if (gone.count !== 1) throw new RaceLost();
      return { before: current };
    });
  } catch (e) {
    if (!(e instanceof RaceLost)) throw e;
    // Проигравший гонку: победитель уже записан, его и показываем в отказе
    const fresh = await prisma[opts.model].findUnique({ where: { id: opts.id } }).catch(() => null);
    throw new VersionConflict(RACE_WITH_EXPECTATION, fresh);
  }
}

/**
 * Ответ 409: текст для человека (по-русски, без кода) и текущая запись, чтобы
 * экран показал отказ и перечитал её, а не затёр чужое. Код — отдельным полем.
 * `present` — как маршрут обычно отдаёт эту запись (разбор JSON-полей и т. п.).
 */
export function sendVersionConflict(res: { status: (code: number) => { json: (body: unknown) => unknown } }, e: VersionConflict, present?: (record: any) => unknown): unknown {
  const current = e.current && present ? present(e.current) : e.current ?? null;
  return res.status(409).json({ error: e.message, code: 'VERSION_CONFLICT', current });
}
