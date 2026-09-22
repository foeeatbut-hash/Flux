/**
 * Снимок состояния: чем окно догоняет пропущенное после обрыва связи.
 *
 * Порядок восстановления задан ТЗ и важен целиком:
 *
 *   переавторизоваться → подписаться с буферизацией → получить снимок →
 *   применить события, которые новее версий в снимке.
 *
 * Наоборот нельзя. Если сначала взять снимок, а подписаться потом, в щель
 * между ними помещаются события, которых окно не увидит никогда. Если
 * применять события, не сравнивая версии, снимок затрёт то, что пришло после
 * него, — и лобби «забудет» уже нажатую готовность.
 *
 * Поэтому у каждого агрегата есть версия, и она приезжает в снимке. Всё, что
 * старее её, окно выбрасывает; всё, что новее, применяет поверх.
 */

import { getPrisma } from '../context.js';
import { viewFor } from './presence.js';
import { partyOf } from './parties.js';
import { lobbyOfParty } from './lobbies.js';
import { lastFinishedOf, sessionOf } from './sessions.js';
import { resultOf } from './results.js';
import type { PlaySnapshot } from '../../play/contracts.js';

/** Ключ версии агрегата в снимке: «party:<id>» и так далее. */
export const versionKey = (aggregate: string, id: string): string => `${aggregate}:${id}`;

/**
 * Всё, что человек должен увидеть сразу после подключения.
 *
 * Чужого здесь нет: группа своя, лобби своей группы, свой матч и свои
 * приглашения. Присутствие — только тех, с кем человек сейчас связан; список
 * всех сотрудников платформа не раздаёт.
 */
export async function snapshotFor(userId: string): Promise<PlaySnapshot> {
  const prisma = getPrisma();
  const versions: Record<string, number> = {};
  const at = Date.now();

  /**
   * Состояние собирается ТЕМИ ЖЕ читателями, что и ответы команд.
   *
   * Иначе у окна оказываются две разные формы одного и того же: команда
   * отдаёт лобби с местами и числом мест, а снимок — голую строку таблицы.
   * Экран, написанный по одной форме, падает на другой, и падает не сразу, а
   * при первом же переподключении — когда разбираться труднее всего.
   */
  const party = await partyOf(userId);
  if (party) versions[versionKey('party', party.id)] = party.revision;

  const lobby = party ? await lobbyOfParty(party.id) : null;
  if (lobby) versions[versionKey('lobby', lobby.id)] = lobby.revision;

  const session = await sessionOf(userId);
  if (session) versions[versionKey('session', session.id)] = session.revision;

  /**
   * Итог прошлого матча едет в снимке, а не докладывается окном отдельно.
   *
   * После матча мест `ACTIVE` не остаётся, и матч из снимка пропадает целиком:
   * окну, которое запоминало бы его само, хватило бы одной перезагрузки
   * страницы, чтобы счёт исчез. Снимок — единственный источник состояния, и
   * счёт обязан быть в нём.
   *
   * Показывается ровно «до следующего»: пока идёт новый матч, итог старого
   * убирается сам; ушёл человек из группы — лобби нет, и показывать итог не
   * при чем. Поэтому итог берётся только у матча ЭТОГО же лобби.
   */
  let result: PlaySnapshot['result'] = null;
  if (!session && lobby) {
    const done = await lastFinishedOf(userId);
    if (done && done.lobbyId === lobby.id) {
      const payload = await resultOf(done.id);
      if (payload) result = { sessionId: done.id, payload };
    }
  }

  const invites = await prisma.playInvite.findMany({
    where: { toUserId: userId, state: 'PENDING', expiresAt: { gte: new Date(at) } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  // Присутствие — только про тех, кого человек и так видит: свою группу и
  // свой матч. Раздавать список всех сотрудников платформа не должна
  const around = new Set<string>([userId]);
  for (const m of party?.members || []) around.add(m.userId);
  for (const m of session?.members || []) around.add(m.userId);
  const presence = await viewFor([...around], new Date(at));

  return {
    at,
    versions,
    party: party || null,
    lobby: lobby || null,
    session: session || null,
    result,
    invites,
    presence,
  };
}

/**
 * События агрегата новее известной версии.
 *
 * Нужно, когда окно было офлайн недолго: досылка дешевле снимка. Снимок при
 * этом остаётся обязательным путём — досылка его не заменяет, потому что
 * пропуск в истории событий обнаружить нечем, а версию в снимке — можно.
 */
export async function eventsSince(
  aggregate: string, aggregateId: string, afterVersion: number, limit = 200,
): Promise<any[]> {
  const prisma = getPrisma();
  return prisma.playEvent.findMany({
    where: { aggregate, aggregateId, version: { gt: afterVersion } },
    orderBy: { version: 'asc' },
    take: limit,
  });
}

/**
 * Нет ли в присланном окну хвосте пропусков.
 *
 * Версии идут подряд без дыр — это держит уникальный индекс. Дыра означает,
 * что часть событий не доехала, и досылкой обойтись уже нельзя: нужен снимок.
 */
export function isContiguous(versions: number[], from: number): boolean {
  let expect = from + 1;
  for (const v of versions) {
    if (v !== expect) return false;
    expect++;
  }
  return true;
}
