/**
 * Команда платформы: выполняется один раз, сколько бы раз её ни прислали.
 *
 * Повтор — не редкость, а норма работы. Обрыв связи посреди запроса выглядит
 * для окна как неудача, и окно отправляет снова; человек, не дождавшись
 * ответа, нажимает второй раз; сеть сама дублирует отправку. Без расписки
 * «Создать группу» создала бы вторую, «Пригласить» отправило бы два
 * приглашения, а «Начать матч» завело бы два матча и развело группу по разным
 * серверам.
 *
 * Правила, из которых всё состоит:
 *
 *   1. **Ключ идемпотентности даёт окно.** Один ключ — одно действие. Второй
 *      запрос с тем же ключом получает ТОТ ЖЕ ответ, а не делает действие
 *      заново, и помечен `repeated`, чтобы окно не сказало человеку
 *      «Приглашение отправлено» второй раз.
 *   2. **Тело запроса хешируется.** Тот же ключ с другим телом — это ошибка
 *      программиста или подмена, а не повтор, и отвечать на него прежним
 *      результатом нельзя.
 *   3. **Расписка пишется в ТОЙ ЖЕ транзакции, что и само действие.**
 *      Иначе между ними есть щель, в которую помещается весь сбой: действие
 *      сделано, расписки нет, повтор делает его второй раз.
 *   4. **Ожидаемая версия.** Кто опоздал — тот получает отказ с текущим
 *      состоянием, а не затирает чужое изменение молча.
 *
 * Расписки живут сутки. Дольше повторов не бывает, а таблица растёт.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import {
  PLAY_ERRORS, PLAY_LIMITS, playErrorText,
  type PlayCommandReceipt, type PlayErrorCode,
} from '../../play/contracts.js';

/** Отказ с кодом: по коду решает программа, по тексту — человек. */
export class PlayFailure extends Error {
  code: PlayErrorCode | string;
  details: unknown;
  constructor(code: PlayErrorCode | string, message?: string, details?: unknown) {
    super(message || playErrorText(code));
    this.code = code;
    this.details = details;
  }
}

export const fail = (code: PlayErrorCode | string, message?: string, details?: unknown): never => {
  throw new PlayFailure(code, message, details);
};

/** Хеш тела запроса: по нему повтор отличается от другого запроса под тем же ключом. */
export function bodyHash(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

/**
 * Устойчивая запись JSON: порядок ключей не должен менять хеш.
 *
 * Иначе один и тот же повтор, собранный окном в другом порядке полей, выглядел
 * бы как «тот же ключ с другим телом» и получал отказ на ровном месте.
 */
export function stableJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  try { return JSON.stringify(walk(value) ?? null); } catch (_) { return '""'; }
}

/** Ключ идемпотентности из заголовка. Пустой не годится: он не ключ. */
export function keyFromRequest(req: any): string {
  const raw = String(req?.headers?.['idempotency-key'] || req?.body?.clientRequestId || '').trim();
  return raw.slice(0, 120);
}

const safeParse = (text: string): any => {
  try { return JSON.parse(text || 'null'); } catch (_) { return null; }
};

export interface RunOptions<T> {
  actorId: string;
  key: string;
  kind: string;
  body: unknown;
  /**
   * Само действие. Получает транзакцию: всё, что оно делает, и расписка о нём
   * записываются вместе или не записываются вовсе.
   */
  work: (tx: any) => Promise<T>;
}

/**
 * Выполнить команду один раз.
 *
 * Порядок именно такой:
 *
 *   — ищем расписку. Нашли с тем же хешом тела — отдаём её ответ и уходим;
 *   — нашли с другим хешом — это не повтор, а ошибка;
 *   — не нашли — делаем работу и пишем расписку В ОДНОЙ транзакции;
 *   — проиграли гонку двух одинаковых запросов (уникальный индекс не дал
 *     записать вторую расписку) — перечитываем чужую и отдаём её ответ.
 *
 * Последний случай — не редкость: два нажатия подряд как раз его и создают.
 */
export async function runCommand<T>(opts: RunOptions<T>): Promise<PlayCommandReceipt<T>> {
  const prisma = getPrisma();
  if (!prisma) return { ok: false, repeated: false, code: PLAY_ERRORS.NOT_FOUND, message: 'База недоступна' };

  const { actorId, key, kind } = opts;
  if (!actorId) return { ok: false, repeated: false, code: PLAY_ERRORS.FORBIDDEN, message: playErrorText(PLAY_ERRORS.FORBIDDEN) };
  if (!key) {
    return {
      ok: false, repeated: false, code: PLAY_ERRORS.INVALID,
      message: 'Команда без ключа идемпотентности не принимается',
    };
  }

  const hash = bodyHash(opts.body);

  const existing = await prisma.playCommand.findFirst({ where: { actorId, key } });
  if (existing) return fromReceipt<T>(existing, hash);

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const value = await opts.work(tx);
      await tx.playCommand.create({
        data: {
          id: randomUUID(),
          actorId,
          key,
          requestHash: hash,
          kind,
          status: 'OK',
          resultJson: JSON.stringify(value ?? null),
          expiresAt: new Date(Date.now() + PLAY_LIMITS.receiptTtlMs),
        },
      });
      return value;
    });
    return { ok: true, repeated: false, result: result as T };
  } catch (e: any) {
    // Два одинаковых запроса пришли одновременно: второй не смог записать
    // расписку. Это и есть повтор — отдаём ответ первого
    if (isDuplicate(e)) {
      const twin = await prisma.playCommand.findFirst({ where: { actorId, key } });
      if (twin) return fromReceipt<T>(twin, hash);
    }
    if (e instanceof PlayFailure) {
      /**
       * Отказ записывается распиской тоже.
       *
       * Иначе повтор отказанной команды пошёл бы выполняться заново — и с
       * третьей попытки мог бы пройти, хотя человек нажимал один раз.
       */
      try {
        await prisma.playCommand.create({
          data: {
            id: randomUUID(),
            actorId, key, requestHash: hash, kind,
            status: 'FAILED',
            resultJson: JSON.stringify({ details: e.details ?? null }),
            errorCode: String(e.code),
            expiresAt: new Date(Date.now() + PLAY_LIMITS.receiptTtlMs),
          },
        });
      } catch (__) { /* гонка: расписку уже записал близнец */ }
      return { ok: false, repeated: false, code: e.code, message: e.message };
    }
    throw e;
  }
}

function fromReceipt<T>(row: any, hash: string): PlayCommandReceipt<T> {
  if (String(row.requestHash) !== hash) {
    return {
      ok: false,
      repeated: false,
      code: PLAY_ERRORS.IDEMPOTENCY_MISMATCH,
      message: playErrorText(PLAY_ERRORS.IDEMPOTENCY_MISMATCH),
    };
  }
  if (row.status === 'FAILED') {
    return {
      ok: false,
      repeated: true,
      code: String(row.errorCode || PLAY_ERRORS.INVALID),
      message: playErrorText(String(row.errorCode || PLAY_ERRORS.INVALID)),
    };
  }
  return { ok: true, repeated: true, result: safeParse(row.resultJson) as T };
}

/** «Такая запись уже есть» — сообщение у каждого движка своё. */
export const isDuplicate = (e: any): boolean =>
  e?.code === 'P2002'
  || /unique|duplicate|constraint failed/i.test(String(e?.message || ''));

/**
 * Изменить запись, только если её версия та, которую видел человек.
 *
 * Условие стоит ВНУТРИ UPDATE, а не проверяется до него: между чтением и
 * записью помещается чужое изменение, и проверка «до» ловит не всё. Ноль
 * изменённых строк — это и есть «вы опоздали».
 */
export async function bumpRevision(
  tx: any, model: string, id: string, expected: number, data: Record<string, unknown>,
): Promise<boolean> {
  const res = await tx[model].updateMany({
    where: { id, revision: expected },
    data: { ...data, revision: expected + 1 },
  });
  return (res?.count || 0) > 0;
}

/**
 * Записать событие агрегата.
 *
 * Версия события — это версия агрегата ПОСЛЕ изменения. Уникальный индекс
 * `[aggregate, aggregateId, version]` не даст записать два события с одной
 * версией: история остаётся без пропусков и без двойников, иначе клиент после
 * обрыва досчитается не до того состояния.
 */
export async function appendEvent(
  tx: any, aggregate: string, aggregateId: string, version: number, kind: string, data: unknown,
): Promise<void> {
  await tx.playEvent.create({
    data: {
      id: randomUUID(),
      aggregate,
      aggregateId,
      version,
      kind,
      dataJson: JSON.stringify(data ?? {}),
    },
  });
}

/**
 * Поставить сообщение в очередь доставки.
 *
 * В той же транзакции, что и изменение: сокет, толкнутый сразу после коммита,
 * теряется ровно тогда, когда это дороже всего. `dedupeKey` собирается из
 * события и получателя — повторная обработка не пошлёт второго сообщения.
 */
export async function enqueue(
  tx: any, dedupeKey: string, recipientId: string, kind: string, payload: unknown,
): Promise<void> {
  try {
    await tx.playOutbox.create({
      data: {
        id: randomUUID(),
        dedupeKey,
        recipientId,
        kind,
        payloadJson: JSON.stringify(payload ?? {}),
      },
    });
  } catch (e) {
    // Такое сообщение уже поставлено — цель достигнута
    if (!isDuplicate(e)) throw e;
  }
}
