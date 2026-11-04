/**
 * ВДР: запись под сверкой версии (docs/roadmap/offline-work.md, 0.1).
 *
 * Раньше выпуск ревизии читал строку, считал следующий номер и писал — три
 * отдельных запроса. Два человека, нажавшие «Выпустить» почти одновременно,
 * получали один и тот же номер и две записи истории с ним; правка по
 * устаревшей карточке молча затирала чужую.
 *
 * Теперь чтение, расчёт, запись и история идут в одной транзакции, а сама
 * запись — «сравни и поменяй»: `updateMany` с условием на то, что строка
 * осталась такой, какой её прочли. Это защищает и там, где транзакции читают
 * снимок (PostgreSQL, MariaDB), а не только там, где они идут по очереди
 * (SQLite).
 *
 * Клиент присылает ожидаемую версию — то, что он видел (`expectedRevision`
 * у выпуска, `expectedUpdatedAt` у правки). Не совпала — `VdrConflict`, а
 * маршрут отвечает 409 с текущим состоянием.
 *
 * Клиент без ожидаемой версии (старая сборка) не ломается: его запись
 * сверяется с тем, что сервер прочёл в начале собственной транзакции. Правка
 * полей при проигрыше гонки повторяется (она «поставь эти поля» и от повтора
 * не меняет смысла), а выпуск ревизии — нет: второй выпуск — это ещё одна
 * ревизия, которую человек не просил, поэтому проигравший получает 409.
 */

/** Запись не применена: строку или реестр до этого изменили. */
export class VdrConflict extends Error {
  constructor(message: string) { super(message); this.name = 'VdrConflict'; }
}

/** Внутренний сигнал «проиграл гонку, можно перечитать и повторить». */
class RaceLost extends Error {}

/** Попыток повтора правки полей у клиента без ожидаемой версии. */
const RETRIES = 4;

/** Время в тексте отказа: «04.11.2026 14:32». */
export function whenText(value: Date | string | null | undefined): string {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const sameInstant = (a: any, b: any): boolean => new Date(a).getTime() === new Date(b).getTime();

/**
 * Ожидаемая версия из тела запроса: строка с датой или ничего.
 * `null` — присланное нечитаемо (сервер ответит 400, а не примет за «версии нет»).
 */
export function expectedStamp(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/** Ожидаемая ревизия из тела запроса: непустая строка или ничего. */
export function expectedRevisionOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Транзакция, если база их умеет. Заглушки проверок без `$transaction`
 * получают сам клиент: сверка «сравни и поменяй» остаётся в силе.
 */
export function inTransaction<T>(prisma: any, fn: (db: any) => Promise<T>): Promise<T> {
  return typeof prisma.$transaction === 'function' ? prisma.$transaction(fn) : fn(prisma);
}

interface GuardedUpdate<R> {
  model: 'docRegister' | 'docRegisterItem';
  id: string;
  /** Что клиент видел (`updatedAt`); без него запись сверяется с собственным чтением. */
  expectedUpdatedAt?: string;
  /**
   * Что писать, по прочитанной записи. Бросает `VdrConflict`, когда запись
   * по прочитанному состоянию недопустима. Читать из базы не через `db` здесь
   * нельзя: SQLite держит соединение за транзакцией, и чужой запрос ждал бы
   * её конца, пока она ждёт его.
   */
  build: (current: any, db: any) => Promise<{ data: any; extra?: R }> | { data: any; extra?: R };
  /** Текст отказа, когда запись изменили после того, как клиент её увидел. */
  staleMessage: (current: any) => string;
}

/**
 * Правка записи под сверкой версии. Возвращает запись до и после и то, что
 * вернул `build`. Нет записи — `null`.
 */
export async function guardedUpdate<R = undefined>(prisma: any, opts: GuardedUpdate<R>): Promise<{ before: any; after: any; extra?: R } | null> {
  const attempts = opts.expectedUpdatedAt ? 1 : RETRIES;
  for (let n = 1; ; n++) {
    try {
      return await inTransaction(prisma, async (db) => {
        const current = await db[opts.model].findUnique({ where: { id: opts.id } });
        if (!current) return null;
        if (opts.expectedUpdatedAt && !sameInstant(current.updatedAt, opts.expectedUpdatedAt)) {
          throw new VdrConflict(opts.staleMessage(current));
        }
        const { data, extra } = await opts.build(current, db);
        const swapped = await db[opts.model].updateMany({ where: { id: current.id, updatedAt: current.updatedAt }, data });
        if (swapped.count !== 1) throw new RaceLost();
        const after = await db[opts.model].findUnique({ where: { id: current.id } });
        return { before: current, after, extra };
      });
    } catch (e) {
      if (!(e instanceof RaceLost)) throw e;
      if (n >= attempts) throw new VdrConflict(opts.expectedUpdatedAt ? 'Запись уже изменили, пока вы её правили.' : 'Запись меняют одновременно, повторите действие.');
    }
  }
}

/**
 * Выпуск ревизии: «сравни и поменяй» по номеру ревизии. Номер считает
 * `next` по прочитанной записи внутри транзакции; `after` пишет историю
 * в той же транзакции — не записалась история, не выпустилась и ревизия.
 * Без повторов: проигравший гонку получает отказ (см. шапку файла).
 */
export async function guardedIssue<R>(prisma: any, opts: {
  model: 'docRegister' | 'docRegisterItem';
  id: string;
  expectedRevision?: string;
  next: (current: any) => { data: any; extra: R };
  after?: (db: any, current: any, extra: R) => Promise<void>;
  /** Текст отказа; `db` — клиент транзакции (или сам клиент после неё). */
  staleMessage: (db: any, current: any) => Promise<string> | string;
}): Promise<{ before: any; after: any; extra: R } | null> {
  try {
    return await inTransaction(prisma, async (db) => {
      const current = await db[opts.model].findUnique({ where: { id: opts.id } });
      if (!current) return null;
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
        throw new VdrConflict(await opts.staleMessage(db, current));
      }
      const { data, extra } = opts.next(current);
      const swapped = await db[opts.model].updateMany({
        where: { id: current.id, revision: current.revision, updatedAt: current.updatedAt }, data,
      });
      if (swapped.count !== 1) throw new RaceLost();
      if (opts.after) await opts.after(db, current, extra);
      const after = await db[opts.model].findUnique({ where: { id: current.id } });
      return { before: current, after, extra };
    });
  } catch (e) {
    if (!(e instanceof RaceLost)) throw e;
    // Проигравший гонку: победитель уже записан, его и называем в отказе
    const fresh = await prisma[opts.model].findUnique({ where: { id: opts.id } });
    throw new VdrConflict(fresh ? await opts.staleMessage(prisma, fresh) : 'Запись уже изменили.');
  }
}
