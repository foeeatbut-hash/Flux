/**
 * Матч: от «все готовы» до результата.
 *
 * Самое опасное место платформы, и вот почему. Между «лобби готово» и «матч
 * идёт» лежит обращение к чужому процессу — игровому серверу, — а чужой
 * процесс отвечает медленно, не отвечает вовсе или отвечает дважды. Поэтому:
 *
 *   1. **Запись о матче появляется ДО обращения к игре**, в состоянии
 *      ALLOCATING. Частичный индекс не даст завести второй по тому же лобби:
 *      повторное «Начать» присоединится к уже начатому, а не разведёт группу
 *      по двум серверам.
 *   2. **Выделение сервера идёт ВНЕ транзакции.** Держать транзакцию
 *      открытой, пока отвечает чужой процесс, — верный способ заблокировать
 *      базу на тайм-ауте.
 *   3. **Не вышло — матч отменяется явно**, с причиной, и лобби возвращается
 *      в подготовку. Запись, зависшая в ALLOCATING, — это лобби, из которого
 *      больше никогда нельзя начать.
 *
 * Жизненный цикл здесь, выделение сервера — в адаптере игры: это сознательно
 * разные файлы, чтобы вторая игра встала на то же место без правки цикла.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS } from '../../play/contracts.js';
import { gameById } from '../../play/features.js';
import { appendEvent, enqueue, fail, isDuplicate } from './commands.js';
import { platformState } from './access.js';
import { adapterFor } from './adapters/contract.js';
import { closeLobby } from './lobbies.js';
import { issueTickets, reissueTicket } from './tickets.js';

export interface SessionView {
  id: string;
  lobbyId: string;
  gameId: string;
  state: string;
  serverAddr: string;
  revision: number;
  members: Array<{ userId: string; team: number; state: string }>;
}

const LIVE = ['ALLOCATING', 'RUNNING'];

export async function sessionOf(userId: string): Promise<SessionView | null> {
  const prisma = getPrisma();
  const seat = await prisma.playSessionMember.findFirst({ where: { userId, state: 'ACTIVE' } });
  if (!seat) return null;
  return readSession(prisma, seat.sessionId);
}

/**
 * Последний законченный матч этого человека.
 *
 * Нужен ради одной вещи: после матча мест со `state:'ACTIVE'` не остаётся, и
 * `sessionOf` честно отвечает «нет». Если на этом остановиться, окну будет
 * неоткуда узнать, чем кончился матч, из которого человек только что вышел, —
 * и счёт не покажет никто. Поэтому законченный матч ищется отдельно и только
 * свой: смотрим места самого спрашивающего, а не чужие.
 */
export async function lastFinishedOf(userId: string): Promise<SessionView | null> {
  const prisma = getPrisma();
  const seats = await prisma.playSessionMember.findMany({
    where: { userId, state: 'FINISHED' },
    orderBy: { joinedAt: 'desc' },
    take: 5,
  });
  for (const seat of seats) {
    const s = await prisma.playSession.findUnique({ where: { id: seat.sessionId } });
    if (s?.state === 'FINISHED') return readSession(prisma, s.id);
  }
  return null;
}

async function readSession(tx: any, sessionId: string): Promise<SessionView> {
  const s = await tx.playSession.findUnique({ where: { id: sessionId } });
  const members = await tx.playSessionMember.findMany({
    where: { sessionId }, orderBy: { joinedAt: 'asc' },
    select: { userId: true, team: true, state: true },
  });
  return {
    id: s.id, lobbyId: s.lobbyId, gameId: s.gameId, state: s.state,
    serverAddr: s.serverAddr, revision: s.revision, members,
  };
}

/**
 * Завести матч по готовому лобби.
 *
 * Возвращает уже идущий, если он есть: «Начать» при идущем матче — это повтор
 * или второе нажатие, а не просьба завести второй.
 */
export async function claimSession(
  tx: any, lobbyId: string, actorId: string, expectedVersion: number,
): Promise<{ session: SessionView; tickets: Array<{ userId: string; token: string }>; fresh: boolean }> {
  const lobby = await tx.playLobby.findUnique({ where: { id: lobbyId } });
  if (!lobby) fail(PLAY_ERRORS.NOT_FOUND);

  const running = await tx.playSession.findFirst({ where: { lobbyId, state: { in: LIVE } } });
  if (running) {
    return { session: await readSession(tx, running.id), tickets: [], fresh: false };
  }

  const party = await tx.playParty.findUnique({ where: { id: lobby.partyId } });
  if (party?.leaderId !== actorId) fail(PLAY_ERRORS.FORBIDDEN, 'Начинать матч может только ведущий группы');
  if (lobby.revision !== expectedVersion) {
    fail(PLAY_ERRORS.VERSION_CONFLICT);
  }

  // Обслуживание проверяется здесь, а не только кнопкой в окне: кнопка — это
  // вежливость, а запрет должен стоять там, где матч заводится
  const platform = await platformState();
  if (platform.maintenance) fail(PLAY_ERRORS.MAINTENANCE);

  const slots = await tx.playLobbySlot.findMany({ where: { lobbyId } });
  if (!slots.length) fail(PLAY_ERRORS.INVALID, 'В лобби никого нет');
  if (!slots.every((s: any) => s.ready)) fail(PLAY_ERRORS.NOT_READY);
  if (!adapterFor(lobby.gameId)) {
    fail(PLAY_ERRORS.UNSUPPORTED, 'Эта игра ещё не подключена к платформе');
  }

  const sessionId = randomUUID();
  try {
    await tx.playSession.create({ data: { id: sessionId, lobbyId, gameId: lobby.gameId } });
  } catch (e) {
    // Индекс не дал второго живого матча: значит, кто-то успел раньше —
    // присоединяемся к его матчу, а не заводим свой
    if (isDuplicate(e)) {
      const twin = await tx.playSession.findFirst({ where: { lobbyId, state: { in: LIVE } } });
      if (twin) return { session: await readSession(tx, twin.id), tickets: [], fresh: false };
    }
    throw e;
  }

  for (const s of slots) {
    try {
      await tx.playSessionMember.create({
        data: { id: randomUUID(), sessionId, userId: s.userId, team: s.team, state: 'ACTIVE' },
      });
    } catch (e) {
      // Человек уже в другом незавершённом матче: начинать этот нельзя —
      // половина группы ушла бы в один матч, а он остался бы в другом
      if (isDuplicate(e)) fail(PLAY_ERRORS.SESSION_ACTIVE, 'Кто-то из группы уже в матче');
      throw e;
    }
  }

  const tickets = await issueTickets(tx, sessionId, slots.map((s: any) => ({ userId: s.userId })));

  await tx.playLobby.update({
    where: { id: lobbyId }, data: { state: 'STARTED', revision: { increment: 1 } },
  });
  await appendEvent(tx, 'session', sessionId, 1, 'claimed', { lobbyId, gameId: lobby.gameId });
  for (const s of slots) {
    await enqueue(tx, `session:${sessionId}:1:${s.userId}`, s.userId, 'session', { sessionId, revision: 1 });
  }
  return { session: await readSession(tx, sessionId), tickets, fresh: true };
}

/**
 * Выделить сервер и объявить матч идущим.
 *
 * Вне транзакции намеренно: чужой процесс отвечает когда захочет, а
 * транзакция, открытая на время его раздумий, держит базу.
 */
export async function allocateServer(sessionId: string): Promise<SessionView> {
  const prisma = getPrisma();
  const session = await prisma.playSession.findUnique({ where: { id: sessionId } });
  if (!session) fail(PLAY_ERRORS.NOT_FOUND);
  if (session.state !== 'ALLOCATING') return readSession(prisma, sessionId);

  const adapter = adapterFor(session.gameId);
  if (!adapter) {
    await cancelSession(sessionId, 'игра не подключена');
    fail(PLAY_ERRORS.UNSUPPORTED);
  }

  const members = await prisma.playSessionMember.findMany({
    where: { sessionId }, select: { userId: true, team: true },
  });

  let allocated;
  try {
    allocated = await adapter!.allocate({ sessionId, seats: members });
  } catch (e: any) {
    // Не вышло — отменяем явно и с причиной. Запись, зависшая в ALLOCATING,
    // это лобби, из которого больше никогда нельзя начать
    await cancelSession(sessionId, `сервер игры не отозвался: ${e?.message || e}`);
    fail(PLAY_ERRORS.UNSUPPORTED, 'Сервер игры не отозвался');
  }

  await prisma.$transaction(async (tx: any) => {
    await tx.playSession.update({
      where: { id: sessionId },
      data: {
        state: 'RUNNING',
        serverAddr: allocated!.address,
        startedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    const row = await tx.playSession.findUnique({ where: { id: sessionId }, select: { revision: true } });
    await appendEvent(tx, 'session', sessionId, row.revision, 'running', { address: allocated!.address });
    for (const m of members) {
      await enqueue(
        tx, `session:${sessionId}:${row.revision}:${m.userId}`, m.userId, 'session',
        { sessionId, revision: row.revision },
      );
    }
  });
  return readSession(prisma, sessionId);
}

/** Матч кончился: результат уже записан, места освобождены. */
export async function finishSession(sessionId: string): Promise<void> {
  const prisma = getPrisma();
  const session = await prisma.playSession.findUnique({ where: { id: sessionId } });
  if (!session || session.state === 'FINISHED' || session.state === 'CANCELLED') return;

  const members = await prisma.playSessionMember.findMany({ where: { sessionId }, select: { userId: true } });
  await prisma.$transaction(async (tx: any) => {
    await tx.playSession.update({
      where: { id: sessionId },
      data: { state: 'FINISHED', finishedAt: new Date(), revision: { increment: 1 } },
    });
    // Места освобождаются: иначе человек остался бы «в матче» навсегда, и
    // следующий матч ему бы не завели
    await tx.playSessionMember.updateMany({ where: { sessionId }, data: { state: 'FINISHED' } });
    const row = await tx.playSession.findUnique({ where: { id: sessionId }, select: { revision: true } });
    await appendEvent(tx, 'session', sessionId, row.revision, 'finished', {});
    for (const m of members) {
      await enqueue(
        tx, `session:${sessionId}:${row.revision}:${m.userId}`, m.userId, 'session',
        { sessionId, revision: row.revision },
      );
    }
    // Лобби возвращается в подготовку: отсюда и делается «Ещё раз»
    await tx.playLobby.updateMany({
      where: { id: session.lobbyId, state: 'STARTED' },
      data: { state: 'FORMING', revision: { increment: 1 } },
    });
    await tx.playLobbySlot.updateMany({ where: { lobbyId: session.lobbyId }, data: { ready: false } });
  });

  const adapter = adapterFor(session.gameId);
  try { await adapter?.release(sessionId, session.serverAddr); } catch (_) { /* сервер отпустится сам */ }
}

/** Отменить матч: сервер не выделился, обслуживание, разбор зависшего. */
export async function cancelSession(sessionId: string, reason: string): Promise<void> {
  const prisma = getPrisma();
  const session = await prisma.playSession.findUnique({ where: { id: sessionId } });
  if (!session || session.state === 'FINISHED' || session.state === 'CANCELLED') return;
  const members = await prisma.playSessionMember.findMany({ where: { sessionId }, select: { userId: true } });

  await prisma.$transaction(async (tx: any) => {
    await tx.playSession.update({
      where: { id: sessionId },
      data: { state: 'CANCELLED', finishedAt: new Date(), revision: { increment: 1 } },
    });
    await tx.playSessionMember.updateMany({ where: { sessionId }, data: { state: 'LEFT' } });
    const row = await tx.playSession.findUnique({ where: { id: sessionId }, select: { revision: true } });
    await appendEvent(tx, 'session', sessionId, row.revision, 'cancelled', { reason });
    for (const m of members) {
      await enqueue(
        tx, `session:${sessionId}:${row.revision}:${m.userId}`, m.userId, 'session',
        { sessionId, revision: row.revision, reason },
      );
    }
    await tx.playLobby.updateMany({
      where: { id: session.lobbyId, state: 'STARTED' },
      data: { state: 'FORMING', revision: { increment: 1 } },
    });
    await tx.playLobbySlot.updateMany({ where: { lobbyId: session.lobbyId }, data: { ready: false } });
  });

  try { await adapterFor(session.gameId)?.release(sessionId, session.serverAddr); } catch (_) { /* уже отпущен */ }
}

/**
 * Новый билет на идущий матч.
 *
 * Это и есть «Вернуться в игру»: человек закрыл игру или потерял связь, матч
 * при этом идёт. Старый билет гасится — иначе по нему мог бы зайти кто-то ещё.
 */
export async function rejoin(actorId: string): Promise<{ session: SessionView; ticket: string }> {
  const prisma = getPrisma();
  const seat = await prisma.playSessionMember.findFirst({ where: { userId: actorId, state: 'ACTIVE' } });
  if (!seat) fail(PLAY_ERRORS.NOT_FOUND);
  const session = await prisma.playSession.findUnique({ where: { id: seat.sessionId } });
  if (!session || session.state !== 'RUNNING') fail(PLAY_ERRORS.NOT_FOUND);
  const ticket = await prisma.$transaction((tx: any) => reissueTicket(tx, seat.sessionId, actorId));
  return { session: await readSession(prisma, seat.sessionId), ticket };
}

/** Группа распалась — лобби и матч закрываются следом, а не висят. */
export async function closeAround(tx: any, partyId: string): Promise<void> {
  const lobby = await tx.playLobby.findFirst({
    where: { partyId, state: { in: ['FORMING', 'READY', 'STARTED'] } },
  });
  if (lobby) await closeLobby(tx, lobby.id, 'группа распалась');
}
