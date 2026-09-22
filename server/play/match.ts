/**
 * Встроенная игра: доска на сервере, ход — команда.
 *
 * Внешняя игра живёт своим процессом и присылает подписанный результат. У
 * настольных игр процесса нет, и заманчиво было бы считать ход в окне, а на
 * сервер присылать готовое состояние. Так делать нельзя ровно по той причине,
 * которая уже записана в договоре внешней игры: «игрок, присылающий свой счёт,
 * рано или поздно пришлёт тот, который ему нравится».
 *
 * Поэтому сюда приходит ХОД, а не доска. Сервер проверяет его теми же чистыми
 * правилами (`play/games/*`), которыми окно подсвечивает разрешённое,
 * применяет и отдаёт новое состояние. Окно правил не решает — оно их читает.
 *
 * Три вещи взяты у остальной платформы, потому что они там отработаны:
 *
 *   — **повтор — не второй ход.** У хода ключ идемпотентности и расписка
 *     (`runCommand`): два нажатия подряд дают один ход;
 *   — **опоздавший не затирает.** Ход применяется условным обновлением по
 *     `revision`; пришедший на старую версию получает VERSION_CONFLICT;
 *   — **окно узнаёт из снимка.** Событие по сокету говорит только «поменялось».
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS, type PlayCommandReceipt } from '../../play/contracts.js';
import { appendEvent, enqueue, fail, runCommand, stableJson } from './commands.js';
import { rulesOf } from '../../play/games/kit.js';
import { finishSession } from './sessions.js';
import '../../play/games/all.js';

/** Состояние партии так, как его видит окно. */
export interface MatchView {
  sessionId: string;
  gameId: string;
  revision: number;
  /** Кто ходит сейчас; пусто — партия кончилась */
  turnUserId: string;
  /** Ваш ли ход — чтобы окно не сравнивало имена само */
  yourTurn: boolean;
  /** Состояние глазами этого игрока: скрытое не отдаётся */
  view: unknown;
  done: boolean;
  winnerTeam: number;
  why: string;
  /** Места в порядке команд: первый ходит первым */
  seats: string[];
}

const safeJson = (text: string): any => {
  try { return JSON.parse(text || 'null'); } catch (_) { return null; }
};

/**
 * Завести доску под матч.
 *
 * Зовётся при выделении «сервера»: у встроенной игры сервер — это мы сами, и
 * выделять нечего, кроме начального состояния. Повторный вызов ничего не
 * портит: доска у матча одна, и держит это уникальный индекс.
 */
export async function openMatch(sessionId: string, gameId: string, seats: string[], seed: string): Promise<void> {
  const rules = rulesOf(gameId);
  if (!rules) fail(PLAY_ERRORS.UNSUPPORTED, `Встроенной игры «${gameId}» нет`);
  const prisma = getPrisma();
  const state = rules!.init(seed, seats);
  try {
    await prisma.playMatch.create({
      data: {
        id: randomUUID(), sessionId, gameId, seed,
        seatsJson: JSON.stringify(seats),
        stateJson: stableJson(state as any),
        revision: 1,
      },
    });
  } catch (_) {
    // Доска уже заведена — второй раз начинать партию заново нельзя: это
    // стёрло бы сделанные ходы
  }
}

/** Доска матча глазами игрока. Нет доски — пусто, и решает это вызывающий. */
export async function matchView(sessionId: string, userId: string): Promise<MatchView | null> {
  const prisma = getPrisma();
  const row = await prisma.playMatch.findFirst({ where: { sessionId } });
  if (!row) return null;
  const rules = rulesOf(row.gameId);
  if (!rules) return null;

  const state = safeJson(row.stateJson);
  const outcome = rules.outcome(state);
  const turnUserId = rules.turnOf(state);
  return {
    sessionId, gameId: row.gameId, revision: row.revision,
    turnUserId, yourTurn: !!turnUserId && turnUserId === userId,
    view: rules.viewOf(state, userId),
    done: outcome.done, winnerTeam: outcome.winnerTeam, why: outcome.why,
    seats: safeJson(row.seatsJson) || [],
  };
}

export interface MoveResult { revision: number; done: boolean; why: string }

/**
 * Сделать ход.
 *
 * `expectedRevision` — версия доски, которую видел игрок. Пришёл на старую —
 * значит, соперник успел раньше, и ход не применяется: иначе второй ход лёг бы
 * поверх первого, и оба игрока увидели бы разные доски.
 */
export async function makeMove(
  sessionId: string, userId: string, move: unknown, key: string, expectedRevision?: number,
): Promise<PlayCommandReceipt<MoveResult>> {
  return runCommand<MoveResult>({
    actorId: userId, key, kind: 'match.move',
    body: { sessionId, move, expectedRevision },
    work: async (tx) => {
      const row = await tx.playMatch.findFirst({ where: { sessionId } });
      if (!row) fail(PLAY_ERRORS.NOT_FOUND, 'Партия не найдена');

      const rules = rulesOf(row.gameId);
      if (!rules) fail(PLAY_ERRORS.UNSUPPORTED);

      if (expectedRevision !== undefined && expectedRevision !== row.revision) {
        fail(PLAY_ERRORS.VERSION_CONFLICT, 'Доска уже изменилась — посмотрите её заново');
      }

      const seats: string[] = safeJson(row.seatsJson) || [];
      if (!seats.includes(userId)) fail(PLAY_ERRORS.FORBIDDEN, 'Вы не за этой доской');

      const state = safeJson(row.stateJson);
      // Отказ возвращается СЛОВАМИ самой игры: «не ваш ход» и «сюда нельзя,
      // ничего не переворачивается» — разные вещи, и человек должен видеть,
      // какая из них случилась
      const why = rules!.why(state, userId, move);
      if (why) fail(PLAY_ERRORS.INVALID, why);

      const next = rules!.apply(state, userId, move);
      const outcome = rules!.outcome(next);

      // Условное обновление: между чтением и записью доску мог сдвинуть сосед
      const moved = await tx.playMatch.updateMany({
        where: { id: row.id, revision: row.revision },
        data: { stateJson: stableJson(next as any), revision: { increment: 1 }, updatedAt: new Date() },
      });
      if (!moved.count) fail(PLAY_ERRORS.VERSION_CONFLICT, 'Доска уже изменилась — посмотрите её заново');

      const revision = row.revision + 1;
      await appendEvent(tx, 'match', sessionId, revision, 'moved', { by: userId });
      for (const seat of seats) {
        await enqueue(tx, `match:${sessionId}:${revision}:${seat}`, seat, 'match', { sessionId, revision });
      }

      /**
       * Партия кончилась — результат пишем здесь же.
       *
       * Подписывать нечего: он никуда не уезжал и посчитан теми же правилами,
       * которыми шла партия. Завершение матча делает отдельный проход после
       * транзакции: внутри неё висит блокировка, а `finishSession` ходит в
       * несколько таблиц и в адаптер.
       */
      if (outcome.done) {
        try {
          await tx.playResult.create({
            data: {
              id: randomUUID(), sessionId,
              payloadJson: stableJson({ winnerTeam: outcome.winnerTeam, details: outcome.details, why: outcome.why }),
              signature: 'builtin',
            },
          });
        } catch (_) { /* результат уже записан — повтор счёт не удваивает */ }
      }

      return { revision, done: outcome.done, why: outcome.why };
    },
  }).then(async (receipt) => {
    // Завершение — после транзакции и только по настоящему концу партии
    if (receipt.ok && receipt.result?.done) {
      try { await finishSession(sessionId); } catch (_) { /* разберёт обслуживание */ }
    }
    return receipt;
  });
}

/**
 * Сдаться.
 *
 * Отдельным действием, а не ходом: у половины игр «сдаться» ходом не
 * выражается, а бросить матч посреди партии человек вправе — иначе соперник
 * будет ждать его до вечера.
 */
export async function resign(sessionId: string, userId: string, key: string): Promise<PlayCommandReceipt<MoveResult>> {
  return runCommand<MoveResult>({
    actorId: userId, key, kind: 'match.resign',
    body: { sessionId },
    work: async (tx) => {
      const row = await tx.playMatch.findFirst({ where: { sessionId } });
      if (!row) fail(PLAY_ERRORS.NOT_FOUND, 'Партия не найдена');
      const seats: string[] = safeJson(row.seatsJson) || [];
      const mine = seats.indexOf(userId);
      if (mine < 0) fail(PLAY_ERRORS.FORBIDDEN, 'Вы не за этой доской');

      // Победил тот, кто остался. В одиночной игре победителя нет вовсе
      const winnerTeam = seats.length > 1 ? (mine === 0 ? 2 : 1) : 0;
      const why = seats.length > 1 ? 'Соперник сдался' : 'Партия брошена';

      const revision = row.revision + 1;
      await tx.playMatch.updateMany({
        where: { id: row.id, revision: row.revision },
        data: { revision: { increment: 1 }, resignedBy: userId, updatedAt: new Date() },
      });
      await appendEvent(tx, 'match', sessionId, revision, 'resigned', { by: userId });
      for (const seat of seats) {
        await enqueue(tx, `match:${sessionId}:${revision}:${seat}`, seat, 'match', { sessionId, revision });
      }
      try {
        await tx.playResult.create({
          data: {
            id: randomUUID(), sessionId,
            payloadJson: stableJson({ winnerTeam, details: { resignedBy: userId }, why }),
            signature: 'builtin',
          },
        });
      } catch (_) { /* результат уже записан */ }
      return { revision, done: true, why };
    },
  }).then(async (receipt) => {
    if (receipt.ok) { try { await finishSession(sessionId); } catch (_) { /* разберёт обслуживание */ } }
    return receipt;
  });
}
