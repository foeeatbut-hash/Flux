/**
 * Очередь платформы: сначала в базу, потом по сокету.
 *
 * Сообщение, отправленное сразу после записи, теряется ровно в тот момент,
 * когда это дороже всего: транзакция прошла, сокет отвалился, и половина
 * группы не узнала, что матч начался. Поэтому запись в очередь идёт в ТОЙ ЖЕ
 * транзакции, что и само изменение (см. `enqueue` в commands.ts), а разбирает
 * очередь отдельный проход.
 *
 * У сотрудников разные встроенные серверы на одной базе, поэтому проход берёт
 * записи в аренду: помечает своим разовым признаком и работает только со
 * своими. Иначе два сервера разослали бы одно и то же дважды.
 *
 * Сокет здесь только ускоряет. Способ доставки — запись в базе: окно, которое
 * в нужную секунду было без связи, дочитает пропущенное снимком (snapshot.ts).
 */

import { randomUUID } from 'node:crypto';
import { getPrisma, onDatabaseSwapped, pushToUser } from '../context.js';

/** Как часто разбирать очередь. Платформа живая — чаще, чем у обращений. */
const TICK_MS = 1000;
/** Сколько записей за проход: маленькими пачками, чтобы не держать базу. */
const BATCH = 50;
/** Аренда на минуту: если сервер упадёт, запись подберёт другой. */
const LEASE_MS = 60_000;
/** Столько раз пробуем, потом откладываем насовсем. */
const ATTEMPTS = 5;

/** Отступ перед повтором растёт: сеть, упавшая на секунду, чинится сама. */
const backoffMs = (attempt: number): number => Math.min(60_000, 500 * 2 ** Math.max(0, attempt - 1));

let timer: ReturnType<typeof setInterval> | null = null;
let working = false;

const safeJson = (text: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
};

/**
 * Один проход очереди. Возвращает, сколько записей разобрано, — это нужно
 * проверкам: «ноль» и «не работает» иначе неотличимы.
 */
export async function drainPlayOutbox(): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) return 0;
  const now = new Date();
  const token = randomUUID();

  let sent = 0;
  try {
    const ready = await prisma.playOutbox.findMany({
      where: {
        state: 'PENDING',
        availableAt: { lte: now },
        attempt: { lt: ATTEMPTS },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      select: { id: true },
      take: BATCH,
    });
    if (!ready.length) return 0;

    // Захват: условие про аренду стоит внутри UPDATE, поэтому чужие записи
    // отсеются сами, даже если между выборкой и захватом их успел взять сосед
    await prisma.playOutbox.updateMany({
      where: {
        id: { in: ready.map((r: any) => r.id) },
        state: 'PENDING',
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseOwner: token, leaseUntil: new Date(now.getTime() + LEASE_MS), attempt: { increment: 1 } },
    });

    const mine = await prisma.playOutbox.findMany({ where: { leaseOwner: token, state: 'PENDING' } });
    for (const row of mine) {
      try {
        // Сначала отметка в базе, потом толчок: упасть между ними можно, и
        // тогда повтор ничего не испортит — окно всё равно перечитает снимок
        await prisma.playOutbox.update({
          where: { id: row.id },
          data: { state: 'DONE', leaseUntil: null, leaseOwner: null },
        });
        pushToUser(row.recipientId, `play:${row.kind}`, safeJson(row.payloadJson));
        sent++;
      } catch (_) {
        try {
          await prisma.playOutbox.update({
            where: { id: row.id },
            data: {
              leaseOwner: null,
              leaseUntil: null,
              availableAt: new Date(Date.now() + backoffMs(row.attempt)),
              ...(row.attempt >= ATTEMPTS ? { state: 'FAILED' } : {}),
            },
          });
        } catch (__) { /* база недоступна — подберём на следующем проходе */ }
      }
    }
  } catch (_) { /* очередь не должна ронять сервер */ }
  return sent;
}

export function startPlayOutbox(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (working) return; // проход длиннее интервала — не наслаиваем
    working = true;
    void drainPlayOutbox().finally(() => { working = false; });
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopPlayOutbox(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

onDatabaseSwapped(() => { stopPlayOutbox(); startPlayOutbox(); });
