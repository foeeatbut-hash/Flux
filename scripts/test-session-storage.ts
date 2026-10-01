/** Browser cookie/CSRF boundaries and encrypted desktop persistence, no project data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCookieAuth, authTokenFromRequest, validCsrf } from '../server/authCookies';
import { createSessionVault } from '../electron/sessionVault';

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓', name); };
const secret = 'test-only-cookie-secret';
const cookies = createCookieAuth(secret);
function run(headers: any, method = 'POST', route = '/api/data', secure = false) {
  let next = false;
  const issued = new Map<string, { value: string; options: any }>();
  const response: any = { statusCode: 200, body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    cookie(name: string, value: string, options: any) { issued.set(name, { value, options }); },
    clearCookie(name: string, options: any) { issued.set(name, { value: '', options }); },
    setHeader() {},
  };
  const request: any = { method, path: route, headers, secure, protocol: secure ? 'https' : 'http', get: () => 'flux.test' };
  cookies.middleware(request, response, (() => { next = true; }) as any);
  return { response, issued, request, next };
}
const login = run({ 'x-flux-auth-transport': 'cookie', origin: 'https://flux.test' }, 'POST', '/api/login', true);
login.response.json({ success: true, user: { id: 'u1' }, token: 'opaque-session' });
check('браузер не получает bearer в JSON', !('token' in login.response.body));
check('cookie сессии недоступна JavaScript и передаётся только по HTTPS', login.issued.get('flux_session')?.options.httpOnly && login.issued.get('flux_session')?.options.secure);
check('CSRF cookie доступна клиенту и имеет Strict SameSite', login.issued.get('flux_csrf')?.options.httpOnly === false && login.issued.get('flux_csrf')?.options.sameSite === 'strict');
const csrf = login.issued.get('flux_csrf')!.value;
const cookie = `flux_session=opaque-session; flux_csrf=${csrf}`;
check('подписанный CSRF связан с сессией', validCsrf(csrf, 'opaque-session', secret) && !validCsrf(csrf, 'another-session', secret));
check('чтение через cookie не требует CSRF', run({ cookie }, 'GET').next);
check('запись без CSRF запрещена', run({ cookie }).response.statusCode === 403);
check('запись с правильным CSRF проходит', run({ cookie, 'x-flux-csrf': csrf }).next);
check('подмена обеих копий CSRF не проходит подпись', run({ cookie: 'flux_session=opaque-session; flux_csrf=forged', 'x-flux-csrf': 'forged' }).response.statusCode === 403);
check('повтор CSRF из другой сессии запрещён', run({ cookie: `flux_session=another-session; flux_csrf=${csrf}`, 'x-flux-csrf': csrf }).response.statusCode === 403);
check('явный Office bearer сохраняет свой транспорт', authTokenFromRequest({ headers: { cookie, authorization: 'Bearer office-session' } }) === 'office-session' && run({ cookie, authorization: 'Bearer office-session' }).next);
check('браузерный вход с чужого origin запрещён', run({ 'x-flux-auth-transport': 'cookie', origin: 'https://evil.test' }, 'POST', '/api/login').response.statusCode === 403);
const desktop = run({ 'x-flux-auth-transport': 'electron' }, 'POST', '/api/login');
desktop.response.json({ success: true, token: 'desktop-session' });
check('Electron получает bearer без browser cookies', desktop.response.body.token === 'desktop-session' && desktop.issued.size === 0);
cookies.clear(login.request, login.response);
check('выход удаляет обе cookie', login.issued.get('flux_session')?.value === '' && login.issued.get('flux_csrf')?.value === '');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-vault-test-'));
try {
  const key = crypto.randomBytes(32);
  let available = true;
  const encryption = {
    available: () => available,
    encrypt: (value: string) => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt: (value: Buffer) => {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    },
  };
  const vault = createSessionVault(directory, 'https://flux.test', encryption);
  check('desktop сессия переживает перезапуск через зашифрованный файл', vault.write('secret-bearer-token').persisted && createSessionVault(directory, 'https://flux.test', encryption).read() === 'secret-bearer-token');
  check('на диске нет открытого bearer', !fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])).includes(Buffer.from('secret-bearer-token')));
  check('другой сервер не получает прежний токен', createSessionVault(directory, 'https://another.test', encryption).read() === '');
  available = false;
  check('недоступное шифрование не имеет plaintext fallback', !vault.write('another-token').persisted && fs.readdirSync(directory).length === 0 && vault.read() === '');
  available = true;
  vault.write('secret-bearer-token'); vault.write('');
  check('выход удаляет persistent token', vault.read() === '' && fs.readdirSync(directory).length === 0);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log(`${checks} проверок пройдено`);
