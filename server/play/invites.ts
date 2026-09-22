/**
 * Приглашения в группу.
 *
 * Три решения, каждое из-за понятной беды:
 *
 *   1. **У приглашения есть срок.** Без него «приглашения» копятся годами, и
 *      человек, открыв платформу через месяц, видит десяток зовов в группы,
 *      которых давно нет. Просроченное не показывается и не принимается.
 *   2. **Живое приглашение на пару «группа — человек» одно.** Держит это
 *      частичный индекс: двойное нажатие не отправляет второго зова, а
 *      получает тот же ответ.
 *   3. **Принять — значит войти, и это одно действие.** Если принять
 *      приглашение и войти в группу разными шагами, между ними помещается
 *      сбой: приглашение принято, а человека в группе нет, и второй раз
 *      принять уже нельзя.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS, PLAY_LIMITS } from '../../play/contracts.js';
import { enqueue, fail, isDuplicate } from './commands.js';
import { joinParty, type PartyView } from './parties.js';

export interface InviteView {
  id: string;
  partyId: string;
  fromUserId: string;
  toUserId: string;
  state: string;
  expiresAt: Date;
}

/** Живые приглашения человека: просроченные не показываются. */
export async function inboxOf(userId: string): Promise<InviteView[]> {
  const prisma = getPrisma();
  return prisma.playInvite.findMany({
    where: { toUserId: userId, state: 'PENDING', expiresAt: { gte: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

/**
 * Позвать в группу.
 *
 * Зовёт только ведущий: иначе в группу можно было бы затащить кого угодно
 * руками любого её участника, и ведущий узнавал бы об этом последним.
 */
export async function sendInvite(
  tx: any, partyId: string, actorId: string, toUserId: string,
): Promise<InviteView> {
  if (toUserId === actorId) fail(PLAY_ERRORS.INVALID, 'Себя звать не надо — вы уже здесь');

  const party = await tx.playParty.findUnique({ where: { id: partyId } });
  if (!party || party.state !== 'ACTIVE') fail(PLAY_ERRORS.NOT_FOUND);
  if (party.leaderId !== actorId) fail(PLAY_ERRORS.FORBIDDEN, 'Звать в группу может только ведущий');

  const already = await tx.playPartyMember.findFirst({ where: { partyId, userId: toUserId, leftAt: null } });
  if (already) fail(PLAY_ERRORS.INVALID, 'Этот человек уже в группе');

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + PLAY_LIMITS.inviteTtlMs);
  try {
    await tx.playInvite.create({
      data: { id, partyId, fromUserId: actorId, toUserId, expiresAt },
    });
  } catch (e) {
    if (isDuplicate(e)) {
      // Живое приглашение уже есть — отдаём его. Это не ошибка, а тот же зов
      const twin = await tx.playInvite.findFirst({ where: { partyId, toUserId, state: 'PENDING' } });
      if (twin) return twin;
    }
    throw e;
  }

  await enqueue(tx, `invite:${id}:sent`, toUserId, 'invite', { inviteId: id, partyId, fromUserId: actorId });
  return tx.playInvite.findUnique({ where: { id } });
}

/**
 * Ответить на приглашение.
 *
 * Принять — это войти в группу в той же транзакции: разделив их, мы завели бы
 * состояние «принято, но не в группе», из которого нет выхода.
 */
export async function respondInvite(
  tx: any, inviteId: string, actorId: string, accept: boolean,
): Promise<{ invite: InviteView; party: PartyView | null }> {
  const invite = await tx.playInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.toUserId !== actorId) fail(PLAY_ERRORS.NOT_FOUND);
  if (invite.state !== 'PENDING') fail(PLAY_ERRORS.INVITE_GONE);
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    await tx.playInvite.update({ where: { id: inviteId }, data: { state: 'EXPIRED' } });
    fail(PLAY_ERRORS.INVITE_GONE);
  }

  await tx.playInvite.update({
    where: { id: inviteId },
    data: { state: accept ? 'ACCEPTED' : 'DECLINED', respondedAt: new Date() },
  });

  let party: PartyView | null = null;
  if (accept) party = await joinParty(tx, invite.partyId, actorId);

  await enqueue(
    tx, `invite:${inviteId}:answered`, invite.fromUserId, 'invite',
    { inviteId, accepted: accept, userId: actorId },
  );
  const updated = await tx.playInvite.findUnique({ where: { id: inviteId } });
  return { invite: updated, party };
}

/** Отозвать приглашение: может тот, кто звал, или ведущий группы. */
export async function cancelInvite(tx: any, inviteId: string, actorId: string): Promise<void> {
  const invite = await tx.playInvite.findUnique({ where: { id: inviteId } });
  if (!invite) fail(PLAY_ERRORS.NOT_FOUND);
  if (invite.state !== 'PENDING') return; // уже неживое — цель достигнута

  const party = await tx.playParty.findUnique({ where: { id: invite.partyId } });
  if (invite.fromUserId !== actorId && party?.leaderId !== actorId) fail(PLAY_ERRORS.FORBIDDEN);

  await tx.playInvite.update({
    where: { id: inviteId }, data: { state: 'CANCELLED', respondedAt: new Date() },
  });
  await enqueue(tx, `invite:${inviteId}:cancelled`, invite.toUserId, 'invite', { inviteId, cancelled: true });
}

/**
 * Пометить просроченные.
 *
 * Показывать их и так не показывают (отбор по сроку идёт при чтении), но
 * оставлять их вечно в состоянии PENDING нельзя: частичный индекс считает их
 * живыми, и позвать человека второй раз стало бы невозможно.
 */
export async function expireInvites(now = new Date()): Promise<number> {
  const prisma = getPrisma();
  const res = await prisma.playInvite.updateMany({
    where: { state: 'PENDING', expiresAt: { lt: now } },
    data: { state: 'EXPIRED', respondedAt: now },
  });
  return res?.count || 0;
}

/**
 * Отозвать все живые приглашения группы.
 *
 * Зовётся, когда группа закрывается: приглашение в несуществующую группу
 * человек принял бы и получил отказ без объяснения.
 */
export async function dropInvitesOfParty(tx: any, partyId: string): Promise<void> {
  await tx.playInvite.updateMany({
    where: { partyId, state: 'PENDING' },
    data: { state: 'CANCELLED', respondedAt: new Date() },
  });
}
