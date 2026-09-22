/**
 * Распоряжения администратора платформы — вживую, на поднятом сервере.
 *
 * Проверяется то, что нельзя проверить правилами: запрет обслуживания стоит не
 * на кнопке, а там, где матч заводится; неподписанная сборка не попадает даже в
 * каталог; зависший матч виден списком и снимается кнопкой.
 *
 * Проверочная игра поднимается здесь же: без неё матч не начинается, а снимать
 * нечего — и половина проверки превратилась бы в проверку самой себя.
 *
 * Запуск (сервер поднят с тем же секретом):
 *   FLUX_TESTGAME_SECRET=… npx tsx scripts/test-play-admin-live.ts
 */

import { spawn } from 'node:child_process';
import { APP_PLAY, PLAY_ADMIN, gameEntitlement, isPlayKey } from '../play/features';
import { canonicalManifest, type BuildManifest } from '../play/builds';
import { newPublisherKeys, signManifest } from '../play/node/signature';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

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
  try { return { status: res.status, json: JSON.parse(text) as any }; } catch { return { status: res.status, json: null as any }; }
};

const newKey = () => `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function grant(token: string, userId: string, keys: string[]): Promise<void> {
  const list = await api(token, 'GET', '/api/users');
  const row = (list.json?.users || list.json || []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of keys) perms[k] = { enabled: true, until: null, mode: 'ALLOW' };
  await api(token, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

async function revoke(token: string, userId: string): Promise<void> {
  const list = await api(token, 'GET', '/api/users');
  const row = (list.json?.users || list.json || []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of Object.keys(perms)) if (isPlayKey(k)) delete perms[k];
  await api(token, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

const sha = (n: number) => String(n).padStart(2, '0').repeat(32).slice(0, 64);

const manifestOf = (version: string): BuildManifest => ({
  gameId: 'fluxstrike',
  version,
  exe: 'FluxStrike.exe',
  files: [{ path: 'FluxStrike.exe', size: 1024, sha256: sha(3), url: 'FluxStrike.exe' }],
});

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const login = await api('', 'POST', '/api/login', ADMIN);
  const token = String(login.json?.token || '');
  const userId = String(login.json?.user?.id || '');
  if (!token) { console.error('Не удалось войти администратором.'); process.exit(2); }

  const keys = newPublisherKeys();
  const other = newPublisherKeys();
  const secret = String(process.env.FLUX_TESTGAME_SECRET || '');
  const gamePort = Number(process.env.FLUX_TESTGAME_PORT || 3210);
  let child: any = null;

  try {
    console.log('1. Стенд: платформа включена, права выданы, игра поднята');
    {
      await grant(token, userId, [PLAY_ADMIN, APP_PLAY, gameEntitlement('testgame')]);
      const on = await api(token, 'PUT', '/api/play/platform', { enabled: true });
      ok('платформа включена', on.status === 200, on.status);

      if (!secret) {
        console.error('Нет FLUX_TESTGAME_SECRET: сервер и игра должны знать один секрет.');
        process.exit(2);
      }
      // Отвязанной группой: иначе убивается npx, а не сама игра, и следующий
      // прогон молча разговаривает с прошлым процессом
      child = spawn('npx', ['tsx', 'scripts/testgame-server.ts'], {
        env: {
          ...process.env,
          FLUX_TESTGAME_SECRET: secret,
          FLUX_TESTGAME_PORT: String(gamePort),
          FLUX_PLATFORM_URL: BASE,
          FLUX_PLATFORM_TOKEN: token,
        },
        stdio: 'ignore',
        detached: true,
      });
      let alive = false;
      for (let i = 0; i < 40 && !alive; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try { alive = (await fetch(`http://127.0.0.1:${gamePort}/health`, { method: 'POST' })).ok; } catch (_) { alive = false; }
      }
      ok('игровой процесс отвечает', alive);
    }

    console.log('\n2. Ключ издателя');
    {
      const bad = await api(token, 'PUT', '/api/play/publisher-key', { publicKey: 'не-ключ' });
      ok('мусор вместо ключа не принят', bad.status === 400, bad.status);
      const good = await api(token, 'PUT', '/api/play/publisher-key', { publicKey: keys.publicKey });
      ok('ключ сохранён', good.status === 200 && good.json?.publisherKey === keys.publicKey, good.json);
    }

    console.log('\n3. Сборка попадает в каталог только с верной подписью');
    {
      const plain = manifestOf('1.0.0');
      const noSign = await api(token, 'POST', '/api/play/builds', { manifest: plain, url: 'http://files/fs/1.0.0/' });
      ok('неподписанная сборка отклонена', noSign.status === 400, noSign.json?.error);

      const forged = { ...plain, signature: signManifest(plain, other.privateKey) };
      const wrongKey = await api(token, 'POST', '/api/play/builds', { manifest: forged, url: 'http://files/fs/1.0.0/' });
      ok('подписанная чужим ключом отклонена', wrongKey.status === 400, wrongKey.json?.error);

      const signed = { ...plain, signature: signManifest(plain, keys.privateKey) };
      const okPush = await api(token, 'POST', '/api/play/builds', { manifest: signed, url: 'http://files/fs/1.0.0/' });
      ok('своя сборка принята', okPush.status === 200, okPush.json);

      // Подмена после подписи: то, ради чего подпись и нужна
      const tampered = { ...signed, files: [{ ...signed.files[0], sha256: sha(9) }] };
      const swapped = await api(token, 'POST', '/api/play/builds', { manifest: tampered, url: 'http://files/fs/1.0.0/' });
      ok('подменённый отпечаток отклонён', swapped.status === 400, swapped.json?.error);
      ok('канонический текст подмены другой', canonicalManifest(tampered as any) !== canonicalManifest(signed as any));

      const read = await api(token, 'GET', '/api/play/builds/fluxstrike');
      ok('выложенное читается обратно', read.json?.result?.build?.version === '1.0.0', read.json?.result?.build);
      ok('и открытый ключ отдан вместе с ним', read.json?.result?.publisherKey === keys.publicKey);

      const newer = manifestOf('1.1.0');
      await api(token, 'POST', '/api/play/builds', {
        manifest: { ...newer, signature: signManifest(newer, keys.privateKey) },
        url: 'http://files/fs/1.1.0/',
      });
      const latest = await api(token, 'GET', '/api/play/builds/fluxstrike');
      ok('нынешней считается последняя выложенная', latest.json?.result?.build?.version === '1.1.0');

      const nothing = await api(token, 'GET', '/api/play/builds/выдуманная-игра');
      ok('о несуществующей игре не рассказывают', nothing.json?.result?.build === null, nothing.json?.result);
    }

    console.log('\n4. Обслуживание: доиграть можно, начать новое нельзя');
    {
      const party = await api(token, 'POST', '/api/play/party', { gameId: 'testgame' }, newKey());
      ok('группа собрана', party.status === 201 || party.status === 200, party.status);
      const lobby = await api(token, 'POST', '/api/play/lobby', { gameId: 'testgame' }, newKey());
      const lobbyId = String(lobby.json?.result?.id || '');
      ok('лобби открыто', !!lobbyId, lobby.json);
      const ready = await api(token, 'POST', '/api/play/lobby/ready', {
        lobbyId, ready: true, expectedVersion: Number(lobby.json?.result?.revision || 0),
      }, newKey());
      ok('готовность отмечена', ready.status === 201 || ready.status === 200, ready.json);

      const on = await api(token, 'PUT', '/api/play/maintenance', { on: true });
      ok('обслуживание включено', on.json?.platform?.maintenance === true, on.json?.platform);

      const blocked = await api(token, 'POST', '/api/play/session', {
        lobbyId, expectedVersion: Number(ready.json?.result?.revision || 0),
      }, newKey());
      ok('матч во время обслуживания не начинается', blocked.json?.code === 'MAINTENANCE', blocked.json);
      ok('и отказ назван человеческими словами', /обслуживани/i.test(String(blocked.json?.message || '')), blocked.json?.message);

      const off = await api(token, 'PUT', '/api/play/maintenance', { on: false });
      ok('обслуживание снято', off.json?.platform?.maintenance === false, off.json?.platform);

      const started = await api(token, 'POST', '/api/play/session', {
        lobbyId, expectedVersion: Number(ready.json?.result?.revision || 0),
      }, newKey());
      ok('после обслуживания матч начинается', started.status === 201 || started.status === 200, started.json);

      console.log('\n5. Идущие матчи видно, и их можно снять');
      const list = await api(token, 'GET', '/api/play/admin/sessions');
      const mine = (list.json?.sessions || []).find((s: any) => s.gameId === 'testgame');
      ok('матч виден администратору', !!mine, list.json?.sessions);
      ok('свежий матч зависшим не считается', mine ? mine.stuck === false : false, mine);

      const cancelled = await api(token, 'POST', `/api/play/admin/cancel/${mine?.id || ''}`, {});
      ok('матч снят', cancelled.json?.cancelled === true, cancelled.json);

      const after = await api(token, 'GET', '/api/play/state');
      ok('места освобождены', after.json?.result?.session === null, after.json?.result?.session);
      ok('лобби вернулось в подготовку', after.json?.result?.lobby?.state === 'FORMING', after.json?.result?.lobby?.state);

      await api(token, 'POST', '/api/play/party/leave', {}, newKey());
    }

    console.log('\n6. Распоряжения — только по праву');
    {
      await api(token, 'PUT', '/api/play/publisher-key', { publicKey: '' });
      await revoke(token, userId);
      const denied = await api(token, 'PUT', '/api/play/maintenance', { on: true });
      ok('без права обслуживание не переключается', denied.status === 404, denied.status);
      ok('и отказ ничего не рассказывает', !/play|платформ/i.test(JSON.stringify(denied.json || {})), denied.json);
    }
  } catch (e: any) {
    ok(`прогон дошёл до конца (${e?.message || e})`, false);
  } finally {
    console.log('\n7. Возвращаем стенд в исходное состояние');
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* уже ушла */ }
    await grant(token, userId, [PLAY_ADMIN]);
    await api(token, 'PUT', '/api/play/maintenance', { on: false });
    await api(token, 'PUT', '/api/play/publisher-key', { publicKey: '' });
    await api(token, 'PUT', '/api/play/platform', { enabled: false });
    await revoke(token, userId);
    const closed = await api(token, 'GET', '/api/play/platform');
    ok('платформа снова закрыта', closed.status === 404, closed.status);
  }

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
