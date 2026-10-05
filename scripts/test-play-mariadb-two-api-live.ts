/** Проверка Дурака и бильярда через два HTTP API, подключённых к одному тестовому MariaDB. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerTestLogin } from './fixtures/ownerTestLogin';
import { APP_PLAY, PLAY_ADMIN, gameEntitlement } from '../play/features';
import { durakRank, durakSuit, type DurakMove, type DurakView } from '../play/games/durak';
import { rngOf } from '../play/games/kit';

type Client = { id: string; token: string; base: string; tokens?: Record<string, string>; credentials: { symbol: string; password: string } };
let firstApi = process.env.FLUX_API || '';
let secondApi = process.env.FLUX_API2 || '';
function check(message: string, condition: unknown): void { assert.ok(condition, message); }
let checks = 0;
function passed(message: string, condition: unknown): asserts condition {
  assert.ok(condition, message); checks++; console.log(`✓ ${message}`);
}
async function request(client: Client | null, method: string, route: string, body?: unknown, key = crypto.randomUUID(), base?: string) {
  const response = await fetch(`${base || client?.base || firstApi}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(client ? { Authorization: `Bearer ${client.tokens?.[new URL(base || client.base).origin] || client.token}` } : {}), 'Idempotency-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status} вернул не JSON для ${route}`); }
  return { status: response.status, data };
}
function loopback(url: string): boolean {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}
async function login(base: string, credentials: Client['credentials']): Promise<Client> {
  const response = await request(null, 'POST', '/api/login', credentials, undefined, base);
  check(`HTTP вход ${response.status}: ${response.data.error || ''}`, response.status === 200 && response.data.token && response.data.user?.id);
  return { id: response.data.user.id, token: response.data.token, base, tokens: { [new URL(base).origin]: response.data.token }, credentials };
}
async function inviteAndStart(players: Client[], gameId: 'cards' | 'billiards'): Promise<string> {
  const leader = players[0];
  for (const teammate of players.slice(1)) {
    const invitation = await request(leader, 'POST', '/api/play/invites', { userId: teammate.id, gameId });
    check(`Приглашение ${gameId} HTTP ${invitation.status} (${invitation.data.code || invitation.data.error || invitation.data.message || 'no result'})`, invitation.data.ok && invitation.data.result?.id);
    const accepted = await request(teammate, 'POST', `/api/play/invites/${invitation.data.result.id}/accept`, {});
    check(`Принятие приглашения ${gameId}: ${accepted.data.message || ''}`, accepted.data.ok);
  }
  const seats = gameId === 'cards' ? players.length : 2;
  const opened = await request(leader, 'POST', '/api/play/lobby', { gameId, seats });
  check(`Лобби ${gameId} создано: ${opened.data.message || ''}`, opened.data.ok && opened.data.result?.id);
  const lobbyId = opened.data.result.id;
  if (gameId === 'cards' && players.length >= 3) {
    const nonLeader = await request(players[1], 'POST', '/api/play/lobby/seats', { lobbyId, seats, expectedVersion: opened.data.result.revision });
    check('Игрок не меняет выбранные места за ведущего', !nonLeader.data.ok);
    const smaller = seats - 1;
    const changed = await request(leader, 'POST', '/api/play/lobby/seats', { lobbyId, seats: smaller, expectedVersion: opened.data.result.revision });
    check('Ведущий меняет число мест в серверной комнате', changed.data.ok && changed.data.result.seats === smaller);
    const remote = await request(players[1], 'GET', '/api/play/state');
    check('Выбранное число мест читается со второго API', remote.data.result.lobby.seats === smaller);
    const expanded = await request(leader, 'POST', '/api/play/lobby/seats', { lobbyId, seats, expectedVersion: changed.data.result.revision });
    check('Ведущий может вернуть свободные места перед стартом', expanded.data.ok && expanded.data.result.seats === seats);
  }
  for (const player of players) {
    const state = await request(player, 'GET', '/api/play/state');
    check(`Состояние ${gameId} загружено`, !!state.data.result?.lobby);
    const ready = await request(player, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: state.data.result.lobby.revision });
    check(`Игрок готов к ${gameId}: ${ready.data.message || ''}`, ready.data.ok);
  }
  const state = await request(leader, 'GET', '/api/play/state');
  const started = await request(leader, 'POST', '/api/play/session', { lobbyId, expectedVersion: state.data.result.lobby.revision });
  check(`Матч ${gameId} запущен: ${started.data.message || ''}`, started.data.ok && started.data.result?.session?.state === 'RUNNING');
  return started.data.result.session.id;
}
async function historyHas(client: Client, sessionId: string): Promise<boolean> {
  const response = await request(client, 'GET', '/api/play/history');
  const rows = Array.isArray(response.data.result) ? response.data.result : response.data.result?.matches || [];
  return rows.some((row: any) => row.id === sessionId || row.sessionId === sessionId);
}

async function enableFixturePlay(metadata: any, api: string): Promise<void> {
  const owner = await ownerTestLogin(api);
  passed('Вход источниковым тестовым владельцем стенда', !!owner.token && owner.user?.role === 'OWNER');
  const list = await request({ id: owner.user.id, token: owner.token, base: api, credentials: { symbol: '', password: '' } }, 'GET', '/api/users');
  const rows = Array.isArray(list.data.users) ? list.data.users : Array.isArray(list.data) ? list.data : [];
  const accounts = metadata.accounts as Array<{ id: string; symbol: string; group?: string; role: string }>;
  const games = ['cards', 'billiards'].map(gameEntitlement);
  const grants = [APP_PLAY, ...games, 'play.party.create', 'play.session.start'];
  for (const account of accounts) {
    const row = rows.find((item: any) => item.id === account.id);
    check(`Fixture профиль ${account.symbol} найден для выдачи прав`, row);
    let permissions: Record<string, any> = {};
    try { permissions = row.permissions ? JSON.parse(row.permissions) : {}; } catch { permissions = {}; }
    for (const key of grants) permissions[key] = { enabled: true, until: null, mode: 'ALLOW' };
    if (account.role === 'ADMIN') permissions[PLAY_ADMIN] = { enabled: true, until: null, mode: 'ALLOW' };
    const updated = await request({ id: owner.user.id, token: owner.token, base: api, credentials: { symbol: '', password: '' } }, 'PUT', `/api/users/${encodeURIComponent(account.id)}`, { permissions: JSON.stringify(permissions) });
    passed(`Выданы тестовые права Play профилю ${account.symbol}`, updated.status === 200 && updated.data.success === true);
  }
  const turnedOn = await request({ id: owner.user.id, token: owner.token, base: api, credentials: { symbol: '', password: '' } }, 'PUT', '/api/play/platform', { enabled: true });
  passed('MariaDB поддерживает и включает платформу для выделенного стенда', turnedOn.status === 200 && turnedOn.data.platform?.enabled === true && turnedOn.data.platform?.supported === true);
}

async function main() {
  assert.equal(process.env.FLUX_TEST_FIXTURE, '1', 'Установите FLUX_TEST_FIXTURE=1 только для выделенного тестового стенда');
  const fixturePath = path.resolve(process.env.FLUX_REMAINING_LIVE_METADATA || path.join(os.tmpdir(), 'flux-remaining-live.json'));
  const metadata = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(metadata.kind, 'flux-remaining-live-fixture', 'Метаданные должны принадлежать выделенному remaining-live fixture');
  assert.match(String(metadata.mariaDbVersion || ''), /mariadb/i, 'Стенд обязан подтвердить версию MariaDB');
  assert.match(String(metadata.databaseName || ''), /^flux_[a-z0-9_]*fixture[a-z0-9_]*$/i, 'Ожидается отдельная тестовая база fixture');
  const fixtureServers = metadata.servers?.map((server: any) => server.origin) || [];
  assert.equal(fixtureServers.length, 2, 'В метаданных должны быть два API fixture');
  const apiA = firstApi || fixtureServers[0];
  const apiB = secondApi || fixtureServers[1];
  assert.deepEqual([new URL(apiA).origin, new URL(apiB).origin].sort(), fixtureServers.map((x: string) => new URL(x).origin).sort(), 'API адреса должны совпадать с закрытыми метаданными стенда');
  assert.equal(new URL(apiA).origin, new URL(fixtureServers[0]).origin);
  assert.equal(new URL(apiB).origin, new URL(fixtureServers[1]).origin);
  // Никаких URL или паролей базы в fixture файле не ожидается.
  assert.ok(!JSON.stringify(metadata).match(/mysql(?:2)?:\/\/[^\s"']+/i), 'Метаданные не должны содержать database URL');
  firstApi = apiA; secondApi = apiB;
  assert.ok(loopback(firstApi) && loopback(secondApi), 'Оба API должны быть доступны только через loopback');
  assert.notEqual(new URL(apiA).origin, new URL(apiB).origin, 'Нужны два разных HTTP API');
  const accounts = metadata.accounts || [];
  const creds = [1, 2, 3, 4, 5].map(index => {
    const account = accounts.find((item: any) => item.symbol === `fixture.user${index}.${String(accounts[1]?.symbol || '').split('.').at(-1)}`);
    const byIndex = accounts.find((item: any) => item.group === (index <= 4 ? 'play' : 'outsider') && item.symbol?.includes(`user${index}.`));
    const found = account || byIndex;
    check(`Fixture учётная запись user${index} существует`, found?.id && found.password && found.symbol);
    return { symbol: found.symbol, password: found.password };
  });
  check('Fixture роли разделяют игроков и посторонних', accounts.find((a: any) => a.symbol === creds[0].symbol)?.group === 'play' && accounts.find((a: any) => a.symbol === creds[4].symbol)?.group === 'outsider');

  // Все вызовы идут через настоящие API; учётки игроков/постороннего обязаны
  // быть разными, а запросы чередуются между обоими процессами.
  const clients: Client[] = [];
  for (let i = 0; i < creds.length; i++) clients.push(await login(i % 2 ? apiB : apiA, creds[i]));
  await enableFixturePlay(metadata, apiA);
  for (let i = 0; i < clients.length; i++) {
    const tokenA = await login(apiA, creds[i]), tokenB = await login(apiB, creds[i]);
    clients[i] = { ...tokenA, tokens: { [new URL(apiA).origin]: tokenA.token, [new URL(apiB).origin]: tokenB.token } };
  }
  const players = clients.slice(0, 4), outsider = clients[4];
  passed('Пять отдельных сессий вошли через оба HTTP API', new Set(clients.map(item => item.id)).size === 5);
  for (const client of players) {
    await request(client, 'POST', '/api/play/session/cancel', {});
    await request(client, 'POST', '/api/play/party/leave', {});
  }

  const durakId = await inviteAndStart(players.slice(0, 4), 'cards');
  const durakRoute = `/api/play/match/${durakId}`;
  const outsiderState = await request(outsider, 'GET', '/api/play/state');
  passed('Посторонний не видит партию или выбранное число мест', !outsiderState.data.result.lobby && !outsiderState.data.result.party);
  const initialViews = await Promise.all(players.slice(0, 4).map(player => request(player, 'GET', durakRoute)));
  const initial = initialViews[0].data.result;
  check('Дурак рассчитан для четырёх мест', initial.seats.length === 4 && initial.view.hand.length === 6 && initial.view.deckCount === 12);
  const hands = initialViews.map(response => response.data.result.view.hand as string[]);
  for (const response of initialViews) {
    const view = response.data.result.view;
    assert.ok(!('hands' in view) && !('deck' in view) && !('seed' in view));
    assert.ok(!('seed' in response.data.result));
  }
  passed('Дурак раскрывает каждому только личную руку и скрывает колоду/seed', new Set(hands.flat()).size === 24);
  const unauthenticated = await request(null, 'GET', durakRoute);
  passed('Доска Дурака требует вход', unauthenticated.status === 401);
  const deniedDurak = await request(outsider, 'GET', durakRoute);
  passed('Посторонний не получает состояние Дурака', !deniedDurak.data.result);

  const firstActor = players.find(player => player.id === initial.turnUserId)!;
  const other = players.find(player => player.id !== initial.turnUserId)!;
  const actorState = (await request(firstActor, 'GET', durakRoute)).data.result;
  const card = actorState.view.allowed.attack[0];
  const attackBody = { move: { type: 'attack', card }, expectedRevision: actorState.revision };
  const attackKey = crypto.randomUUID();
  const attack = await request(firstActor, 'POST', `${durakRoute}/move`, attackBody, attackKey, apiA);
  passed('Ход Дурака записан общей MariaDB через первый API', attack.data.ok);
  const replay = await request(firstActor, 'POST', `${durakRoute}/move`, attackBody, attackKey, apiB);
  passed('Повтор того же ключа через второй API не удваивает ход', replay.data.ok && replay.data.repeated && replay.data.result.revision === attack.data.result.revision);
  const afterAttack = (await request(other, 'GET', durakRoute)).data.result;
  passed('Второй API читает новую ревизию из общей MariaDB', afterAttack.revision === attack.data.result.revision);
  const wrongTurn = await request(other, 'POST', `${durakRoute}/move`, { move: { type: 'pass' }, expectedRevision: afterAttack.revision });
  passed('Дурак отклоняет ход неактивного игрока', !wrongTurn.data.ok);
  const stale = await request(firstActor, 'POST', `${durakRoute}/move`, attackBody);
  passed('Старая ревизия Дурака отклонена', stale.data.code === 'VERSION_CONFLICT');
  const missingRevision = await request(firstActor, 'POST', `${durakRoute}/move`, { move: { type: 'pass' } });
  passed('Дурак требует ожидаемую ревизию', !missingRevision.data.ok);

  // Повторный вход выпускает новую HTTP-сессию и проверяет восстановление на
  // другом процессе API, а не сохранённый токен исходного клиента.
  const reconnect = await login(secondApi, players[2].credentials);
  const rejoined = await request(reconnect, 'POST', '/api/play/session/rejoin', {});
  const recovered = await request(reconnect, 'GET', durakRoute);
  passed('Повторный вход через второй API восстанавливает ту же партию и ревизию', rejoined.data.ok && rejoined.data.result.session.id === durakId && recovered.data.result.revision === attack.data.result.revision);
  players[2] = reconnect;

  const random = rngOf('mariadb-two-api-durak');
  let steps = 1, ended = false;
  while (!ended && steps < 1000) {
    const common = (await request(players[0], 'GET', durakRoute)).data.result;
    if (common.done) { ended = true; break; }
    const actor = players.find(player => player.id === common.turnUserId);
    check('Матч Дурака сохраняет активного игрока на каждом ходе', actor);
    const snapshot = (await request(actor!, 'GET', durakRoute)).data.result;
    const view = snapshot.view as DurakView;
    let move: DurakMove;
    if (view.allowed.defend.length) {
      const defenses = [...view.allowed.defend].sort((a, b) => (durakSuit(a.card) === view.trumpSuit ? 100 : 0) + durakRank(a.card) - ((durakSuit(b.card) === view.trumpSuit ? 100 : 0) + durakRank(b.card)));
      move = { type: 'defend', ...defenses[0] };
    } else if (view.allowed.transfer.length) move = { type: 'transfer', card: view.allowed.transfer[0] };
    else if (view.allowed.take) move = { type: 'take' };
    else if (view.allowed.attack.length && (!view.allowed.pass || random() < 0.8)) move = { type: 'attack', card: view.allowed.attack[Math.floor(random() * view.allowed.attack.length)] };
    else if (view.allowed.pass) move = { type: 'pass' };
    else throw new Error('Дурак: сервер не выдал допустимое действие');
    const result = await request(actor!, 'POST', `${durakRoute}/move`, { move, expectedRevision: snapshot.revision });
    check(`Ход Дурака ${steps + 1} принят: ${result.data.code || ''}`, result.data.ok);
    steps++; ended = !!result.data.result.done;
  }
  passed(`Партия Дурака завершилась через два API за ${steps} ходов`, ended && steps > 20);
  const result = await request(players[1], 'GET', `/api/play/session/${durakId}/result`);
  passed('Участник получает результат Дурака через второй API', !!result.data.result);
  const outsiderResult = await request(outsider, 'GET', `/api/play/session/${durakId}/result`);
  passed('Посторонний не читает результат Дурака', !outsiderResult.data.result);
  passed('Завершённая партия Дурака попадает в историю участника', await historyHas(players[0], durakId));
  passed('История Дурака постороннего не содержит чужую партию', !(await historyHas(outsider, durakId)));
  const closedMove = await request(players[0], 'POST', `${durakRoute}/move`, { move: { type: 'pass' }, expectedRevision: recovered.data.result.revision });
  passed('Закрытый матч Дурака нельзя продолжить устаревшим ходом', !closedMove.data.ok);

  for (const player of players.slice(0, 2)) {
    await request(player, 'POST', '/api/play/session/cancel', {});
    await request(player, 'POST', '/api/play/party/leave', {});
  }
  const billiardsPlayers = players.slice(0, 2);
  const billiardsId = await inviteAndStart(billiardsPlayers, 'billiards');
  const billiardsRoute = `/api/play/match/${billiardsId}`;
  const opening = await Promise.all(billiardsPlayers.map(player => request(player, 'GET', billiardsRoute)));
  passed('Оба API видят одну начальную доску бильярда', opening.every(response => response.data.result.revision === opening[0].data.result.revision));
  const billiardsFirst = opening[0].data.result;
  const billiardsOutsider = await request(outsider, 'GET', billiardsRoute);
  passed('Посторонний не получает доску бильярда', !billiardsOutsider.data.result);
  const shooter = billiardsPlayers.find(player => player.id === billiardsFirst.turnUserId)!;
  const nonShooter = billiardsPlayers.find(player => player.id !== shooter.id)!;
  const wrongShot = await request(nonShooter, 'POST', `${billiardsRoute}/move`, { move: { type: 'shot', angle: 0, power: 1 }, expectedRevision: billiardsFirst.revision });
  passed('Бильярд запрещает удар неактивного игрока', !wrongShot.data.ok);
  const shotBody = { move: { type: 'shot', angle: 0, power: 0.5 }, expectedRevision: billiardsFirst.revision };
  const shotKey = crypto.randomUUID();
  const shot = await request(shooter, 'POST', `${billiardsRoute}/move`, shotBody, shotKey);
  passed('Удар бильярда рассчитан сервером', shot.data.ok);
  const shotReplay = await request(shooter, 'POST', `${billiardsRoute}/move`, shotBody, shotKey, secondApi);
  passed('Повтор удара с тем же ключом не создаёт второго удара', shotReplay.data.ok && shotReplay.data.repeated && shotReplay.data.result.revision === shot.data.result.revision);
  const billiardsStale = await request(shooter, 'POST', `${billiardsRoute}/move`, shotBody);
  passed('Старая ревизия бильярда отклонена', billiardsStale.data.code === 'VERSION_CONFLICT');
  const latest = (await request(nonShooter, 'GET', billiardsRoute)).data.result;
  const reconnectBilliards = await login(secondApi, billiardsPlayers[1].credentials);
  const billiardsRejoin = await request(reconnectBilliards, 'POST', '/api/play/session/rejoin', {});
  const billiardsRecovered = await request(reconnectBilliards, 'GET', billiardsRoute);
  passed('Новая сессия восстанавливает бильярд и последнюю доску через второй API', billiardsRejoin.data.ok && billiardsRejoin.data.result.session.id === billiardsId && billiardsRecovered.data.result.revision === latest.revision);
  const resignation = await request(nonShooter, 'POST', `${billiardsRoute}/resign`, {});
  passed('Сдача завершает матч бильярда', resignation.data.ok && resignation.data.result.done);
  passed('Завершённый бильярд доступен участнику в истории', await historyHas(billiardsPlayers[0], billiardsId));
  passed('Посторонний не видит бильярд в истории', !(await historyHas(outsider, billiardsId)));
  const postFinish = await request(shooter, 'POST', `${billiardsRoute}/move`, { move: { type: 'shot', angle: 0, power: 0.5 }, expectedRevision: billiardsRecovered.data.result.revision });
  passed('После завершения бильярда ходить нельзя', !postFinish.data.ok);

  for (const player of players) {
    await request(player, 'POST', '/api/play/session/cancel', {});
    await request(player, 'POST', '/api/play/party/leave', {});
  }
  console.log(`MariaDB, два HTTP API, Дурак и бильярд: ${checks} проверок пройдено`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
