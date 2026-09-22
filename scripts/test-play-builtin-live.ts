/**
 * Встроенная игра вживую: от лобби до записанного результата.
 *
 * Офлайновые проверки стерегут правила доски. Здесь проверяется ДОРОГА: что
 * ход доезжает до сервера, доска считается там же, соперник видит новую
 * версию, повтор не делает второго хода, опоздавший не затирает чужой, а конец
 * партии закрывает матч и пишет результат.
 *
 * Два игрока — два токена: это и есть суть проверки. Одним клиентом
 * «соперник видит» не проверяется никак.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-play-builtin-live.ts
 */

import { flipsOf, movesOf } from '../play/games/reversi';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ONE = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const TWO = { symbol: process.env.FLUX_USER2 || '', password: process.env.FLUX_PASS2 || '' };

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));

const newKey = () => `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface Who { token: string; id: string; name: string }

async function call(who: Who | null, method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ok: res.ok, data: (await res.json().catch(() => ({}))) as any };
}

const login = async (creds: { symbol: string; password: string }): Promise<Who | null> => {
  const r = await call(null, 'POST', '/api/login', creds);
  const token = String(r.data?.token || '');
  const id = String(r.data?.user?.id || '');
  if (!token || !id) return null;
  return { token, id, name: String(r.data?.user?.symbol || creds.symbol) };
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  console.log('0. Вход');
  const one = await login(ONE);
  ok('первый игрок вошёл', !!one?.token && !!one?.id, one?.id);
  if (!one) { console.log(`\nПРОВАЛОВ: ${f}`); process.exit(1); }

  console.log('\n1. Одиночная игра: 2048 без соперника');
  {
    // Право на игру: без него платформа отвечает нейтральным 404, и это
    // правильно — но проверять тогда нечего
    const state = await call(one, 'GET', '/api/play/state');
    if (state.status === 404) {
      console.log('  — платформа этому сотруднику не открыта; выдайте app.play и game.g2048.play');
      console.log('\nПРОВЕРКА НЕ ВЫПОЛНЕНА: нет доступа к платформе');
      process.exit(2);
    }
    ok('состояние платформы читается', state.ok, state.data?.message);

    // Чистим хвосты прошлых прогонов: незакрытый матч не даст начать новый
    await call(one, 'POST', '/api/play/session/cancel', {});
    await call(one, 'POST', '/api/play/party/leave', {}, newKey());

    await call(one, 'POST', '/api/play/party', { gameId: 'g2048' }, newKey());
    const lobby = await call(one, 'POST', '/api/play/lobby', { gameId: 'g2048' }, newKey());
    const lobbyId = String(lobby.data?.result?.id || lobby.data?.result?.lobby?.id || '');
    ok('лобби одиночной игры открыто', !!lobbyId, lobby.data);

    const st1 = await call(one, 'GET', '/api/play/state');
    const rev = Number(st1.data?.result?.lobby?.revision || 0);
    await call(one, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: rev }, newKey());

    const st2 = await call(one, 'GET', '/api/play/state');
    const rev2 = Number(st2.data?.result?.lobby?.revision || 0);
    const started = await call(one, 'POST', '/api/play/session', { lobbyId, expectedVersion: rev2 }, newKey());
    const sessionId = String(started.data?.result?.session?.id || '');
    ok('матч начался', !!sessionId, started.data);
    ok('адрес — «встроенная», а не выдуманный host:port',
      String(started.data?.result?.session?.serverAddr || '') === 'встроенная',
      started.data?.result?.session?.serverAddr);

    const board = await call(one, 'GET', `/api/play/match/${sessionId}`);
    const view = board.data?.result;
    ok('доска открыта', !!view, board.data);
    ok('на доске две плитки', (view?.view?.board || []).filter(Boolean).length === 2, view?.view?.board);
    ok('ход за мной', view?.yourTurn === true, view);

    // Ход туда, куда двигается
    const dir = (view?.view?.dirs || [])[0];
    const moved = await call(one, 'POST', `/api/play/match/${sessionId}/move`, { move: { dir }, expectedRevision: view.revision }, newKey());
    ok('ход принят', moved.ok, moved.data);
    const after = await call(one, 'GET', `/api/play/match/${sessionId}`);
    ok('версия доски выросла', after.data?.result?.revision === view.revision + 1,
      [view.revision, after.data?.result?.revision]);
    ok('на доске стало три плитки',
      (after.data?.result?.view?.board || []).filter(Boolean).length === 3, after.data?.result?.view?.board);

    // Опоздавший не затирает: тот же expectedRevision второй раз
    const late = await call(one, 'POST', `/api/play/match/${sessionId}/move`, { move: { dir }, expectedRevision: view.revision }, newKey());
    ok('ход на устаревшую доску отвергнут', !late.ok && late.data?.code === 'VERSION_CONFLICT', late.data);

    // Повтор той же команды — не второй ход
    const key = newKey();
    const rev3 = Number(after.data?.result?.revision || 0);
    const dir2 = (after.data?.result?.view?.dirs || [])[0];
    const first = await call(one, 'POST', `/api/play/match/${sessionId}/move`, { move: { dir: dir2 }, expectedRevision: rev3 }, key);
    const twice = await call(one, 'POST', `/api/play/match/${sessionId}/move`, { move: { dir: dir2 }, expectedRevision: rev3 }, key);
    ok('повтор вернул тот же ответ', twice.ok && twice.data?.repeated === true, twice.data);
    const now = await call(one, 'GET', `/api/play/match/${sessionId}`);
    ok('и второго хода не случилось',
      now.data?.result?.revision === Number(first.data?.result?.revision || 0),
      [first.data?.result?.revision, now.data?.result?.revision]);

    // Бросить партию: матч закрывается, результат записан
    const gone = await call(one, 'POST', `/api/play/match/${sessionId}/resign`, {}, newKey());
    ok('партию можно бросить', gone.ok, gone.data);
    await wait(300);
    const stEnd = await call(one, 'GET', '/api/play/state');
    ok('матч больше не идёт', !stEnd.data?.result?.session, stEnd.data?.result?.session);
    ok('итог виден', !!stEnd.data?.result?.result, stEnd.data?.result?.result);

    await call(one, 'POST', '/api/play/party/leave', {}, newKey());
  }

  console.log('\n2. Реверси на двоих');
  {
    if (!TWO.symbol) {
      console.log('  — второй игрок не задан (FLUX_USER2/FLUX_PASS2); двухсторонняя часть пропущена');
      console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ВЫПОЛНЕННЫЕ ПРОВЕРКИ ПРОЙДЕНЫ (двоих не проверяли)');
      process.exit(f ? 1 : 0);
    }
    const two = await login(TWO);
    ok('второй игрок вошёл', !!two?.token, two?.id);
    if (!two) { console.log(`\nПРОВАЛОВ: ${f}`); process.exit(1); }

    await call(one, 'POST', '/api/play/session/cancel', {});
    await call(two, 'POST', '/api/play/session/cancel', {});
    await call(one, 'POST', '/api/play/party/leave', {}, newKey());
    await call(two, 'POST', '/api/play/party/leave', {}, newKey());

    await call(one, 'POST', '/api/play/party', { gameId: 'reversi' }, newKey());
    const inv = await call(one, 'POST', '/api/play/invites', { userId: two.id, gameId: 'reversi' }, newKey());
    const inviteId = String(inv.data?.result?.id || inv.data?.result?.invite?.id || '');
    ok('приглашение отправлено', !!inviteId, inv.data);
    const acc = await call(two, 'POST', `/api/play/invites/${inviteId}/accept`, {}, newKey());
    ok('приглашение принято', acc.ok, acc.data);

    const lob = await call(one, 'POST', '/api/play/lobby', { gameId: 'reversi' }, newKey());
    const lobbyId = String(lob.data?.result?.id || lob.data?.result?.lobby?.id || '');
    ok('лобби открыто', !!lobbyId, lob.data);

    for (const who of [one, two]) {
      const st = await call(who, 'GET', '/api/play/state');
      const rev = Number(st.data?.result?.lobby?.revision || 0);
      await call(who, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: rev }, newKey());
    }
    const stS = await call(one, 'GET', '/api/play/state');
    const revS = Number(stS.data?.result?.lobby?.revision || 0);
    const started = await call(one, 'POST', '/api/play/session', { lobbyId, expectedVersion: revS }, newKey());
    const sessionId = String(started.data?.result?.session?.id || '');
    ok('матч начался', !!sessionId, started.data);

    const b1 = await call(one, 'GET', `/api/play/match/${sessionId}`);
    const b2 = await call(two, 'GET', `/api/play/match/${sessionId}`);
    ok('доску видят оба', !!b1.data?.result && !!b2.data?.result);
    ok('ходит ровно один', b1.data.result.yourTurn !== b2.data.result.yourTurn,
      [b1.data.result.yourTurn, b2.data.result.yourTurn]);

    const mover = b1.data.result.yourTurn ? one : two;
    const waiter = b1.data.result.yourTurn ? two : one;
    const view = b1.data.result;

    // Чужой ход отвергается словами
    const foreign = await call(waiter, 'POST', `/api/play/match/${sessionId}/move`,
      { move: { cell: view.view.moves[0] }, expectedRevision: view.revision }, newKey());
    ok('чужой ход отвергнут', !foreign.ok && /не ваш ход/i.test(String(foreign.data?.message || '')), foreign.data);

    // Свой — принимается, и соперник видит новую доску
    const cell = view.view.moves[0];
    const flips = flipsOf(view.view.board, cell, view.view.turn);
    const mv = await call(mover, 'POST', `/api/play/match/${sessionId}/move`,
      { move: { cell }, expectedRevision: view.revision }, newKey());
    ok('ход принят', mv.ok, mv.data);

    const seen = await call(waiter, 'GET', `/api/play/match/${sessionId}`);
    ok('соперник видит новую версию', seen.data?.result?.revision === view.revision + 1,
      [view.revision, seen.data?.result?.revision]);
    ok('фишка поставлена', seen.data.result.view.board[cell] === view.view.turn, seen.data.result.view.board[cell]);
    ok('чужие фишки перевернулись',
      flips.every((i: number) => seen.data.result.view.board[i] === view.view.turn), flips);
    ok('ход перешёл сопернику', seen.data.result.yourTurn === true, seen.data.result);

    // Сдаться: матч закрывается, победа у оставшегося
    await call(mover, 'POST', `/api/play/match/${sessionId}/resign`, {}, newKey());
    await wait(300);
    const end = await call(waiter, 'GET', '/api/play/state');
    ok('матч закрыт у обоих', !end.data?.result?.session, end.data?.result?.session);
    ok('итог записан', !!end.data?.result?.result, end.data?.result?.result);

    await call(one, 'POST', '/api/play/party/leave', {}, newKey());
    await call(two, 'POST', '/api/play/party/leave', {}, newKey());
  }

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
