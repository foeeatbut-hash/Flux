/**
 * Очередь уведомлений: сначала в базу, потом по сокету.
 *
 * Уведомление, отправленное сразу после записи карточки, теряется ровно в тот
 * момент, когда это дороже всего: транзакция прошла, сокет отвалился, и об
 * обращении никто не узнал. Поэтому запись в очередь идёт в ТОЙ ЖЕ транзакции,
 * что и само изменение, а разбирает очередь отдельный проход.
 *
 * У сотрудников разные встроенные серверы на одной базе, поэтому проход берёт
 * записи в аренду: помечает своим разовым признаком и работает только со
 * своими. Иначе два сервера разослали бы одно и то же дважды.
 *
 * Уведомление создаётся с заранее известным идентификатором, собранным из
 * записи очереди и получателя. Повторная обработка — а она случится при любом
 * сбое посередине — не заводит второе уведомление: база не даёт.
 *
 * Сокет здесь только ускоряет. Способ доставки — запись в базе, которую окно
 * прочитает опросом, даже если связи в нужную секунду не было.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma, onDatabaseSwapped, pushToUser } from '../context.js';
import { reportNumber } from '../../feedback/contracts.js';
import { unreadFor } from './unread.js';

/** Как часто разбирать очередь. Реже — заметно человеку, чаще — незачем. */
const TICK_MS = 5000;
/** Сколько записей за проход: маленькими пачками, чтобы не держать базу. */
const BATCH = 20;
/** Аренда на минуту: если сервер упадёт, запись подберёт другой. */
const LEASE_MS = 60000;
/** Столько раз пробуем, потом откладываем насовсем и показываем в разборе. */
const ATTEMPTS = 5;

/** Отступ перед повтором растёт: сеть, упавшая на секунду, чинится сама. */
const backoffMs = (attempt: number): number => Math.min(10 * 60000, 2000 * 2 ** Math.max(0, attempt - 1));

const TITLES: Record<string, string> = {
  created: 'Новое обращение',
  statusChanged: 'Обращение изменилось',
  assigned: 'Вам назначено обращение',
  commented: 'Ответ по обращению',
};

let timer: ReturnType<typeof setInterval> | null = null;
let working = false;

/**
 * Один проход очереди. Возвращает, сколько записей разобрано, — это нужно
 * проверкам: «ноль» и «не работает» иначе неотличимы.
 */
export async function drainOutbox(): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) return 0;
  const now = new Date();
  const token = randomUUID();

  let taken = 0;
  try {
    const ready = await prisma.feedbackOutbox.findMany({
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
    await prisma.feedbackOutbox.updateMany({
      where: {
        id: { in: ready.map((r: any) => r.id) },
        state: 'PENDING',
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseOwner: token, leaseUntil: new Date(now.getTime() + LEASE_MS), attempt: { increment: 1 } },
    });

    // Свои — те, у кого стоит наш разовый признак: он новый на каждый проход,
    // поэтому спутать с прошлым нельзя
    const mine = await prisma.feedbackOutbox.findMany({ where: { leaseOwner: token, state: 'PENDING' } });
    for (const row of mine) {
      try {
        const payload = safeJson(row.payloadJson);
        // Идентификатор известен заранее: повторная обработка не заведёт
        // второе уведомление об одном событии
        const notificationId = `fb-${row.id}`;
        const title = TITLES[row.kind] || 'Обращение';
        const number = Number(payload.number) || 0;
        const body = [number ? reportNumber(number) : '', String(payload.title || '')]
          .filter(Boolean).join(' · ').slice(0, 300);

        await prisma.$transaction(async (tx: any) => {
          const exists = await tx.notification.findUnique({ where: { id: notificationId } });
          if (!exists) {
            await tx.notification.create({
              data: {
                id: notificationId, userId: row.recipientId, category: 'ОБРАЩЕНИЯ',
                title, body, targetRoute: `/feedback?report=${row.reportId}`,
              },
            });
          }
          await tx.feedbackOutbox.update({
            where: { id: row.id }, data: { state: 'DONE', leaseUntil: null, leaseOwner: null },
          });
        });

        // Только после записи: сокет — ускорение, а не способ доставки
        pushToUser(row.recipientId, 'feedback:changed', { reportId: row.reportId, revision: row.publicRevision });
        pushToUser(row.recipientId, 'notify:new', {
          id: notificationId, userId: row.recipientId, category: 'ОБРАЩЕНИЯ',
          title, body, targetRoute: `/feedback?report=${row.reportId}`, isRead: false, createdAt: new Date(),
        });
        // Счётчик пересчитывается сервером, а не прибавляется в окне: окно не
        // знает, сколько ему видно, и прибавление быстро расходится с правдой
        try {
          const count = await unreadFor(row.recipientId, false);
          pushToUser(row.recipientId, 'feedback:unread', { count: count.total });
        } catch (__) { /* счётчик догонит опросом */ }
        taken++;
      } catch (_) {
        // Не вышло — отпускаем и пробуем позже. Совсем не вышло — запись
        // остаётся видимой в разборе, а не исчезает
        try {
          await prisma.feedbackOutbox.update({
            where: { id: row.id },
            data: {
              leaseOwner: null, leaseUntil: null,
              availableAt: new Date(Date.now() + backoffMs(row.attempt)),
              ...(row.attempt >= ATTEMPTS ? { state: 'FAILED' } : {}),
            },
          });
        } catch (__) { /* база недоступна — подберём на следующем проходе */ }
      }
    }
  } catch (_) { /* очередь не должна ронять сервер */ }
  return taken;
}

/** Запустить разбор очереди. Повторный вызов ничего не ломает. */
export function startOutbox(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (working) return; // проход длиннее интервала — не наслаиваем
    working = true;
    void drainOutbox().finally(() => { working = false; });
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopOutbox(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// База сменилась — клиент пересоздан, и проход, держащий прежний, надо
// перезапустить: это ровно тот случай, ради которого сброс и заведён
onDatabaseSwapped(() => { stopOutbox(); startOutbox(); });

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}
