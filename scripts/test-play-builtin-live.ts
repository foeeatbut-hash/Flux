/** Два реальных HTTP-клиента: приглашение, общая доска, фолы и повторы. Только выделенные тестовые сотрудники. */
import assert from 'node:assert/strict';
import { testCredentials } from './testCredentials';
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const SECOND = process.env.FLUX_API2 || BASE;
const credentials = [testCredentials(), testCredentials({ ...process.env, FLUX_USER: process.env.FLUX_USER2, FLUX_PASS: process.env.FLUX_PASS2 })];
let checks = 0;
const check = (name: string, condition: boolean) => { assert.ok(condition, name); checks++; console.log('✓', name); };
const key = () => crypto.randomUUID();
interface Client { id: string; token: string; base: string }
async function call(client: Client | null, method: string, path: string, body?: unknown, requestKey?: string) {
  const response = await fetch(`${client?.base || BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(client ? { Authorization: `Bearer ${client.token}` } : {}), ...(requestKey ? { 'Idempotency-Key': requestKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function main() {
  const clients: Client[] = [];
  for (let i = 0; i < credentials.length; i++) {
    const response = await fetch(`${i ? SECOND : BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials[i]) });
    const text = await response.text();
    assert.ok(response.ok, `Вход HTTP ${response.status}: ${text.slice(0, 600)}`);
    const data = JSON.parse(text) as any;
    assert.ok(data.token && data.user?.id, 'Укажите две выделенные тестовые учётные записи с правами Flux Play');
    clients.push({ token: data.token, id: data.user.id, base: i ? SECOND : BASE });
  }
  const [one, two] = clients;
  check('два разных сотрудника', one.id !== two.id);
  for (const client of clients) { await call(client, 'POST', '/api/play/session/cancel', {}); await call(client, 'POST', '/api/play/party/leave', {}, key()); }
  const inv = await call(one, 'POST', '/api/play/invites', { userId: two.id, gameId: 'billiards' }, key());
  check('приглашение принято сервером', inv.body.ok && !!inv.body.result?.id);
  const inbox = await call(two, 'GET', '/api/play/state');
  check('приглашение видно второму клиенту через БД', inbox.body.result.invites.some((i: any) => i.id === inv.body.result.id));
  const accepted = await call(two, 'POST', `/api/play/invites/${inv.body.result.id}/accept`, {}, key());
  check('принятие приглашения присоединяет второго игрока', accepted.body.ok && accepted.body.result.party.members.length === 2);
  const opened = await call(one, 'POST', '/api/play/lobby', { gameId: 'billiards' }, key());
  assert.ok(opened.body.ok, opened.body.message);
  const lobbyId = opened.body.result.id;
  for (const client of clients) {
    const state = await call(client, 'GET', '/api/play/state');
    const ready = await call(client, 'POST', '/api/play/lobby/ready', { lobbyId, ready: true, expectedVersion: state.body.result.lobby.revision }, key());
    check('готовность игрока сохранена', ready.body.ok);
  }
  const state = await call(one, 'GET', '/api/play/state');
  const started = await call(one, 'POST', '/api/play/session', { lobbyId, expectedVersion: state.body.result.lobby.revision }, key());
  check('матч действительно запущен', started.body.ok && started.body.result.session.state === 'RUNNING');
  const sessionId = started.body.result.session.id, path = `/api/play/match/${sessionId}`;
  const initial = await call(one, 'GET', path), other = await call(two, 'GET', path);
  check('оба клиента видят один стол', JSON.stringify(initial.body.result.view) === JSON.stringify(other.body.result.view));
  const wrong = await call(two, 'POST', `${path}/move`, { move: { type: 'shot', angle: 0, power: 1 }, expectedRevision: initial.body.result.revision }, key());
  check('сервер запрещает чужой ход', !wrong.body.ok);
  const forged = await call(one, 'POST', '/api/play/results', { sessionId, payload: { winnerTeam: 1 }, signature: 'builtin' });
  check('игрок не может прислать себе победу', !forged.body.ok);
  const requestKey = key(), body = { move: { type: 'shot', angle: 0, power: 1 }, expectedRevision: initial.body.result.revision };
  const fired = await call(one, 'POST', `${path}/move`, body, requestKey);
  check('удар рассчитан сервером', fired.body.ok);
  const repeated = await call(one, 'POST', `${path}/move`, body, requestKey);
  check('повтор не делает второго удара', repeated.body.ok && repeated.body.repeated && repeated.body.result.revision === fired.body.result.revision);
  const final = await call(two, 'GET', path);
  check('другой клиент видит новый удар и воспроизведение', final.body.result.revision === fired.body.result.revision && final.body.result.view.shots === 1 && final.body.result.view.lastShot.frames.length > 1);
  const busy = await call(one, 'POST', `${path}/move`, { move: { type: 'shot', angle: 0, power: 1 }, expectedRevision: final.body.result.revision }, key());
  check('нельзя ударить пока шары движутся', !busy.body.ok);
  const stale = await call(one, 'POST', `${path}/move`, body, key());
  check('старая версия не затирает стол', stale.body.code === 'VERSION_CONFLICT');
  const comeback = await call(two, 'POST', '/api/play/session/rejoin', {});
  check('повторный вход возвращает тот же матч', comeback.body.ok && comeback.body.result.session.id === sessionId);
  const resigned = await call(two, 'POST', `${path}/resign`, {}, key());
  check('сдаться завершает реальный матч', resigned.body.ok && resigned.body.result.done);
  for (const client of clients) await call(client, 'POST', '/api/play/party/leave', {}, key());
  console.log(`Сетевой бильярд: ${checks} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exit(1); });
