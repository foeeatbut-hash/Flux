/**
 * Билет на подключение к игровому серверу.
 *
 * Билет — это пропуск, и устроен он как пропуск, а не как имя:
 *
 *   — **одноразовый.** Второй раз тот же билет не принимается: иначе один
 *     человек пустил бы по нему в матч кого угодно, просто переслав строку;
 *   — **со сроком.** Две минуты. Билет, действующий вечно, рано или поздно
 *     попадёт в чужие руки, а матч к тому времени давно кончится;
 *   — **в базе лежит только хеш.** Действующий пропуск в базе — это
 *     действующий пропуск у каждого, кто до базы дотянется. Сверяем хеш, а
 *     сам билет живёт ровно один раз: в ответе тому, кому он выдан.
 *
 * Выдаёт билеты платформа, предъявляет их игровой клиент, проверяет игровой
 * сервер — через платформу же (`redeem`). Так игра не хранит списка игроков и
 * не решает, кого пускать: это дело платформы.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS, PLAY_LIMITS } from '../../play/contracts.js';
import { fail } from './commands.js';

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Выдать билеты всем местам матча.
 *
 * Возвращает открытые билеты — единственный раз, когда они существуют в
 * открытом виде. Повторный вызов для того же места отдаёт новый билет и
 * гасит прежний: так «Переподключиться» работает, а старая ссылка перестаёт.
 */
export async function issueTickets(
  tx: any, sessionId: string, seats: Array<{ userId: string }>,
): Promise<Array<{ userId: string; token: string }>> {
  const out: Array<{ userId: string; token: string }> = [];
  const expiresAt = new Date(Date.now() + PLAY_LIMITS.ticketTtlMs);
  for (const seat of seats) {
    const token = randomBytes(24).toString('base64url');
    await tx.playTicket.deleteMany({ where: { sessionId, userId: seat.userId } });
    await tx.playTicket.create({
      data: { id: randomUUID(), sessionId, userId: seat.userId, tokenHash: hashOf(token), expiresAt },
    });
    out.push({ userId: seat.userId, token });
  }
  return out;
}

/** Выдать один билет заново: человек переподключается к идущему матчу. */
export async function reissueTicket(tx: any, sessionId: string, userId: string): Promise<string> {
  const [one] = await issueTickets(tx, sessionId, [{ userId }]);
  return one.token;
}

export interface Redeemed {
  sessionId: string;
  userId: string;
  team: number;
}

/**
 * Предъявить билет.
 *
 * Зовёт игровой сервер, а не игрок: игрок присылает строку, сервер спрашивает
 * платформу, кто это. Погашение и проверка — одно действие: между «проверили»
 * и «погасили» помещается второе предъявление того же билета.
 */
export async function redeemTicket(token: string): Promise<Redeemed> {
  const prisma = getPrisma();
  const tokenHash = hashOf(String(token || ''));

  // Гасим условно: строка изменилась — билет был наш и был не погашен.
  // Ноль строк — либо чужой, либо уже погашенный, и различать их не надо
  const res = await prisma.playTicket.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gte: new Date() } },
    data: { usedAt: new Date() },
  });
  if (!res?.count) fail(PLAY_ERRORS.NOT_FOUND, 'Билет недействителен');

  const ticket = await prisma.playTicket.findUnique({ where: { tokenHash } });
  const seat = await prisma.playSessionMember.findFirst({
    where: { sessionId: ticket.sessionId, userId: ticket.userId },
  });
  return { sessionId: ticket.sessionId, userId: ticket.userId, team: seat?.team || 1 };
}

/** Прибрать просроченные: они больше ни на что не годны. */
export async function sweepTickets(now = new Date()): Promise<number> {
  const prisma = getPrisma();
  const res = await prisma.playTicket.deleteMany({ where: { expiresAt: { lt: now } } });
  return res?.count || 0;
}
