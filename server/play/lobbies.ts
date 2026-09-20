/**
 * Лобби: подготовка группы к матчу.
 *
 * Отдельного экрана у лобби нет — оно показывается тем же экраном подготовки,
 * что и группа (ТЗ §13.1). Два почти одинаковых окна, между которыми человека
 * перебрасывает, — это не два состояния, а одно, показанное дважды.
 *
 * Готовность снимается при любом изменении состава. Это не придирка: человек
 * нажал «Готов», пока в лобби было четверо, — и к пятому он готовности не
 * давал. Молчаливый перенос его отметки на новый состав означал бы, что матч
 * начался без его согласия.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS } from '../../play/contracts.js';
import { gameById } from '../../play/features.js';
import { appendEvent, bumpRevision, enqueue, fail, isDuplicate } from './commands.js';

export interface LobbyView {
  id: string;
  partyId: string;
  gameId: string;
  state: string;
  revision: number;
  slots: Array<{ userId: string; team: number; ready: boolean }>;
  /** Мест всего — по описанию игры */
  seats: number;
}

const ALIVE = ['FORMING', 'READY', 'STARTED'];

export async function lobbyOfParty(partyId: string): Promise<LobbyView | null> {
  const prisma = getPrisma();
  const lobby = await prisma.playLobby.findFirst({
    where: { partyId, state: { in: ALIVE } }, orderBy: { createdAt: 'desc' },
  });
  if (!lobby) return null;
  return readLobby(prisma, lobby.id);
}

async function readLobby(tx: any, lobbyId: string): Promise<LobbyView> {
  const lobby = await tx.playLobby.findUnique({ where: { id: lobbyId } });
  const slots = await tx.playLobbySlot.findMany({
    where: { lobbyId }, orderBy: { updatedAt: 'asc' },
    select: { userId: true, team: true, ready: true },
  });
  const game = gameById(lobby.gameId);
  return {
    id: lobby.id,
    partyId: lobby.partyId,
    gameId: lobby.gameId,
    state: lobby.state,
    revision: lobby.revision,
    slots,
    seats: game ? game.teams * game.teamSize : slots.length,
  };
}

/**
 * Открыть лобби по группе.
 *
 * Повторный вызов отдаёт уже открытое: «Подготовиться» при открытом лобби —
 * это повтор, а не просьба завести второе. Второго и не будет: не даст
 * частичный индекс.
 */
export async function openLobby(tx: any, partyId: string, actorId: string, gameId: string): Promise<LobbyView> {
  const party = await tx.playParty.findUnique({ where: { id: partyId } });
  if (!party || party.state !== 'ACTIVE') fail(PLAY_ERRORS.NOT_FOUND);
  if (party.leaderId !== actorId) fail(PLAY_ERRORS.FORBIDDEN, 'Готовить матч может только ведущий группы');
  if (!gameById(gameId)) fail(PLAY_ERRORS.INVALID, 'Неизвестная игра');

  const open = await tx.playLobby.findFirst({ where: { partyId, state: { in: ALIVE } } });
  if (open) return readLobby(tx, open.id);

  const id = randomUUID();
  try {
    await tx.playLobby.create({ data: { id, partyId, gameId } });
  } catch (e) {
    if (isDuplicate(e)) {
      const twin = await tx.playLobby.findFirst({ where: { partyId, state: { in: ALIVE } } });
      if (twin) return readLobby(tx, twin.id);
    }
    throw e;
  }

  // Места раздаются по составу группы: вошедший позже получит своё, когда
  // состав изменится (см. syncSlots)
  const members = await tx.playPartyMember.findMany({
    where: { partyId, leftAt: null }, orderBy: { joinedAt: 'asc' }, select: { userId: true },
  });
  const game = gameById(gameId)!;
  let n = 0;
  for (const m of members) {
    await tx.playLobbySlot.create({
      data: { id: randomUUID(), lobbyId: id, userId: m.userId, team: (n++ % game.teams) + 1 },
    });
  }

  await tx.playParty.update({ where: { id: partyId }, data: { gameId } });
  await appendEvent(tx, 'lobby', id, 1, 'opened', { partyId, gameId });
  for (const m of members) {
    await enqueue(tx, `lobby:${id}:1:${m.userId}`, m.userId, 'lobby', { lobbyId: id, revision: 1 });
  }
  return readLobby(tx, id);
}

/**
 * Привести места в соответствие с составом группы.
 *
 * Зовётся после любого изменения состава. Здесь же сбрасывается готовность:
 * человек давал её к прежнему составу, и переносить её молча на новый — это
 * начать матч без его согласия.
 */
export async function syncSlots(tx: any, lobbyId: string): Promise<LobbyView> {
  const lobby = await tx.playLobby.findUnique({ where: { id: lobbyId } });
  if (!lobby || !ALIVE.includes(lobby.state)) fail(PLAY_ERRORS.NOT_FOUND);

  const members = await tx.playPartyMember.findMany({
    where: { partyId: lobby.partyId, leftAt: null }, orderBy: { joinedAt: 'asc' }, select: { userId: true },
  });
  const want = new Set(members.map((m: any) => m.userId));
  const slots = await tx.playLobbySlot.findMany({ where: { lobbyId } });
  const have = new Set(slots.map((s: any) => s.userId));

  let changed = false;
  for (const s of slots) {
    if (!want.has(s.userId)) { await tx.playLobbySlot.delete({ where: { id: s.id } }); changed = true; }
  }
  const game = gameById(lobby.gameId);
  const teams = game?.teams || 2;
  let n = slots.length;
  for (const m of members) {
    if (have.has(m.userId)) continue;
    await tx.playLobbySlot.create({
      data: { id: randomUUID(), lobbyId, userId: m.userId, team: (n++ % teams) + 1 },
    });
    changed = true;
  }

  if (changed) {
    // Состав другой — готовность обнуляется у всех, включая тех, кто не
    // двигался: они соглашались играть не с этими людьми
    await tx.playLobbySlot.updateMany({ where: { lobbyId }, data: { ready: false } });
    const revision = await bumpLobby(tx, lobbyId, { state: 'FORMING' });
    await appendEvent(tx, 'lobby', lobbyId, revision, 'slotsChanged', {});
    for (const m of members) {
      await enqueue(tx, `lobby:${lobbyId}:${revision}:${m.userId}`, m.userId, 'lobby', { lobbyId, revision });
    }
  }
  return readLobby(tx, lobbyId);
}

/**
 * Отметить готовность.
 *
 * `expectedVersion` обязателен: между тем, как человек увидел лобби, и тем,
 * как он нажал, состав мог измениться. Опоздавшему отвечают отказом с текущим
 * состоянием, а не молча принимают его «готов» к другому составу.
 */
export async function setReady(
  tx: any, lobbyId: string, actorId: string, ready: boolean, expectedVersion: number,
): Promise<LobbyView> {
  const lobby = await tx.playLobby.findUnique({ where: { id: lobbyId } });
  if (!lobby || !ALIVE.includes(lobby.state)) fail(PLAY_ERRORS.NOT_FOUND);
  if (lobby.state === 'STARTED') fail(PLAY_ERRORS.SESSION_ACTIVE);
  if (lobby.revision !== expectedVersion) fail(PLAY_ERRORS.VERSION_CONFLICT, undefined, await readLobby(tx, lobbyId));

  const seat = await tx.playLobbySlot.findFirst({ where: { lobbyId, userId: actorId } });
  if (!seat) fail(PLAY_ERRORS.FORBIDDEN, 'Вас нет в этом лобби');

  await tx.playLobbySlot.update({ where: { id: seat.id }, data: { ready } });

  const slots = await tx.playLobbySlot.findMany({ where: { lobbyId } });
  const all = slots.length > 0 && slots.every((s: any) => s.ready);
  const ok = await bumpRevision(tx, 'playLobby', lobbyId, expectedVersion, { state: all ? 'READY' : 'FORMING' });
  if (!ok) fail(PLAY_ERRORS.VERSION_CONFLICT, undefined, await readLobby(tx, lobbyId));

  const revision = expectedVersion + 1;
  await appendEvent(tx, 'lobby', lobbyId, revision, 'ready', { userId: actorId, ready, all });
  for (const s of slots) {
    await enqueue(tx, `lobby:${lobbyId}:${revision}:${s.userId}`, s.userId, 'lobby', { lobbyId, revision });
  }
  return readLobby(tx, lobbyId);
}

/** Перевести человека в другую команду. Двигает только ведущий группы. */
export async function setTeam(
  tx: any, lobbyId: string, actorId: string, userId: string, team: number, expectedVersion: number,
): Promise<LobbyView> {
  const lobby = await tx.playLobby.findUnique({ where: { id: lobbyId } });
  if (!lobby || !ALIVE.includes(lobby.state)) fail(PLAY_ERRORS.NOT_FOUND);
  const party = await tx.playParty.findUnique({ where: { id: lobby.partyId } });
  if (party?.leaderId !== actorId) fail(PLAY_ERRORS.FORBIDDEN, 'Команды расставляет ведущий группы');

  const game = gameById(lobby.gameId);
  if (!game || team < 1 || team > game.teams) fail(PLAY_ERRORS.INVALID, 'Такой команды нет');

  const seat = await tx.playLobbySlot.findFirst({ where: { lobbyId, userId } });
  if (!seat) fail(PLAY_ERRORS.NOT_FOUND);

  await tx.playLobbySlot.update({ where: { id: seat.id }, data: { team, ready: false } });
  // Состав команд изменился — готовность обнуляется: соглашались играть в
  // другом построении
  await tx.playLobbySlot.updateMany({ where: { lobbyId }, data: { ready: false } });

  const ok = await bumpRevision(tx, 'playLobby', lobbyId, expectedVersion, { state: 'FORMING' });
  if (!ok) fail(PLAY_ERRORS.VERSION_CONFLICT, undefined, await readLobby(tx, lobbyId));

  const revision = expectedVersion + 1;
  await appendEvent(tx, 'lobby', lobbyId, revision, 'teamChanged', { userId, team });
  const slots = await tx.playLobbySlot.findMany({ where: { lobbyId }, select: { userId: true } });
  for (const s of slots) {
    await enqueue(tx, `lobby:${lobbyId}:${revision}:${s.userId}`, s.userId, 'lobby', { lobbyId, revision });
  }
  return readLobby(tx, lobbyId);
}

/** Закрыть лобби: матч кончился или группа распалась. */
export async function closeLobby(tx: any, lobbyId: string, reason: string): Promise<void> {
  const lobby = await tx.playLobby.findUnique({ where: { id: lobbyId } });
  if (!lobby || lobby.state === 'CLOSED') return;
  const slots = await tx.playLobbySlot.findMany({ where: { lobbyId }, select: { userId: true } });
  const revision = await bumpLobby(tx, lobbyId, { state: 'CLOSED' });
  await appendEvent(tx, 'lobby', lobbyId, revision, 'closed', { reason });
  for (const s of slots) {
    await enqueue(tx, `lobby:${lobbyId}:${revision}:${s.userId}`, s.userId, 'lobby', { lobbyId, revision });
  }
}

async function bumpLobby(tx: any, lobbyId: string, data: Record<string, unknown>): Promise<number> {
  const row = await tx.playLobby.update({
    where: { id: lobbyId }, data: { ...data, revision: { increment: 1 } }, select: { revision: true },
  });
  return row.revision;
}
