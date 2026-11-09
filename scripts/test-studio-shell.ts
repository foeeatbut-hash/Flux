/**
 * Оболочка Flux Studio: вход разработчика через настоящие маршруты сервера.
 *
 * Главный процесс собирается как в программе (esbuild), но вместо Electron и запуска
 * Flux подставлены заглушки; сервер — настоящие маршруты studio.ts за проверкой токена.
 *
 * Что доказывается:
 * - подключение → вход → список подпрограмм работают у разработчика с module.develop;
 * - без права вход отказан СЕРВЕРОМ (403), а окно не получает ни сессии, ни списка;
 * - неверный пароль не раскрывает, что именно не так;
 * - окно может вызвать только перечисленные действия и только из главного окна;
 * - адрес базы нигде не сохраняется, токен не уходит в окно;
 * - клиент отказывается от чужого адреса, от слишком большого ответа и от перенаправления.
 *
 * Запуск: npx tsx scripts/test-studio-shell.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { registerStudioRoutes } from '../server/routes/studio';
import { loopbackOrigin, ownModules, signIn, studioRequest, StudioFailure } from '../studio/shell/api';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const refused = async (promise: Promise<unknown>, pattern: RegExp) => {
  try { await promise; } catch (error: any) { return error instanceof StudioFailure && pattern.test(error.message); }
  return false;
};

const people: Record<string, { id: string; name: string; role: string; perms: string[]; password: string }> = {
  dev: { id: 'dev', name: 'Разработчик', role: 'MODULE_DEVELOPER', perms: ['module.develop'], password: 'dev-pass' },
  plain: { id: 'plain', name: 'Инженер', role: 'ENGINEER_VENT', perms: [], password: 'plain-pass' },
};

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-shell-'));
  const app = express();
  app.use(express.json());
  app.post('/api/login', (req, res) => {
    const person = people[String(req.body?.symbol)];
    if (!person || person.password !== req.body?.password) return res.status(401).json({ success: false, message: 'Неверный логин или пароль.' });
    res.json({ success: true, user: { id: person.id }, token: `token-${person.id}-long-enough` });
  });
  app.use('/api', (req: any, res, next) => {
    req.authUser = Object.values(people).find((p) => `Bearer token-${p.id}-long-enough` === req.headers.authorization);
    return req.authUser ? next() : res.status(401).json({ error: 'Нужен вход.' });
  });
  const fakeDb = { moduleRequest: { findMany: async ({ where }: any) => where.authorId === 'dev'
    ? [{ moduleId: 'alpha', version: '1.0.0', state: 'pending', createdAt: new Date() }] : [] } };
  registerStudioRoutes(app, { getPrisma: () => fakeDb, can: (user, feature) => user.perms.includes(feature) });
  const server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    console.log('Клиент Studio');
    ok('удалённый адрес не принимается', await refused(Promise.resolve().then(() => loopbackOrigin('http://flux.company.test')), /локальным обработчиком/));
    ok('адрес с паролем и путём не принимается', await refused(Promise.resolve().then(() => loopbackOrigin('http://u:p@127.0.0.1:3000/x')), /локальным обработчиком/));
    const good = await signIn(origin, 'dev', 'dev-pass');
    ok('разработчик с правом входит', good.user.id === 'dev' && good.token.startsWith('token-dev'));
    ok('список своих подпрограмм приходит', (await ownModules(origin, good.token)).map((m) => m.moduleId).join() === 'alpha');
    ok('сотрудник без права: отказ сервера с подсказкой', await refused(signIn(origin, 'plain', 'plain-pass'), /Разработка подпрограмм/));
    ok('неверный пароль — общий отказ', await refused(signIn(origin, 'dev', 'нет'), /Неверный логин или пароль/));
    ok('список без права закрыт и с настоящим токеном сотрудника', await refused(ownModules(origin, 'token-plain-long-enough'), /Разработка подпрограмм/));
    const odd = express();
    odd.get('/api/studio/modules', (_req, res) => res.type('json').send(JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })));
    odd.get('/api/studio/session', (_req, res) => res.redirect('http://127.0.0.1:1/elsewhere'));
    const oddServer = await new Promise<http.Server>((resolve) => { const s = odd.listen(0, '127.0.0.1', () => resolve(s)); });
    const oddOrigin = `http://127.0.0.1:${(oddServer.address() as any).port}`;
    ok('слишком большой ответ не читается', await refused(ownModules(oddOrigin, 'token-dev-long-enough'), /слишком большой/));
    ok('перенаправление на другой адрес не выполняется', await refused(studioRequest(oddOrigin, 'session', { token: 'token-dev-long-enough' }), /Не удалось связаться/));
    oddServer.close();

    console.log('Главный процесс');
    // Заглушки Electron и запуска Flux: подставляются при сборке теста, остальной код настоящий
    const stubs = path.join(temp, 'stubs.cjs');
    fs.writeFileSync(stubs, `
      const handlers = new Map(); const sent = []; let created = null;
      class Win { constructor(o){ created = this; this.options=o; this.webContents={ setWindowOpenHandler(){}, on(){}, send:(c,d)=>sent.push([c,d]), mainFrame:{} }; }
        setMenu(){} loadFile(){ return Promise.resolve(); } on(){} isDestroyed(){ return false; } }
      module.exports = { __handlers: handlers, __sent: sent, __win: () => created,
        app: { whenReady: () => Promise.resolve(), on(){} , quit(){} }, BrowserWindow: Win, dialog: {}, ipcMain: { handle: (c, f) => handlers.set(c, f) } };`);
    const runtimeStub = path.join(temp, 'runtime.cjs');
    fs.writeFileSync(runtimeStub, `let stops = 0; module.exports = { __stops: () => stops, startDatabaseRuntime: async (o) => ({ origin: ${JSON.stringify(origin)}, display: 'MariaDB / MySQL · stub', stop: async () => { stops++; } }), __last: null };`);
    const out = path.join(temp, 'main.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'studio/shell/main.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      define: { __STUDIO_VERSION__: '"0.0.0"', __STUDIO_BUILD__: '"developer"' },
      plugins: [{ name: 'stubs', setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: stubs, external: true }));
        build.onResolve({ filter: /database-runtime\.cjs$/ }, () => ({ path: runtimeStub, external: true }));
      } }],
    });
    const electron = require(stubs);
    const shell = require(out);
    shell.startShell([{ id: 'extra', title: 'Раздел', open: () => { opened++; } }]);
    let opened = 0;
    await new Promise((resolve) => setImmediate(resolve));
    const win = electron.__win();
    const handler = electron.__handlers.get('studio:call');
    const call = (action: string, args: object = {}, sender: any = win.webContents, frame: any = win.webContents.mainFrame) => handler({ sender, senderFrame: frame }, action, args);
    ok('окно создано с изоляцией и без Node', win.options.webPreferences.contextIsolation === true && win.options.webPreferences.nodeIntegration === false && win.options.webPreferences.sandbox === true);
    ok('чужое окно не вызывает действия', (await call('state', {}, { other: true })).ok === false);
    ok('чужой фрейм не вызывает действия', (await call('state', {}, win.webContents, {})).ok === false);
    ok('неизвестное действие отклоняется', (await call('exec', {})).ok === false);
    ok('без подключения список закрыт', (await call('modules')).ok === false);
    ok('вход без подключения отказан', /подключитесь/i.test((await call('login', { symbol: 'dev', password: 'dev-pass' })).error));
    const connected = await call('connect', { uri: 'mysql://U:P@H:3306/Flux' });
    ok('подключение: база показана без пароля', connected.ok && connected.value.connected && !/U:P/.test(JSON.stringify(connected.value)));
    const denied = await call('login', { symbol: 'plain', password: 'plain-pass' });
    ok('вход без права: отказ сервера, сессии у окна нет', denied.ok === false && /Разработка подпрограмм/.test(denied.error) && (await call('state')).value.user === null);
    ok('и список подпрограмм после отказа закрыт', (await call('modules')).ok === false);
    const entered = await call('login', { symbol: 'dev', password: 'dev-pass' });
    ok('разработчик входит', entered.ok && entered.value.user.id === 'dev');
    ok('токен не передаётся окну', !JSON.stringify([entered, electron.__sent, (await call('state'))]).includes('token-dev'));
    ok('свои подпрограммы приходят', (await call('modules')).value[0].moduleId === 'alpha');
    ok('раздел из точки входа открывается', (await call('openSection', { id: 'extra' })).ok && opened === 1);
    ok('несуществующий раздел недоступен', (await call('openSection', { id: 'owner' })).ok === false);
    ok('выход снимает сессию', (await call('logout')).value.user === null && (await call('modules')).ok === false);
    ok('данные формы с лишней длиной отклоняются', (await call('login', { symbol: 'x'.repeat(300), password: 'p' })).ok === false);
    await call('disconnect');
    ok('отключение останавливает локальный обработчик', require(runtimeStub).__stops() >= 1);
    ok('адрес базы нигде не сохранён', fs.readdirSync(temp).every((name) => !fs.readFileSync(path.join(temp, name), 'utf8').includes('U:P@H')));
    ok('в окно уходит только перечисленный набор состояния', Object.keys((await call('state')).value).sort().join() === 'build,connected,display,sections,user,version');
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\nFlux Studio: оболочка и вход — ${passed} проверок пройдено`);
}
main().catch((error) => { console.error(error); process.exit(1); });
