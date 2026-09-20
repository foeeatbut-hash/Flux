/**
 * Присутствие: правдивое «в сети», а не факт открытого сокета.
 *
 * Почему не как раньше. Прежнее присутствие жило в памяти сервера, а сервер у
 * каждого сотрудника свой — и каждый сидел в своей комнате один: в чате все
 * всегда были «не в сети». Это чинили переездом в базу. Но и в базе остаётся
 * вторая беда, из-за которой присутствию нельзя верить: обрыв связи бывает
 * беззвучным. Сокет не закрывается, `disconnect` не приходит, и человек висит
 * «онлайн» до перезапуска сервера.
 *
 * Отсюда два решения, и оба обязательны:
 *
 *   1. **Аренда вместо флага.** Запись живёт до `expiresAt`; окно продлевает
 *      её сердцебиением раз в десять секунд, аренда выдаётся на тридцать.
 *      Пропал — аренда кончилась сама, и никого не надо «выключать».
 *      Ложного «в сети» не остаётся даже после падения сервера.
 *   2. **Поколение соединения.** У окна бывает два соединения подряд:
 *      переподключение заводит новое, а `disconnect` старого приходит ПОСЛЕ
 *      него. Без поколения этот поздний disconnect погасил бы уже живое
 *      соединение — человек мигал бы «ушёл — пришёл» на ровном месте.
 *
 * Состояний четыре, и они независимы (ТЗ §7): соединение, занятость, выбор
 * «не показываться» и игра. Слияние их в одно `isOnline` и было той ложью,
 * с которой всё начиналось.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_LIMITS, type PlayActivity, type PlayStatus } from '../../play/contracts.js';

export interface PresenceView {
  userId: string;
  status: PlayStatus;
  activity: PlayActivity;
  gameId: string | null;
  /** Когда запись перестанет быть действительной */
  expiresAt: number;
  /** Сколько устройств этого человека сейчас на связи */
  devices: number;
}

/**
 * Открылось соединение.
 *
 * Поколение растёт на каждое соединение этого устройства: по нему поздний
 * `disconnect` предыдущего узнаётся и игнорируется.
 */
export async function connect(opts: {
  userId: string; deviceId: string; connectionId: string; invisible?: boolean;
}): Promise<number> {
  const prisma = getPrisma();
  const now = Date.now();
  const last = await prisma.playPresence.findFirst({
    where: { userId: opts.userId, deviceId: opts.deviceId },
    orderBy: { generation: 'desc' },
    select: { generation: true },
  });
  const generation = (Number(last?.generation) || 0) + 1;

  await prisma.playPresence.upsert({
    where: { connectionId: opts.connectionId },
    create: {
      id: randomUUID(),
      userId: opts.userId,
      deviceId: opts.deviceId,
      connectionId: opts.connectionId,
      generation,
      status: opts.invisible ? 'INVISIBLE' : 'ONLINE',
      activity: 'IDLE',
      expiresAt: new Date(now + PLAY_LIMITS.presenceLeaseMs),
    },
    update: {
      generation,
      status: opts.invisible ? 'INVISIBLE' : 'ONLINE',
      expiresAt: new Date(now + PLAY_LIMITS.presenceLeaseMs),
    },
  });
  return generation;
}

/**
 * Сердцебиение: продлить аренду.
 *
 * Возвращает `false`, если записи уже нет, — тогда окно переподключается, а не
 * делает вид, что всё хорошо. Молчаливое «ничего не обновилось» здесь и есть
 * ложный онлайн.
 */
export async function heartbeat(connectionId: string, patch?: {
  status?: PlayStatus; activity?: PlayActivity; gameId?: string | null;
}): Promise<boolean> {
  const prisma = getPrisma();
  const res = await prisma.playPresence.updateMany({
    where: { connectionId },
    data: {
      expiresAt: new Date(Date.now() + PLAY_LIMITS.presenceLeaseMs),
      ...(patch?.status ? { status: patch.status } : {}),
      ...(patch?.activity ? { activity: patch.activity } : {}),
      ...(patch?.gameId !== undefined ? { gameId: patch.gameId } : {}),
    },
  });
  return (res?.count || 0) > 0;
}

/**
 * Соединение закрылось.
 *
 * Запись удаляется, только если её поколение то же самое. Поздний
 * `disconnect` старого соединения приходит уже после того, как окно
 * переподключилось, — и без этой проверки он погасил бы новое.
 */
export async function disconnect(connectionId: string, generation: number): Promise<boolean> {
  const prisma = getPrisma();
  const res = await prisma.playPresence.deleteMany({ where: { connectionId, generation } });
  return (res?.count || 0) > 0;
}

/** Подмести протухшие аренды. Возвращает, сколько записей убрано. */
export async function sweep(now = new Date()): Promise<number> {
  const prisma = getPrisma();
  const res = await prisma.playPresence.deleteMany({ where: { expiresAt: { lt: now } } });
  return res?.count || 0;
}

/**
 * Что видно про людей.
 *
 * Протухшие аренды не показываются, даже если их ещё не подмели: показанное
 * должно быть правдой в момент показа, а не в момент последней уборки.
 *
 * `INVISIBLE` — выбор человека, и он сильнее всего: если хоть одно его
 * устройство просит не показываться, наружу уходит «не в сети». Иначе
 * «невидимость», включённая на ноутбуке, отменялась бы забытым телефоном.
 */
export async function viewFor(userIds: string[], now = new Date()): Promise<PresenceView[]> {
  const prisma = getPrisma();
  if (!userIds.length) return [];
  const rows = await prisma.playPresence.findMany({
    where: { userId: { in: userIds }, expiresAt: { gte: now } },
  });

  const byUser = new Map<string, any[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) || [];
    list.push(r);
    byUser.set(r.userId, list);
  }

  const out: PresenceView[] = [];
  for (const userId of userIds) {
    const list = byUser.get(userId) || [];
    if (!list.length) {
      out.push({ userId, status: 'OFFLINE', activity: 'IDLE', gameId: null, expiresAt: 0, devices: 0 });
      continue;
    }
    const hidden = list.some((r) => r.status === 'INVISIBLE');
    // Занятость берём самую «глубокую»: человек в матче с одного устройства
    // занят, даже если со второго просто открыл программу
    const rank: Record<string, number> = { IDLE: 0, LOBBY: 1, MATCH: 2 };
    const busiest = list.reduce((a, b) => ((rank[b.activity] || 0) > (rank[a.activity] || 0) ? b : a));
    const away = list.every((r) => r.status === 'AWAY');
    out.push({
      userId,
      status: hidden ? 'OFFLINE' : away ? 'AWAY' : 'ONLINE',
      activity: hidden ? 'IDLE' : (busiest.activity as PlayActivity),
      gameId: hidden ? null : (busiest.gameId || null),
      expiresAt: Math.max(...list.map((r) => new Date(r.expiresAt).getTime())),
      devices: hidden ? 0 : list.length,
    });
  }
  return out;
}

/**
 * Показанному можно верить.
 *
 * Предел взят из договора (ТЗ): больше аренды на один интервал сердцебиения.
 * Один потерянный пакет — не повод объявлять человека ушедшим, два подряд —
 * уже повод.
 */
export const isFresh = (at: number, now = Date.now()): boolean =>
  now - at <= PLAY_LIMITS.staleAfterMs;
