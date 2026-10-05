/** Exercise the real fetch wrapper without React or a live server. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };
const remote = process.argv.includes('--remote');
const apiOrigin = 'https://flux.test';
const storage = new Map([['flux_auth_token', 'legacy-unencrypted-token']]);
if (remote) storage.set('flux_server_url', 'https://old-external.example.test');
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
const location = { href: 'https://flux.test/', origin: 'https://flux.test', protocol: 'https:' };
(globalThis as any).location = location;
(globalThis as any).document = { cookie: 'flux_csrf=csrf-test-value' };
let last: { input: any; init: RequestInit };
let responseStatus = 200;
const windowMock: any = {
  location, dispatchEvent() {},
  fetch: async (input: any, init: RequestInit = {}) => { last = { input, init }; return new Response('{}', { status: responseStatus, headers: { 'Content-Type': 'application/json' } }); },
};
(globalThis as any).window = windowMock;

(async () => {
  const auth = await import('../src/config/env');
  (globalThis as any).fetch = windowMock.fetch;
  check('старый localStorage bearer удалён до первого запроса', !storage.has('flux_auth_token') && auth.getAuthToken() === '');
  check('старый внешний адрес удалён до передачи учётных данных', !storage.has('flux_server_url') && auth.getConfiguredServerUrl() === '');
  await windowMock.fetch('/api/login', { method: 'POST' });
  check(remote ? 'legacy external URL удаляется, login остается same-origin' : 'same-origin browser login выбирает cookie transport', new Headers(last.init.headers).get('X-Flux-Auth-Transport') === 'cookie' && last.init.credentials === 'include');
  check(remote ? 'legacy external URL не меняет CSRF transport' : 'cookie browser mutation передаёт CSRF без bearer', new Headers(last.init.headers).get('X-Flux-CSRF') === 'csrf-test-value' && !new Headers(last.init.headers).has('Authorization'));
  await auth.setAuthToken('memory-session-token');
  check('временный bearer хранится только в памяти', auth.getAuthToken() === 'memory-session-token' && !storage.has('flux_auth_token'));
  await windowMock.fetch('/api/projects');
  check('bearer отправляется выбранному API', new Headers(last.init.headers).get('Authorization') === 'Bearer memory-session-token');
  await windowMock.fetch('https://foreign.test/api/collect', { method: 'POST' });
  check('чужой /api/ URL не получает bearer, cookie credentials или CSRF', !new Headers(last.init.headers).has('Authorization') && !new Headers(last.init.headers).has('X-Flux-CSRF') && last.init.credentials !== 'include');
  const ipc: any[] = [];
  windowMock.electron = { ipcRenderer: { invoke: async (...args: any[]) => { ipc.push(args); return args[0] === 'auth:read-session' ? 'encrypted-restored-session' : { persisted: true }; } } };
  await auth.initializeAuthToken();
  check('Electron восстанавливает сессию через main IPC с привязкой к origin', auth.getAuthToken() === 'encrypted-restored-session' && ipc[0][0] === 'auth:read-session' && ipc[0][1] === apiOrigin);
  await auth.setAuthToken('desktop-session');
  check('Electron сохраняет только через main IPC', ipc[1][0] === 'auth:write-session' && ipc[1][1] === 'desktop-session' && ipc[1][2] === apiOrigin && !storage.has('flux_auth_token'));
  responseStatus = 503;
  const failedLogout = await auth.logoutSession();
  check('ошибка БД не блокирует локальный выход, удалённый отзыв не симулируется', !failedLogout.remoteRevoked && auth.getAuthToken() === '' && ipc.at(-1)?.[1] === '');
  await auth.initializeAuthToken();
  check('старый persistent token не восстанавливается после локального выхода', auth.getAuthToken() === '' && auth.getAuthSessionKey() === '');
  await auth.setAuthToken('desktop-session-2');
  auth.markSessionEstablished();
  check('явный новый вход снимает локальную блокировку восстановления', auth.getAuthSessionKey() === 'desktop-session-2');
  responseStatus = 200;
  await auth.logoutSession();
  check('выход отзывает сессию сервером до удаления persistent token', String(last.input).endsWith('/api/logout') && last.init.method === 'POST' && ipc.at(-1)?.[1] === '' && auth.getAuthToken() === '');
  console.log(`${checks} проверок пройдено`);
  if (!remote) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', __filename, '--remote'], { encoding: 'utf8' });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0, 'cross-origin session checks');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
