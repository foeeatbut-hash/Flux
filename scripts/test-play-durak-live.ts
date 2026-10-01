/** Настоящие HTTP-сессии трёх сотрудников на двух серверах общей временной PostgreSQL. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { testCredentials } from './testCredentials';
import { durakRank, durakSuit, type DurakMove, type DurakView } from '../play/games/durak';
import { rngOf } from '../play/games/kit';
const BASE = process.env.FLUX_API!;
const SECOND = process.env.FLUX_API2!;
interface HttpClient { id: string; token: string; base: string; credentials: { symbol: string; password: string } }
let checks = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); checks++; console.log('✓', name); };
async function request(client: HttpClient | null, method: string, route: string, body?: unknown, key = crypto.randomUUID(), base?: string) {
  const response = await fetch(`${base || client?.base || BASE}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(client ? { Authorization: `Bearer ${client.token}` } : {}), 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.headers.get('content-type')?.includes('json'), `HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { status: response.status, data: JSON.parse(text) as any };
}
async function main() {
  const database = new URL(process.env.FLUX_PG_URL || '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && /^\/flux_play_test_[a-f0-9]+$/.test(database.pathname), 'Только одноразовая локальная PostgreSQL тестового стенда');
  for (const endpoint of [BASE, SECOND]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname));
  const credentials = [testCredentials(), ...[2, 3, 4].map(index => testCredentials({ ...process.env, FLUX_USER: process.env[`FLUX_USER${index}`], FLUX_PASS: process.env[`FLUX_PASS${index}`] }))];
  assert.ok(credentials.every(person => person.symbol.startsWith('pg-play-')), 'Требуются только выделенные пользователи временного PostgreSQL стенда');
  const clients: HttpClient[] = [];
  for (const [index, person] of credentials.entries()) {
    const base = index % 2 ? SECOND : BASE;
    const response = await request(null, 'POST', '/api/login', person, undefined, base);
    assert.ok(response.data.token && response.data.user?.id, 'HTTP вход настоящего сотрудника');
    clients.push({ id: response.data.user.id, token: response.data.token, base, credentials: person });
  }
  const players = clients.slice(0, 3), outsider = clients[3];
  check('Три игрока и посторонний вошли настоящими разными сессиями', new Set(clients.map(client => client.id)).size === 4);
  for (const client of players) { await request(client, 'POST', '/api/play/session/cancel', {}); await request(client, 'POST', '/api/play/party/leave', {}); }
  for (const teammate of players.slice(1)) {
    const invitation = await request(players[0], 'POST', '/api/play/invites', { userId: teammate.id, gameId: 'cards' });
    assert.ok(invitation.data.ok, invitation.data.message);
    const accepted = await request(teammate, 'POST', `/api/play/invites/${invitation.data.result.id}/accept`, {});
    assert.ok(accepted.data.ok, accepted.data.message);
  }
  const snapshot = await request(players[1], 'GET', '/api/play/state');
  check('Группа из трёх сотрудников видна через вторую HTTP-инстанцию', snapshot.data.result.party.members.length === 3);
  async function start(): Promise<string> {
    const opened = await request(players[0], 'POST', '/api/play/lobby', { gameId: 'cards' });
    assert.ok(opened.data.ok, opened.data.message);
    const lobbyId = opened.data.result.id;
    for (const client of players) {
      const snapshot = await request(client, 'GET', '/api/play/state');
      const ready = await request(client, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: snapshot.data.result.lobby.revision });
      assert.ok(ready.data.ok, ready.data.message);
    }
    const readyState = await request(players[0], 'GET', '/api/play/state');
    const started = await request(players[0], 'POST', '/api/play/session', { lobbyId, expectedVersion: readyState.data.result.lobby.revision });
    assert.ok(started.data.ok && started.data.result.session.state === 'RUNNING', started.data.message);
    return started.data.result.session.id;
  }
  const sessionId = await start(), route = `/api/play/match/${sessionId}`;
  const snapshots = await Promise.all(players.map(client => request(client, 'GET', route)));
  const first = snapshots[0].data.result;
  check('Матч действительно рассчитан сервером для трёх мест', first.seats.length === 3 && first.view.hand.length === 6 && first.view.deckCount === 18);
  for (const [index, saved] of snapshots.entries()) {
    const view = saved.data.result.view as DurakView;
    assert.equal(view.seat, first.seats.indexOf(players[index].id));
    assert.ok(!('hands' in view) && !('deck' in view) && !('seed' in view));
    assert.ok(!('seed' in saved.data.result));
  }
  check('Каждому отдана только его рука; колода и семя не раскрыты', new Set(snapshots.flatMap(response => response.data.result.view.hand)).size === 18);
  const unauthorized = await request(null, 'GET', route);
  check('Доска требует действительную сессию', unauthorized.status === 401);
  const forbidden = await request(outsider, 'GET', route);
  check('Посторонний не получает чужие карты и состояние матча', !forbidden.data.result);
  const owner = players.find(client => client.id === first.seats[0])!;
  const nonOwner = players.find(client => client.id !== owner.id)!;
  const deniedConfig = await request(nonOwner, 'POST', `${route}/move`, { move: { type: 'configure', variant: 'transfer', deckSize: 52 }, expectedRevision: first.revision });
  check('Правила до первого хода меняет только создатель', !deniedConfig.data.ok);
  const configured = await request(owner, 'POST', `${route}/move`, { move: { type: 'configure', variant: 'transfer', deckSize: 36 }, expectedRevision: first.revision });
  check('Переводной Дурак выбран действительным серверным действием', configured.data.ok);
  const current = (await request(players[0], 'GET', route)).data.result;
  const actor = players.find(client => client.id === current.turnUserId)!;
  const own = (await request(actor, 'GET', route)).data.result;
  const card = own.view.allowed.attack[0];
  const body = { move: { type: 'attack', card }, expectedRevision: own.revision }, idempotency = crypto.randomUUID();
  const attack = await request(actor, 'POST', `${route}/move`, body, idempotency);
  check('Первая атака принята и записана общей БД', attack.data.ok);
  const replay = await request(actor, 'POST', `${route}/move`, body, idempotency);
  check('Повтор запроса не кладёт карту повторно', replay.data.ok && replay.data.repeated && replay.data.result.revision === attack.data.result.revision);
  const stale = await request(actor, 'POST', `${route}/move`, body);
  check('Устаревшая ревизия не изменяет матч', stale.data.code === 'VERSION_CONFLICT');
  const missingRevision = await request(actor, 'POST', `${route}/move`, { move: { type: 'pass' } });
  check('Ход без актуальной ревизии отклонён', !missingRevision.data.ok);
  const loginAgain = await request(null, 'POST', '/api/login', players[2].credentials, undefined, SECOND);
  const reconnect = { ...players[2], token: loginAgain.data.token, base: SECOND };
  const rejoined = await request(reconnect, 'POST', '/api/play/session/rejoin', {});
  const recovered = await request(reconnect, 'GET', route);
  check('Новая сессия на другом сервере восстанавливает тот же матч и ревизию', rejoined.data.ok && rejoined.data.result.session.id === sessionId && recovered.data.result.revision === attack.data.result.revision);
  players[2] = reconnect;
  const random = rngOf('postgres-network-durak');
  let steps = 1, ended = false;
  while (!ended && steps < 1000) {
    const common = (await request(players[0], 'GET', route)).data.result;
    if (common.done) { ended = true; break; }
    const actor = players.find(client => client.id === common.turnUserId); assert.ok(actor, 'Партия не зависает без активного игрока');
    const match = (await request(actor!, 'GET', route)).data.result;
    const view = match.view as DurakView;
    let move: DurakMove;
    if (view.allowed.defend.length) {
      const defenses = [...view.allowed.defend].sort((a, b) => (durakSuit(a.card) === view.trumpSuit ? 100 : 0) + durakRank(a.card) - ((durakSuit(b.card) === view.trumpSuit ? 100 : 0) + durakRank(b.card)));
      move = { type: 'defend', ...defenses[0] };
    } else if (view.allowed.transfer.length) move = { type: 'transfer', card: view.allowed.transfer[0] };
    else if (view.allowed.take) move = { type: 'take' };
    else if (view.allowed.attack.length && (!view.allowed.pass || random() < 0.8)) move = { type: 'attack', card: view.allowed.attack[Math.floor(random() * view.allowed.attack.length)] };
    else if (view.allowed.pass) move = { type: 'pass' };
    else throw new Error('На сервере нет допустимого следующего хода');
    const sent = await request(actor!, 'POST', `${route}/move`, { move, expectedRevision: match.revision });
    assert.ok(sent.data.ok, `${sent.data.code}: ${sent.data.message}`); steps++; ended = sent.data.result.done;
  }
  check(`Настоящая партия из трёх сотрудников дошла до конца за ${steps} ходов`, ended && steps > 20);
  const result = await request(players[1], 'GET', `/api/play/session/${sessionId}/result`);
  check('Результат Дурака виден сотруднику через второй сервер', !!result.data.result?.details && Array.isArray(result.data.result.details.winners));
  const outsidersResult = await request(outsider, 'GET', `/api/play/session/${sessionId}/result`);
  check('Посторонний не читает результат чужой группы', !outsidersResult.data.result);
  const retiredSession = await start(), retiredRoute = `/api/play/match/${retiredSession}`;
  const retire = await request(players[2], 'POST', `${retiredRoute}/resign`, {});
  check('Сдача одного из троих оставляет остальных в RUNNING', retire.data.ok && !retire.data.result.done);
  const continued = (await request(players[0], 'GET', retiredRoute)).data.result;
  check('Оставшиеся видят ушедшего и активную партию на общем сервере', !continued.done && continued.view.quitters.includes(continued.seats.indexOf(players[2].id)));
  const repeatRetire = await request(players[2], 'POST', `${retiredRoute}/resign`, {});
  check('Повторная сдача ушедшего не меняет исход партии', !repeatRetire.data.ok);
  const remainingActor = players.find(client => client.id === continued.turnUserId)!;
  const remaining = (await request(remainingActor, 'GET', retiredRoute)).data.result;
  const played = await request(remainingActor, 'POST', `${retiredRoute}/move`, { move: { type: 'attack', card: remaining.view.allowed.attack[0] }, expectedRevision: remaining.revision });
  check('Два оставшихся сотрудника продолжают ходить после ухода третьего', played.data.ok);
  const quitAgain = await request(players[1], 'POST', `${retiredRoute}/resign`, {});
  check('Уход второго завершает матч с правильным оставшимся победителем', quitAgain.data.ok && quitAgain.data.result.done);
  const retiredResult = await request(players[0], 'GET', `/api/play/session/${retiredSession}/result`);
  check('Вышедшие не записываются победителями', JSON.stringify(retiredResult.data.result.details.winners) === JSON.stringify([players[0].id]) && retiredResult.data.result.details.quitters.length === 2);
  for (const client of players) await request(client, 'POST', '/api/play/party/leave', {});
  console.log(`Сетевой Дурак: ${checks} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
