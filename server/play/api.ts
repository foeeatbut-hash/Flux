/**
 * Маршруты платформы: группа, приглашения, лобби, матч, билеты, результат.
 *
 * Каждое изменяющее действие — команда: с ключом идемпотентности, с расписком
 * и в одной транзакции (см. commands.ts). Ключ обязателен, потому что повтор
 * тут не редкость, а норма работы: обрыв связи посреди запроса выглядит для
 * окна как неудача, и окно отправляет снова.
 *
 * Чтение отдаёт только своё: свою группу, своё лобби, свой матч, свои
 * приглашения. Списка всех сотрудников и чужих групп платформа не раздаёт —
 * ни одним маршрутом.
 *
 * Личность везде берётся из сессии (`req.authUser`), а не из тела запроса.
 * Иначе достаточно подставить чужой идентификатор, чтобы действовать от его
 * имени.
 */

import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { playErrorHttp, playErrorText, PLAY_ERRORS } from '../../play/contracts.js';
import { gameById } from '../../play/features.js';
import { keyFromRequest, runCommand, PlayFailure } from './commands.js';
import { createParty, kickFromParty, leaveParty, partyOf, viewOf } from './parties.js';
import { cancelInvite, dropInvitesOfParty, inboxOf, respondInvite, sendInvite } from './invites.js';
import { closeLobby, lobbyOfParty, openLobby, setReady, setTeam, syncSlots } from './lobbies.js';
import { allocateServer, claimSession, cancelSession, rejoin, sessionOf } from './sessions.js';
import { redeemTicket } from './tickets.js';
import { acceptResult, resultOf } from './results.js';
import { DEFAULT_CHANNEL, latestBuild, publisherKey } from './builds.js';
import { snapshotFor } from './snapshot.js';
import { makeMove, matchView, resign } from './match.js';

const actorOf = (req: Request): string => String((req as any).authUser?.id || '');

/** Один ответ на все команды: окно разбирает их одинаково. */
async function command(
  req: Request, res: Response, kind: string, body: unknown, work: (tx: any) => Promise<unknown>,
): Promise<void> {
  const actorId = actorOf(req);
  const key = keyFromRequest(req);
  try {
    const receipt = await runCommand({ actorId, key, kind, body, work });
    if (receipt.ok) { res.status(receipt.repeated ? 200 : 201).json(receipt); return; }
    res.status(playErrorHttp(String(receipt.code))).json(receipt);
  } catch (e: any) {
    if (e instanceof PlayFailure) {
      res.status(playErrorHttp(String(e.code))).json({ ok: false, repeated: false, code: e.code, message: e.message });
      return;
    }
    res.status(500).json({ ok: false, repeated: false, code: 'INTERNAL', message: e?.message || 'Не получилось' });
  }
}

/** Чтение: отказ такой же, как у команды, но без расписки. */
async function read(res: Response, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json({ ok: true, result: await work() });
  } catch (e: any) {
    if (e instanceof PlayFailure) {
      res.status(playErrorHttp(String(e.code))).json({ ok: false, code: e.code, message: e.message });
      return;
    }
    res.status(500).json({ ok: false, code: 'INTERNAL', message: e?.message || 'Не получилось' });
  }
}

export function registerPlayApi(app: Express): void {
  // ── Состояние целиком ─────────────────────────────────────────────────────

  /** То же, что приезжает по сокету: окно берёт его и при обычной загрузке. */
  app.get('/api/play/state', async (req: Request, res: Response) => {
    await read(res, () => snapshotFor(actorOf(req)));
  });

  app.get('/api/play/inbox', async (req: Request, res: Response) => {
    await read(res, () => inboxOf(actorOf(req)));
  });

  // ── Встроенная игра: доска и ход ─────────────────────────────────────────

  /**
   * Доска глазами того, кто спрашивает.
   *
   * Отдельным запросом, а не полем снимка: доска меняется на каждом ходу, а
   * снимок — на каждое изменение платформы, и таскать сетку судоку в каждом
   * ответе про присутствие незачем.
   */
  app.get('/api/play/match/:sessionId', async (req: Request, res: Response) => {
    await read(res, () => matchView(String(req.params.sessionId || ''), actorOf(req)));
  });

  /**
   * Ход.
   *
   * Сюда приходит ХОД, а не доска: доску считает сервер теми же правилами,
   * которыми окно подсвечивает разрешённое. `expectedRevision` — версия, на
   * которую смотрел игрок: пришёл на старую, значит соперник успел раньше, и
   * ход не применяется.
   */
  app.post('/api/play/match/:sessionId/move', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    const key = keyFromRequest(req);
    try {
      const receipt = await makeMove(
        String(req.params.sessionId || ''), actorId, req.body?.move,
        key, req.body?.expectedRevision,
      );
      if (receipt.ok) { res.status(receipt.repeated ? 200 : 201).json(receipt); return; }
      res.status(playErrorHttp(String(receipt.code))).json(receipt);
    } catch (e: any) {
      if (e instanceof PlayFailure) {
        res.status(playErrorHttp(String(e.code))).json({ ok: false, repeated: false, code: e.code, message: e.message });
        return;
      }
      res.status(500).json({ ok: false, repeated: false, code: 'INTERNAL', message: e?.message || 'Не получилось' });
    }
  });

  /** Сдаться. Отдельно от хода: у половины игр ходом это не выражается */
  app.post('/api/play/match/:sessionId/resign', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    const key = keyFromRequest(req);
    try {
      const receipt = await resign(String(req.params.sessionId || ''), actorId, key);
      if (receipt.ok) { res.status(receipt.repeated ? 200 : 201).json(receipt); return; }
      res.status(playErrorHttp(String(receipt.code))).json(receipt);
    } catch (e: any) {
      res.status(500).json({ ok: false, repeated: false, code: 'INTERNAL', message: e?.message || 'Не получилось' });
    }
  });

  /**
   * Что опубликовано для этой игры.
   *
   * Спрашивает окно, а ставит оболочка: окно передаёт ей опись и открытый ключ
   * издателя, оболочка сверяет подпись сама. Ключ отдаётся открытый — это ключ
   * ПРОВЕРКИ; подписывающий лежит у владельца и на сервер не попадает.
   *
   * Игра, которой в каталоге нет, отвечает так же, как отсутствующая сборка:
   * перечислять несуществующие игры платформа не должна.
   */
  app.get('/api/play/builds/:gameId', async (req: Request, res: Response) => {
    const gameId = String(req.params.gameId || '');
    await read(res, async () => {
      if (!gameById(gameId)) return { build: null, publisherKey: '' };
      const channel = String(req.query.channel || DEFAULT_CHANNEL);
      const build = await latestBuild(gameId, channel);
      return { build, publisherKey: build ? await publisherKey() : '' };
    });
  });

  // ── Группа ────────────────────────────────────────────────────────────────

  app.post('/api/play/party', async (req: Request, res: Response) => {
    const gameId = req.body?.gameId ? String(req.body.gameId) : null;
    await command(req, res, 'party.create', { gameId }, (tx) => createParty(tx, actorOf(req), gameId));
  });

  app.get('/api/play/party', async (req: Request, res: Response) => {
    await read(res, () => partyOf(actorOf(req)));
  });

  /**
   * Выйти из группы.
   *
   * Лобби и матч закрываются следом: висящее лобби распавшейся группы — это
   * лобби, в которое человек заходит и не понимает, почему ничего не работает.
   */
  app.post('/api/play/party/leave', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    await command(req, res, 'party.leave', {}, async (tx) => {
      const seat = await tx.playPartyMember.findFirst({ where: { userId: actorId, leftAt: null } });
      if (!seat) throw new PlayFailure(PLAY_ERRORS.NOT_FOUND);
      const partyId = seat.partyId;
      await leaveParty(tx, partyId, actorId);
      const left = await tx.playPartyMember.count({ where: { partyId, leftAt: null } });
      if (!left) {
        await dropInvitesOfParty(tx, partyId);
        const lobby = await tx.playLobby.findFirst({
          where: { partyId, state: { in: ['FORMING', 'READY', 'STARTED'] } },
        });
        if (lobby) await closeLobby(tx, lobby.id, 'группа распалась');
      } else {
        const lobby = await tx.playLobby.findFirst({
          where: { partyId, state: { in: ['FORMING', 'READY'] } },
        });
        if (lobby) await syncSlots(tx, lobby.id);
      }
      return { left: true };
    });
  });

  app.post('/api/play/party/kick', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    const userId = String(req.body?.userId || '');
    await command(req, res, 'party.kick', { userId }, async (tx) => {
      const seat = await tx.playPartyMember.findFirst({ where: { userId: actorId, leftAt: null } });
      if (!seat) throw new PlayFailure(PLAY_ERRORS.NOT_FOUND);
      await kickFromParty(tx, seat.partyId, actorId, userId);
      const lobby = await tx.playLobby.findFirst({
        where: { partyId: seat.partyId, state: { in: ['FORMING', 'READY'] } },
      });
      if (lobby) await syncSlots(tx, lobby.id);
      return { userId };
    });
  });

  // ── Приглашения ───────────────────────────────────────────────────────────

  /**
   * Позвать.
   *
   * Группы нет — она заводится здесь же: «пригласить» без группы это просьба
   * начать играть вместе, а не ошибка, и заставлять человека нажимать две
   * кнопки подряд незачем.
   */
  app.post('/api/play/invites', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    const toUserId = String(req.body?.userId || '');
    const gameId = req.body?.gameId ? String(req.body.gameId) : null;
    await command(req, res, 'invite.send', { toUserId, gameId }, async (tx) => {
      const party = await createParty(tx, actorId, gameId);
      return sendInvite(tx, party.id, actorId, toUserId);
    });
  });

  app.post('/api/play/invites/:id/accept', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    await command(req, res, 'invite.accept', { id }, async (tx) => {
      const out = await respondInvite(tx, id, actorOf(req), true);
      const lobby = await tx.playLobby.findFirst({
        where: { partyId: out.party?.id, state: { in: ['FORMING', 'READY'] } },
      });
      if (lobby) await syncSlots(tx, lobby.id);
      return out;
    });
  });

  app.post('/api/play/invites/:id/decline', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    await command(req, res, 'invite.decline', { id }, (tx) => respondInvite(tx, id, actorOf(req), false));
  });

  app.post('/api/play/invites/:id/cancel', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    await command(req, res, 'invite.cancel', { id }, async (tx) => {
      await cancelInvite(tx, id, actorOf(req));
      return { cancelled: true };
    });
  });

  // ── Лобби ─────────────────────────────────────────────────────────────────

  app.get('/api/play/lobby', async (req: Request, res: Response) => {
    await read(res, async () => {
      const party = await partyOf(actorOf(req));
      return party ? lobbyOfParty(party.id) : null;
    });
  });

  app.post('/api/play/lobby', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    const gameId = String(req.body?.gameId || '');
    await command(req, res, 'lobby.open', { gameId }, async (tx) => {
      if (!gameById(gameId)) throw new PlayFailure(PLAY_ERRORS.INVALID, 'Неизвестная игра');
      const seat = await tx.playPartyMember.findFirst({ where: { userId: actorId, leftAt: null } });
      const partyId = seat ? seat.partyId : (await createParty(tx, actorId, gameId)).id;
      return openLobby(tx, partyId, actorId, gameId);
    });
  });

  app.post('/api/play/lobby/ready', async (req: Request, res: Response) => {
    const lobbyId = String(req.body?.lobbyId || '');
    const ready = req.body?.ready !== false;
    const expectedVersion = Number(req.body?.expectedVersion);
    await command(
      req, res, 'lobby.ready', { lobbyId, ready, expectedVersion },
      (tx) => setReady(tx, lobbyId, actorOf(req), ready, expectedVersion),
    );
  });

  app.post('/api/play/lobby/team', async (req: Request, res: Response) => {
    const lobbyId = String(req.body?.lobbyId || '');
    const userId = String(req.body?.userId || '');
    const team = Number(req.body?.team) || 1;
    const expectedVersion = Number(req.body?.expectedVersion);
    await command(
      req, res, 'lobby.team', { lobbyId, userId, team, expectedVersion },
      (tx) => setTeam(tx, lobbyId, actorOf(req), userId, team, expectedVersion),
    );
  });

  // ── Матч ──────────────────────────────────────────────────────────────────

  app.get('/api/play/session', async (req: Request, res: Response) => {
    await read(res, () => sessionOf(actorOf(req)));
  });

  /**
   * Начать матч.
   *
   * Запись о матче заводится командой (в транзакции), а сервер игры выделяется
   * ПОСЛЕ неё и вне транзакции: чужой процесс отвечает когда захочет, и
   * держать на это время базу нельзя.
   */
  app.post('/api/play/session', async (req: Request, res: Response) => {
    const lobbyId = String(req.body?.lobbyId || '');
    const expectedVersion = Number(req.body?.expectedVersion);
    const actorId = actorOf(req);
    const key = keyFromRequest(req);
    try {
      const receipt = await runCommand<any>({
        actorId, key, kind: 'session.start', body: { lobbyId, expectedVersion },
        work: (tx) => claimSession(tx, lobbyId, actorId, expectedVersion),
      });
      if (!receipt.ok) { res.status(playErrorHttp(String(receipt.code))).json(receipt); return; }

      const sessionId = receipt.result?.session?.id;
      // Выделение вне транзакции и вне расписки: повтор сюда попадёт с тем же
      // матчем, а матч, уже идущий, второй раз не выделяется
      const session = sessionId ? await allocateServer(sessionId) : receipt.result?.session;
      res.status(receipt.repeated ? 200 : 201).json({
        ...receipt,
        result: { ...receipt.result, session, tickets: ticketsFor(receipt.result, actorId) },
      });
    } catch (e: any) {
      if (e instanceof PlayFailure) {
        res.status(playErrorHttp(String(e.code))).json({ ok: false, repeated: false, code: e.code, message: e.message });
        return;
      }
      res.status(500).json({ ok: false, repeated: false, code: 'INTERNAL', message: e?.message || 'Не получилось' });
    }
  });

  /** «Вернуться в игру»: новый билет на идущий матч, старый гасится. */
  app.post('/api/play/session/rejoin', async (req: Request, res: Response) => {
    await read(res, () => rejoin(actorOf(req)));
  });

  app.post('/api/play/session/cancel', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    await read(res, async () => {
      const seat = await getPrisma().playSessionMember.findFirst({ where: { userId: actorId, state: 'ACTIVE' } });
      if (!seat) throw new PlayFailure(PLAY_ERRORS.NOT_FOUND);
      const prisma = getPrisma();
      const session = await prisma.playSession.findUnique({ where: { id: seat.sessionId } });
      const lobby = await prisma.playLobby.findUnique({ where: { id: session.lobbyId } });
      const party = await prisma.playParty.findUnique({ where: { id: lobby.partyId } });
      if (party?.leaderId !== actorId) throw new PlayFailure(PLAY_ERRORS.FORBIDDEN, 'Отменить матч может ведущий группы');
      await cancelSession(seat.sessionId, 'отменён ведущим');
      return { cancelled: true };
    });
  });

  app.get('/api/play/session/:id/result', async (req: Request, res: Response) => {
    await read(res, () => resultOf(String(req.params.id)));
  });

  // ── Служебное: билеты и результат ─────────────────────────────────────────
  //
  // Сюда ходит игровой сервер, а не окно. Заслон платформы (access.ts) их
  // тоже закрывает: игровой сервер обращается со своим токеном сессии, как
  // служба, а не как «кто угодно с адресом».

  app.post('/api/play/tickets/redeem', async (req: Request, res: Response) => {
    await read(res, async () => ({ seat: await redeemTicket(String(req.body?.token || '')) }));
  });

  app.post('/api/play/results', async (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId || '');
    const payload = (req.body?.payload || {}) as Record<string, unknown>;
    const signature = String(req.body?.signature || '');
    await read(res, () => acceptResult(sessionId, payload, signature));
  });

  // ── Чужая группа по идентификатору: только своим ──────────────────────────

  app.get('/api/play/party/:id', async (req: Request, res: Response) => {
    const actorId = actorOf(req);
    await read(res, async () => {
      const seat = await getPrisma().playPartyMember.findFirst({
        where: { partyId: String(req.params.id), userId: actorId, leftAt: null },
      });
      // Не свой — «нет такого». Отличать «нет» от «не для вас» здесь нельзя
      if (!seat) throw new PlayFailure(PLAY_ERRORS.NOT_FOUND, playErrorText(PLAY_ERRORS.NOT_FOUND));
      return viewOf(String(req.params.id));
    });
  });
}

/**
 * Билет — только свой.
 *
 * Команда выдаёт билеты всем местам сразу (одна транзакция), но наружу уходит
 * лишь тот, что принадлежит спрашивающему: чужой билет — это чужой пропуск.
 */
function ticketsFor(result: any, actorId: string): Array<{ userId: string; token: string }> {
  const list: Array<{ userId: string; token: string }> = result?.tickets || [];
  return list.filter((t) => t.userId === actorId);
}
