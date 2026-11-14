/**
 * Ключ повтора записи (X-Flux-Op-Id) — docs/roadmap/offline-work.md, пункт 0.6 и К6.
 *
 * Зачем. Правка ушла на сервер, а ответ не дошёл (обрыв связи, закрытая
 * крышка, перезапуск). Клиент не знает, внесена ли она, и повторяет. Без
 * ключа повтор делает всё второй раз: вторая строка, вторая ревизия, второе
 * письмо. С ключом сервер узнаёт запрос и второй раз обработчик НЕ запускает.
 *
 * Как устроено (образец — FeedbackMutationReceipt, server/feedback/mutations.ts):
 *  1. ключ занимается ДО выполнения записью PENDING. Уникальность
 *     (actorId, opId) держит сама база, поэтому два одновременных запроса с
 *     одним ключом не пройдут оба: проигравший читает чужую расписку;
 *  2. обработчик выполняется;
 *  3. ответ записывается (DONE) ДО того, как уходит клиенту: клиент, получивший
 *     ответ и тут же повторивший, не должен увидеть PENDING.
 *
 * Повтор с тем же ключом:
 *  - другое тело или адрес (requestHash) — 409 OP_ID_REUSED: ключ занят другим
 *    действием, а не тем, что повторяют;
 *  - DONE — прежние status и тело, заголовок X-Flux-Op-Replayed: 1;
 *  - PENDING — 409 OP_IN_FLIGHT: запрос ещё идёт либо сервер упал посреди, и
 *    исход неизвестен. Угадывать нельзя ни «сделано», ни «не сделано».
 *
 * Статус 5xx и обрыв. Обработчик мог записать часть и упасть, мог ничего не
 * записать — снаружи не отличить. Удалить расписку значило бы разрешить повтор,
 * который удвоит уже сделанное; сохранить 5xx как DONE — отдавать на повтор
 * ошибку, которая могла быть случайной. Поэтому расписка остаётся PENDING, а
 * повтор получает честное «исход неизвестен» (OP_IN_FLIGHT) и проверяет данные
 * глазами. Новое действие человека — новый ключ, его это не блокирует; ключ
 * застревает только у автоматического повтора. Срок жизни — 7 суток, потом уборка.
 * Тело ответа хранится сутки (BODY_TTL_MS): дальше повтор получает статус без тела.
 *
 * Что сохраняется из ответа:
 *  - JSON не больше 256 КиБ — целиком: повтор неотличим от первого ответа;
 *  - больший, не JSON (текст, файл, поток) — только статус: повтор отвечает
 *    тем же статусом и телом { replayed: true }. Потоковые ответы и скачивания
 *    не буферизуются вовсе: хранить мегабайты в таблице расписок нельзя, а
 *    читать ответ, уходящий потоком, значило бы удерживать его в памяти.
 *    У таких ответов расписка пишется уже после ухода ответа (конец потока), так
 *    что мгновенный повтор может застать PENDING и получить OP_IN_FLIGHT — это
 *    безопасная сторона: второго выполнения нет.
 *
 * Хеш запроса. Для JSON и форм — метод, адрес с query и тело в каноническом
 * виде (ключи по порядку). Тела multipart, сырые байты и потоки НЕ читаются
 * (звено стоит до обработчика, и поток принадлежит ему): хеш по методу,
 * адресу, Content-Type, Content-Length и контрольным суммам куска из заголовков
 * (X-Chunk-SHA256, X-Base-SHA256). Это слабее — два разных файла одной длины
 * неотличимы, — но ключ нужен против повтора, а не против подмены, и
 * подменить тело под тот же ключ может только сам автор запроса.
 *
 * Личность — только из authUser, поставленного проверкой входа: заголовком или
 * телом чужой actorId не подсунуть (flux-data-safety, п. 7). Без заголовка или
 * без пользователя запрос идёт как раньше (старый клиент).
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const OP_ID_HEADER = 'X-Flux-Op-Id';
export const OP_REPLAYED_HEADER = 'X-Flux-Op-Replayed';
/** Тело ответа длиннее этого в расписке не хранится — повтор отвечает без тела */
export const MAX_STORED_BODY = 256 * 1024;
/** Срок жизни расписки: дольше повтор по тому же ключу не ждут */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Срок хранения тела ответа. Ключ ставится на каждую запись, и тела за неделю —
 * это сотни мегабайт в общей базе. Повтор из-за обрыва приходит через секунды
 * или минуты, поэтому тело живёт сутки; позже повтор всё так же не выполняется
 * второй раз, но получает прежний статус и { replayed: true } вместо тела.
 */
export const BODY_TTL_MS = 24 * 60 * 60 * 1000;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OP_ID_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

/** Ключ в каноническом виде: порядок полей в теле на хеш не влияет */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestHashOf(req: Request): string {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const parsed = type === 'application/json' || type.endsWith('+json') || type === 'application/x-www-form-urlencoded';
  const fingerprint = parsed
    ? `body:${canonicalJson(req.body ?? null)}`
    // Поток не читаем: см. «Хеш запроса» в шапке
    : `raw:${type}:${req.headers['content-length'] || ''}:${req.headers['x-chunk-sha256'] || ''}:${req.headers['x-base-sha256'] || ''}`;
  return crypto.createHash('sha256').update(`${req.method}\n${req.originalUrl}\n${fingerprint}`).digest('hex');
}

const refuse = (res: Response, status: number, code: string, error: string) =>
  res.status(status).json({ ok: false, code, error });

const uniqueViolation = (e: any) => e?.code === 'P2002' || /unique constraint/i.test(String(e?.message || ''));
const tableMissing = (e: any) => e?.code === 'P2021' || /no such table|does not exist|doesn't exist/i.test(String(e?.message || ''));

export interface OpReceiptDeps {
  getPrisma: () => any;
  log?: (message: string) => void;
}

export function opReceiptMiddleware(deps: OpReceiptDeps): RequestHandler {
  const log = deps.log || ((m: string) => console.warn(m));
  let missingLogged = false;

  return async function opReceipt(req: Request, res: Response, next: NextFunction) {
    if (!WRITE_METHODS.has(req.method) || !req.path.toLowerCase().startsWith('/api/')) return next();
    const raw = req.get(OP_ID_HEADER);
    const actorId = (req as any).authUser?.id;
    // Старый клиент и запросы без входа — как раньше
    if (raw === undefined || !actorId) return next();
    if (!OP_ID_FORMAT.test(raw)) {
      return refuse(res, 400, 'OP_ID_INVALID', `Заголовок ${OP_ID_HEADER} должен быть из 8–64 символов: латиница, цифры, «_» и «-»`);
    }

    const opId = raw;
    const requestHash = requestHashOf(req);
    const prisma = deps.getPrisma();
    const key = { actorId: String(actorId), opId };

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let claimed = false;
        try {
          await prisma.opReceipt.create({ data: { ...key, requestHash, state: 'PENDING' } });
          claimed = true;
        } catch (e: any) {
          if (!uniqueViolation(e)) throw e;
        }
        if (claimed) return execute(req, res, next, prisma, key, log);

        const existing = await prisma.opReceipt.findUnique({ where: { actorId_opId: key } });
        // Уборка успела удалить расписку между отказом и чтением — занимаем заново
        if (!existing) continue;
        if (existing.requestHash !== requestHash) {
          return refuse(res, 409, 'OP_ID_REUSED', 'Этот ключ запроса уже использован для другого действия. Обновите данные и повторите действие заново');
        }
        if (existing.state === 'DONE') return replay(res, existing);
        return refuse(res, 409, 'OP_IN_FLIGHT', 'Запрос ещё выполняется или его исход неизвестен. Обновите данные и проверьте, прежде чем повторять');
      }
      return refuse(res, 409, 'OP_IN_FLIGHT', 'Запрос ещё выполняется или его исход неизвестен. Обновите данные и проверьте, прежде чем повторять');
    } catch (e: any) {
      // Таблицы расписок ещё нет (общая база до синхронизации схемы): защиты
      // нет, но и запись не блокируем — иначе обновление сервера ломает работу
      if (tableMissing(e)) {
        if (!missingLogged) { missingLogged = true; log(`[OpReceipt] таблицы нет, ключ повтора не действует: ${e?.message || e}`); }
        return next();
      }
      log(`[OpReceipt] не удалось занять ключ: ${e?.message || e}`);
      return refuse(res, 503, 'OP_RECEIPT_UNAVAILABLE', 'Не удалось проверить повтор запроса. Попробуйте ещё раз через минуту');
    }
  };
}

function replay(res: Response, receipt: { status: number; body: string }) {
  res.setHeader(OP_REPLAYED_HEADER, '1');
  if (receipt.status === 204 || receipt.status === 304) return res.status(receipt.status).end();
  if (receipt.body) return res.status(receipt.status).type('application/json').send(receipt.body);
  // Ответ не хранился (большой, не JSON, поток): статус тот же, тела нет
  return res.status(receipt.status).json({ replayed: true });
}

/**
 * Запуск обработчика с перехватом ответа. res.send оборачивается так, что
 * расписка записывается ДО ухода ответа клиенту; res.json в Express вызывает
 * res.send, поэтому перехвата одного места достаточно.
 */
function execute(req: Request, res: Response, next: NextFunction, prisma: any, key: { actorId: string; opId: string }, log: (m: string) => void) {
  let settled = false;
  const where = { actorId_opId: key };
  const settle = async (status: number, body: string) => {
    if (settled) return;
    settled = true;
    // 5xx — расписка остаётся PENDING, см. шапку
    if (status >= 500) return;
    try {
      await prisma.opReceipt.update({ where, data: { state: 'DONE', status, body } });
    } catch (e: any) {
      // Не записалась — останется PENDING: повтор получит «исход неизвестен»,
      // а не второе выполнение
      log(`[OpReceipt] не удалось записать ответ ${key.opId}: ${e?.message || e}`);
    }
  };

  const send = res.send.bind(res);
  const json = res.json.bind(res);
  let intercepted = false;
  (res as any).send = (payload?: any) => {
    // res.send(объект) в Express переходит в res.json, а тот снова зовёт
    // res.send уже со строкой: объект пропускаем, перехватываем строку
    if (payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) return json(payload);
    // Второй вызов после ответа Express сам бы отверг; здесь он не должен
    // обогнать первый, который ещё записывает расписку
    if (intercepted) return res;
    intercepted = true;
    const isJson = typeof payload === 'string' && /^application\/json/i.test(String(res.getHeader('Content-Type') || ''));
    const stored = isJson && Buffer.byteLength(payload) <= MAX_STORED_BODY ? payload : '';
    const status = res.statusCode;
    void settle(status, stored).finally(() => { send(payload); });
    return res;
  };
  // Потоки, res.end(), sendFile: send не вызывался — не буферизуем, пишем только статус.
  // Оборванный поток (close без finish) остаётся PENDING
  res.on('finish', () => { void settle(res.statusCode, ''); });
  next();
}

/**
 * Уборка пачками: расписки (в том числе зависшие PENDING) старше 7 суток
 * удаляются, у выполненных старше суток стирается тело ответа (сама расписка
 * остаётся и повтор по-прежнему не выполняется). Возвращает число удалённых.
 */
export async function cleanupOpReceipts(prisma: any, now: number = Date.now(), batch = 500): Promise<number> {
  const before = new Date(now - RECEIPT_TTL_MS);
  let removed = 0;
  for (;;) {
    const rows = await prisma.opReceipt.findMany({ where: { createdAt: { lt: before } }, select: { id: true }, take: batch });
    if (!rows.length) break;
    const r = await prisma.opReceipt.deleteMany({ where: { id: { in: rows.map((x: any) => x.id) } } });
    removed += r.count;
    if (!r.count || rows.length < batch) break;
  }
  // Одним запросом, без цикла по пачкам: стёртые строки под условие больше не
  // попадают, а цикл при несработавшей записи крутился бы без конца
  await prisma.opReceipt.updateMany({
    where: { state: 'DONE', createdAt: { lt: new Date(now - BODY_TTL_MS) }, NOT: { body: '' } },
    data: { body: '' },
  });
  return removed;
}

/** При старте и каждые шесть часов (тела живут сутки); ошибка уборки (нет таблицы) работе не мешает */
export function startOpReceiptCleanup(getPrisma: () => any, log: (m: string) => void = () => {}): void {
  const run = () => {
    cleanupOpReceipts(getPrisma())
      .then((n) => { if (n) log(`[OpReceipt] уборка расписок: удалено ${n}`); })
      .catch((e) => log(`[OpReceipt] уборка не удалась: ${e?.message || e}`));
  };
  setTimeout(run, 30 * 1000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}
