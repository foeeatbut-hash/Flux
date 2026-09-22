/**
 * Группа: постоянный состав, который вместе заходит в игру.
 *
 * Чего здесь намеренно нет — проверки «а нет ли у человека уже группы» перед
 * записью. Она бесполезна: сервер у каждого свой, база одна, и двое,
 * нажавших одновременно, оба прочитают «нет». Вместо неё стоит частичный
 * уникальный индекс, и отказ базы переводится в понятный код (`ALREADY_IN_PARTY`).
 * Проверка перед записью всё же делается — но только чтобы ответить человеку
 * словами в обычном случае, а не чтобы уберечь данные: уберегает индекс.
 *
 * Лидер — не привилегия, а обязанность: он единственный, кто может позвать и
 * выгнать. Когда лидер уходит, группа не распадается — обязанность переходит
 * к следующему по времени входа. Распад группы посреди подготовки к матчу
 * ощущается как поломка, хотя это «всего лишь» ушёл один человек.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS } from '../../play/contracts.js';
import { appendEvent, enqueue, fail, isDuplicate } from './commands.js';

export interface PartyView {
  id: string;
  leaderId: string;
  gameId: string | null;
  state: string;
  revision: number;
  members: Array<{ userId: string; role: string; joinedAt: Date }>;
}

/** Группа человека — та, из которой он ещё не вышел. */
export async function partyOf(userId: string): Promise<PartyView | null> {
  const prisma = getPrisma();
  const seat = await prisma.playPartyMember.findFirst({ where: { userId, leftAt: null } });
  if (!seat) return null;
  return viewOf(seat.partyId);
}

export async function viewOf(partyId: string): Promise<PartyView | null> {
  const prisma = getPrisma();
  const party = await prisma.playParty.findUnique({ where: { id: partyId } });
  if (!party || party.state !== 'ACTIVE') return null;
  const members = await prisma.playPartyMember.findMany({
    where: { partyId, leftAt: null },
    orderBy: { joinedAt: 'asc' },
    select: { userId: true, role: true, joinedAt: true },
  });
  return {
    id: party.id,
    leaderId: party.leaderId,
    gameId: party.gameId,
    state: party.state,
    revision: party.revision,
    members,
  };
}

/** Кто сейчас в группе — для рассылки: список нужен до изменения и после. */
async function memberIds(tx: any, partyId: string): Promise<string[]> {
  const rows = await tx.playPartyMember.findMany({
    where: { partyId, leftAt: null }, select: { userId: true },
  });
  return rows.map((r: any) => r.userId);
}

/**
 * Завести группу.
 *
 * Возвращает уже существующую, если человек в ней состоит: «создать» при
 * наличии группы — это почти всегда повтор запроса, а не просьба завести
 * вторую, и отвечать на него отказом значило бы пугать человека на ровном
 * месте.
 */
export async function createParty(tx: any, actorId: string, gameId: string | null): Promise<PartyView> {
  const seat = await tx.playPartyMember.findFirst({ where: { userId: actorId, leftAt: null } });
  if (seat) {
    const party = await tx.playParty.findUnique({ where: { id: seat.partyId } });
    if (party?.state === 'ACTIVE') return readInTx(tx, party.id);
  }

  const id = randomUUID();
  try {
    await tx.playParty.create({ data: { id, leaderId: actorId, gameId: gameId || null } });
    await tx.playPartyMember.create({
      data: { id: randomUUID(), partyId: id, userId: actorId, role: 'LEADER' },
    });
  } catch (e) {
    // Индекс не дал второй живой записи: значит, группа у человека уже есть —
    // её и отдаём, а не отказываем
    if (isDuplicate(e)) {
      const again = await tx.playPartyMember.findFirst({ where: { userId: actorId, leftAt: null } });
      if (again) return readInTx(tx, again.partyId);
    }
    throw e;
  }
  await appendEvent(tx, 'party', id, 1, 'created', { leaderId: actorId, gameId });
  return readInTx(tx, id);
}

/** Войти в группу по принятому приглашению. */
export async function joinParty(tx: any, partyId: string, userId: string): Promise<PartyView> {
  const party = await tx.playParty.findUnique({ where: { id: partyId } });
  if (!party || party.state !== 'ACTIVE') fail(PLAY_ERRORS.NOT_FOUND);

  const before = await memberIds(tx, partyId);
  try {
    await tx.playPartyMember.create({ data: { id: randomUUID(), partyId, userId, role: 'MEMBER' } });
  } catch (e) {
    if (isDuplicate(e)) {
      // Либо он уже здесь (тогда всё хорошо), либо он в ЧУЖОЙ группе
      const here = await tx.playPartyMember.findFirst({ where: { partyId, userId, leftAt: null } });
      if (here) return readInTx(tx, partyId);
      fail(PLAY_ERRORS.ALREADY_IN_PARTY);
    }
    throw e;
  }

  const revision = await bump(tx, partyId);
  await appendEvent(tx, 'party', partyId, revision, 'joined', { userId });
  for (const uid of [...before, userId]) {
    await enqueue(tx, `party:${partyId}:${revision}:${uid}`, uid, 'party', { partyId, revision });
  }
  return readInTx(tx, partyId);
}

/**
 * Выйти из группы.
 *
 * Уходит лидер — обязанность переходит к следующему по времени входа, а не
 * распускает группу: распад посреди подготовки ощущается как поломка.
 * Уходит последний — группа закрывается.
 */
export async function leaveParty(tx: any, partyId: string, userId: string): Promise<void> {
  const before = await memberIds(tx, partyId);
  const res = await tx.playPartyMember.updateMany({
    where: { partyId, userId, leftAt: null }, data: { leftAt: new Date() },
  });
  if (!res?.count) fail(PLAY_ERRORS.NOT_FOUND);

  const left = await memberIds(tx, partyId);
  const party = await tx.playParty.findUnique({ where: { id: partyId } });
  const revision = await bump(tx, partyId);

  if (!left.length) {
    await tx.playParty.update({ where: { id: partyId }, data: { state: 'CLOSED', closedAt: new Date() } });
    await appendEvent(tx, 'party', partyId, revision, 'closed', { reason: 'empty' });
  } else {
    if (party?.leaderId === userId) {
      await tx.playParty.update({ where: { id: partyId }, data: { leaderId: left[0] } });
      await tx.playPartyMember.updateMany({
        where: { partyId, userId: left[0], leftAt: null }, data: { role: 'LEADER' },
      });
      await appendEvent(tx, 'party', partyId, revision, 'leaderChanged', { userId: left[0] });
    } else {
      await appendEvent(tx, 'party', partyId, revision, 'left', { userId });
    }
  }

  for (const uid of before) {
    await enqueue(tx, `party:${partyId}:${revision}:${uid}`, uid, 'party', { partyId, revision });
  }
}

/** Выгнать из группы: только лидер и только не себя. */
export async function kickFromParty(tx: any, partyId: string, actorId: string, userId: string): Promise<void> {
  const party = await tx.playParty.findUnique({ where: { id: partyId } });
  if (!party || party.state !== 'ACTIVE') fail(PLAY_ERRORS.NOT_FOUND);
  if (party.leaderId !== actorId) fail(PLAY_ERRORS.FORBIDDEN, 'Выгонять может только ведущий группы');
  if (userId === actorId) fail(PLAY_ERRORS.INVALID, 'Себя выгнать нельзя — из группы выходят');
  await leaveParty(tx, partyId, userId);
}

/** Версия группы выросла: по ней спорят, кто опоздал. */
async function bump(tx: any, partyId: string): Promise<number> {
  const row = await tx.playParty.update({
    where: { id: partyId }, data: { revision: { increment: 1 } }, select: { revision: true },
  });
  return row.revision;
}

async function readInTx(tx: any, partyId: string): Promise<PartyView> {
  const party = await tx.playParty.findUnique({ where: { id: partyId } });
  const members = await tx.playPartyMember.findMany({
    where: { partyId, leftAt: null },
    orderBy: { joinedAt: 'asc' },
    select: { userId: true, role: true, joinedAt: true },
  });
  return {
    id: party.id,
    leaderId: party.leaderId,
    gameId: party.gameId,
    state: party.state,
    revision: party.revision,
    members,
  };
}
