/**
 * Полный цикл двумя независимыми клиентами — то, чем ТЗ считает готовность.
 *
 * Приглашение → группа → лобби → готовность → матч → результат → повтор, и всё
 * это на настоящем сервере, настоящей базе и настоящем игровом процессе.
 * Проверка написана против главного соблазна: объявить сделанным то, что
 * проверено на заглушках. Заглушка отвечает мгновенно и всегда «да» — на ней
 * «работает» и то, что на живом процессе не работает никогда.
 *
 * Отдельно проверяется, ради чего вся эта возня с расписками и индексами:
 *
 *   — повторное «Начать матч» не заводит второго матча;
 *   — повторная доставка результата не удваивает счёт;
 *   — после матча лобби возвращается в подготовку, и «Ещё раз» работает.
 *
 * Запуск (сервер поднят с подключённой проверочной игрой):
 *   export FLUX_TESTGAME_SECRET=$(openssl rand -hex 16)
 *   FLUX_TESTGAME_URL=http://127.0.0.1:3210 npx tsx server.ts &
 *   npx tsx scripts/test-play-cycle-live.ts
 *
 * Сам игровой процесс поднимает эта проверка: он отдельный, и его жизнь
 * ограничена её прогоном.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { APP_PLAY, PLAY_ADMIN, gameEntitlement, isPlayKey } from '../play/features';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const SECRET = String(process.env.FLUX_TESTGAME_SECRET || '');
const GAME_PORT = Number(process.env.FLUX_TESTGAME_PORT || 3210);
const GAME = `http://127.0.0.1:${GAME_PORT}`;

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 400) : '')));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Тот же порядок полей, что у платформы и у игры: подпись от него не зависит. */
function stableJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  try { return JSON.stringify(walk(value) ?? null); } catch (_) { return '""'; }
}

/** Подписываем так же, как игровой сервер: проверка повторяет его поведение. */
const sign = (sessionId: string, payload: unknown): string =>
  createHmac('sha256', SECRET).update(`${sessionId}.${stableJson(payload)}`).digest('hex');

const api = async (token: string, method: string, url: string, body?: any, key?: string) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) as any }; } catch { return { status: res.status, json: null as any, text }; }
};

const game = async (path: string, body: any) => {
  const res = await fetch(GAME + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

/** Выдать человеку права платформы. Иначе для него её не существует. */
async function grant(adminToken: string, userId: string, keys: string[]): Promise<void> {
  const list = await api(adminToken, 'GET', '/api/users');
  const row = (list.json?.users || list.json || []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of keys) perms[k] = { enabled: true, until: null, mode: 'ALLOW' };
  await api(adminToken, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

async function revoke(adminToken: string, userId: string): Promise<void> {
  const list = await api(adminToken, 'GET', '/api/users');
  const row = (list.json?.users || list.json || []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of Object.keys(perms)) if (isPlayKey(k)) delete perms[k];
  await api(adminToken, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

(async () => {
  if (!SECRET) {
    console.error('Нет FLUX_TESTGAME_SECRET: без общего секрета результат нечем подписать,');
    console.error('а значит, и проверять нечего. Сервер должен быть поднят с тем же секретом.');
    process.exit(2);
  }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = await api('', 'POST', '/api/login', ADMIN);
  const adminToken = String(admin.json?.token || '');
  const adminId = String(admin.json?.user?.id || '');
  if (!adminToken) { console.error('Не удалось войти администратором.'); process.exit(2); }

  console.log('1. Готовим стенд: платформа включена, доступ выдан двоим');
  const stamp = Date.now().toString(36).slice(-5);
  const people: Array<{ id: string; token: string; symbol: string }> = [];
  {
    await grant(adminToken, adminId, [PLAY_ADMIN, APP_PLAY]);
    const on = await api(adminToken, 'PUT', '/api/play/platform', { enabled: true });
    ok('платформа включена', on.status === 200, on.status);

    for (const suffix of ['A', 'B']) {
      const symbol = `ИГ${suffix}${stamp}`;
      const password = `pl-${suffix}-${stamp}-Aa1`;
      const made = await api(adminToken, 'POST', '/api/users', {
        name: `Игрок ${suffix} ${stamp}`, symbol, password, role: 'ENGINEER',
      });
      const id = String(made.json?.user?.id || made.json?.id || '');
      await grant(adminToken, id, [APP_PLAY, gameEntitlement('testgame')]);
      const login = await api('', 'POST', '/api/login', { symbol, password });
      people.push({ id, token: String(login.json?.token || ''), symbol });
    }
    ok('оба сотрудника вошли', people.every((p) => p.id && p.token), people.map((p) => p.symbol));
  }
  const [A, B] = people;

  console.log('\n2. Поднимаем проверочную игру отдельным процессом');
  let child: any = null;
  {
    /**
     * Своя группа процессов.
     *
     * `npx` запускает `tsx` дочерним, и убийство `npx` оставляет игру жить.
     * Пережившая прогон игра занимает порт, следующий прогон её не поднимает
     * и молча разговаривает со старой — со старым токеном и старым кодом.
     * Выглядит это как поломка платформы, а не как оставленный процесс, и
     * искать причину приходится долго. Поэтому отдельная группа и убийство
     * группы целиком.
     */
    child = spawn('npx', ['tsx', 'scripts/testgame-server.ts'], {
      env: {
        ...process.env,
        FLUX_TESTGAME_SECRET: SECRET,
        FLUX_TESTGAME_PORT: String(GAME_PORT),
        FLUX_PLATFORM_URL: BASE,
        FLUX_PLATFORM_TOKEN: A.token,
      },
      stdio: 'ignore',
      detached: true,
    });
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await wait(500);
      try { alive = (await fetch(`${GAME}/health`, { method: 'POST' })).ok; } catch (_) { alive = false; }
    }
    ok('игровой процесс отвечает', alive);
    if (!alive) { child.kill(); process.exit(1); }
  }

  const cleanup = async () => {
    // Убиваем группу, а не одного `npx`: иначе игра переживёт прогон
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* уже ушла */ }
    try { child?.kill('SIGKILL'); } catch (_) { /* уже ушёл */ }
    for (const p of people) { try { await revoke(adminToken, p.id); } catch (_) { /* профиль мог уйти */ } }
    try { await api(adminToken, 'PUT', '/api/play/platform', { enabled: false }); } catch (_) {}
    try { await revoke(adminToken, adminId); } catch (_) {}
  };

  try {
    console.log('\n3. Приглашение и группа');
    let partyId = '';
    let inviteId = '';
    {
      const sent = await api(A.token, 'POST', '/api/play/invites', { userId: B.id, gameId: 'testgame' }, `inv-${stamp}`);
      ok('приглашение отправлено', sent.status === 201 && sent.json?.ok, sent.json);
      inviteId = String(sent.json?.result?.id || '');

      // Повтор с тем же ключом — тот же ответ, а не второе приглашение
      const again = await api(A.token, 'POST', '/api/play/invites', { userId: B.id, gameId: 'testgame' }, `inv-${stamp}`);
      ok('повтор помечен повтором', again.json?.repeated === true, again.json);
      ok('и приглашение то же', String(again.json?.result?.id) === inviteId, again.json?.result?.id);

      const inbox = await api(B.token, 'GET', '/api/play/inbox');
      ok('приглашение видно получателю', (inbox.json?.result || []).some((i: any) => i.id === inviteId), inbox.json);

      const accepted = await api(B.token, 'POST', `/api/play/invites/${inviteId}/accept`, {}, `acc-${stamp}`);
      ok('приглашение принято', accepted.json?.ok === true, accepted.json);
      partyId = String(accepted.json?.result?.party?.id || '');
      ok('оба в одной группе', !!partyId, accepted.json?.result?.party);

      const mine = await api(B.token, 'GET', '/api/play/party');
      ok('группа видна второму', mine.json?.result?.id === partyId, mine.json?.result);
      ok('в группе двое', (mine.json?.result?.members || []).length === 2, mine.json?.result?.members);
    }

    console.log('\n4. Лобби и готовность');
    let lobbyId = '';
    let version = 0;
    {
      const opened = await api(A.token, 'POST', '/api/play/lobby', { gameId: 'testgame' }, `lob-${stamp}`);
      ok('лобби открыто', opened.json?.ok === true, opened.json);
      lobbyId = String(opened.json?.result?.id || '');
      version = Number(opened.json?.result?.revision || 0);
      ok('мест по описанию игры', opened.json?.result?.seats === 2, opened.json?.result);
      ok('места розданы обоим', (opened.json?.result?.slots || []).length === 2, opened.json?.result?.slots);

      // Опоздавший не затирает чужое: версия проверяется на сервере
      const stale = await api(
        A.token, 'POST', '/api/play/lobby/ready',
        { lobbyId, ready: true, expectedVersion: version - 1 }, `stale-${stamp}`,
      );
      ok('опоздавшему отказано', stale.json?.ok === false && stale.json?.code === 'VERSION_CONFLICT', stale.json);

      const r1 = await api(A.token, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: version }, `ra-${stamp}`);
      ok('первый готов', r1.json?.ok === true, r1.json);
      version = Number(r1.json?.result?.revision || version + 1);

      const r2 = await api(B.token, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: version }, `rb-${stamp}`);
      ok('второй готов', r2.json?.ok === true, r2.json);
      version = Number(r2.json?.result?.revision || version + 1);
      ok('лобби перешло в «готово»', r2.json?.result?.state === 'READY', r2.json?.result?.state);
    }

    console.log('\n5. Матч: выделение сервера и билеты');
    let sessionId = '';
    let ticketA = '';
    {
      const started = await api(A.token, 'POST', '/api/play/session', { lobbyId, expectedVersion: version }, `s1-${stamp}`);
      ok('матч начат', started.json?.ok === true, started.json);
      sessionId = String(started.json?.result?.session?.id || '');
      ok('сервер игры выделен', started.json?.result?.session?.state === 'RUNNING', started.json?.result?.session);
      ok('адрес назван', !!started.json?.result?.session?.serverAddr, started.json?.result?.session?.serverAddr);
      ticketA = String((started.json?.result?.tickets || [])[0]?.token || '');
      ok('билет выдан только себе', (started.json?.result?.tickets || []).length === 1, started.json?.result?.tickets);

      // Повторное «Начать» не заводит второго матча — ни с тем же ключом, ни
      // с другим: держит частичный индекс, а не наша осторожность
      const again = await api(A.token, 'POST', '/api/play/session', { lobbyId, expectedVersion: version }, `s2-${stamp}`);
      ok('повтор не завёл второго матча', String(again.json?.result?.session?.id) === sessionId, again.json?.result?.session?.id);
    }

    console.log('\n6. Билеты предъявляются игре, а не игроку на слово');
    {
      const rejoinB = await api(B.token, 'POST', '/api/play/session/rejoin', {});
      const ticketB = String(rejoinB.json?.result?.ticket || '');
      ok('второй получил свой билет', !!ticketB);

      const joinA = await game('/join', { token: ticketA });
      ok('первый пущен в игру', joinA.json?.ok === true, joinA.json);
      const joinB = await game('/join', { token: ticketB });
      ok('второй пущен в игру', joinB.json?.ok === true, joinB.json);
      ok('игра видит, что все на месте', joinB.json?.full === true, joinB.json);

      // Тот же билет второй раз — отказ: пропуск одноразовый
      const twice = await game('/join', { token: ticketA });
      ok('повторный билет не принят', twice.status === 403, twice.json);
    }

    console.log('\n7. Результат приходит от игры и подписан');
    {
      const finished = await game('/finish', { sessionId, winnerTeam: 1, durationSec: 3 });
      ok('игра отчиталась', finished.json?.ok === true, finished.json);

      const result = await api(A.token, 'GET', `/api/play/session/${sessionId}/result`);
      ok('результат записан', !!result.json?.result, result.json);
      ok('победитель назван', Number((result.json?.result as any)?.winnerTeam) === 1, result.json?.result);

      /**
       * Повторная доставка — обычное дело: игровой сервер не уверен, что мы
       * его услышали, и шлёт ещё раз. Повторяем её так же, как повторил бы
       * он: то же тело, та же подпись. Второго счёта быть не должно.
       */
      const payload = result.json?.result as Record<string, unknown>;
      const again = await api(A.token, 'POST', '/api/play/results', {
        sessionId, payload, signature: sign(sessionId, payload),
      });
      ok('повтор доставки принят', again.json?.ok === true, again.json);
      ok('и помечен повтором', again.json?.result?.repeated === true, again.json?.result);

      // Подменённый счёт не принимается: подпись считается по телу
      const forged = await api(A.token, 'POST', '/api/play/results', {
        sessionId, payload: { ...payload, winnerTeam: 2 }, signature: sign(sessionId, payload),
      });
      ok('подменённый счёт отклонён', forged.json?.ok === false, forged.json);

      const after = await api(A.token, 'GET', `/api/play/session/${sessionId}/result`);
      ok('счёт не переписан', Number((after.json?.result as any)?.winnerTeam) === 1, after.json?.result);

      const seen = await api(B.token, 'GET', '/api/play/session');
      ok('второй больше не в матче', seen.json?.result === null, seen.json?.result);
    }

    console.log('\n8. «Ещё раз»: лобби вернулось в подготовку');
    {
      const lobby = await api(A.token, 'GET', '/api/play/lobby');
      ok('лобби снова готовится', lobby.json?.result?.state === 'FORMING', lobby.json?.result?.state);
      ok('готовность сброшена', (lobby.json?.result?.slots || []).every((s: any) => !s.ready), lobby.json?.result?.slots);

      let v = Number(lobby.json?.result?.revision || 0);
      const r1 = await api(A.token, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: v }, `rra-${stamp}`);
      v = Number(r1.json?.result?.revision || v + 1);
      const r2 = await api(B.token, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: v }, `rrb-${stamp}`);
      v = Number(r2.json?.result?.revision || v + 1);
      ok('оба снова готовы', r2.json?.result?.state === 'READY', r2.json?.result?.state);

      const second = await api(A.token, 'POST', '/api/play/session', { lobbyId, expectedVersion: v }, `s3-${stamp}`);
      ok('второй матч начат', second.json?.ok === true, second.json);
      const secondId = String(second.json?.result?.session?.id || '');
      ok('и это другой матч', !!secondId && secondId !== sessionId, { first: sessionId, second: secondId });

      // Прибираем: матч, оставленный идущим, держит людей «в матче»
      await api(A.token, 'POST', '/api/play/session/cancel', {});
      const left = await api(A.token, 'GET', '/api/play/session');
      ok('матч отменён и места освобождены', left.json?.result === null, left.json?.result);
    }

    console.log('\n9. Выход из группы убирает за собой');
    {
      await api(B.token, 'POST', '/api/play/party/leave', {}, `lv-b-${stamp}`);
      const partyB = await api(B.token, 'GET', '/api/play/party');
      ok('ушедшего в группе нет', partyB.json?.result === null, partyB.json?.result);
      const partyA = await api(A.token, 'GET', '/api/play/party');
      ok('оставшийся по-прежнему в группе', partyA.json?.result?.id === partyId, partyA.json?.result);
      ok('в группе остался один', (partyA.json?.result?.members || []).length === 1, partyA.json?.result?.members);

      await api(A.token, 'POST', '/api/play/party/leave', {}, `lv-a-${stamp}`);
      const gone = await api(A.token, 'GET', '/api/play/party');
      ok('группа закрылась', gone.json?.result === null, gone.json?.result);
    }
  } finally {
    console.log('\n10. Возвращаем стенд в исходное состояние');
    await cleanup();
    const closed = await api(adminToken, 'GET', '/api/play/platform');
    ok('платформа снова закрыта', closed.status === 404, closed.status);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
