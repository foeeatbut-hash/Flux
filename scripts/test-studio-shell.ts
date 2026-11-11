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
 * - адрес базы без «запомнить» не сохраняется, с ним — только зашифрованным; токен не уходит в окно;
 * - разделы разработчика: ключ, проекты, запуск по протоколу flux-module, проверка, снимки, подписанная отправка, статусы;
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
import crypto from 'node:crypto';
import esbuild from 'esbuild';
import { readCertificates, verifyRequest } from '../modules/trust/verify';
import { publicHexOf, sealEnvelope } from '../modules/trust/envelope';
import { parseCertificateRequest } from '../studio/shared/keyring';
import { registerStudioRoutes } from '../server/routes/studio';
import { OwnerChallenges } from '../server/ownerAuth';
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
  owner: { id: 'owner', name: 'Владелец', role: 'OWNER', perms: [], password: '' },
};
/** Синтетический ключ владельца: настоящих ключей в проверках нет (тот же приём, что у scripts/test-owner-auth.ts) */
const ownerKey = crypto.generateKeyPairSync('ed25519');
const ownerPublicHex = publicHexOf(ownerKey.privateKey);

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-shell-'));
  const app = express();
  app.use(express.json({ limit: '60mb' }));
  app.post('/api/login', (req, res) => {
    const person = people[String(req.body?.symbol)];
    if (!person || person.password !== req.body?.password) return res.status(401).json({ success: false, message: 'Неверный логин или пароль.' });
    res.json({ success: true, user: { id: person.id }, token: `token-${person.id}-long-enough` });
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '9.9.9' }));
  // Вход владельца: настоящий выдающий одноразовые запросы класс сервера, проверяющий синтетический ключ; origin — по заголовку Host, как в сервере
  const challenges = new OwnerChallenges([ownerPublicHex]);
  const originOf = (req: any) => `${req.protocol}://${String(req.get('host') || '').toLowerCase()}`;
  app.get('/api/owner/challenge', (req, res) => res.json(challenges.issue('install-1', originOf(req))));
  app.post('/api/owner/login', (req, res) => {
    if (!challenges.verify(req.body?.nonce, req.body?.sig, 'install-1', originOf(req))) return res.status(401).json({ success: false, error: 'Подпись владельца не принята.' });
    res.json({ success: true, token: 'token-owner-long-enough', user: { id: 'owner', name: 'Владелец', role: 'OWNER' } });
  });
  app.use('/api', (req: any, res, next) => {
    req.authUser = Object.values(people).find((p) => `Bearer token-${p.id}-long-enough` === req.headers.authorization);
    return req.authUser ? next() : res.status(401).json({ error: 'Нужен вход.' });
  });
  const row = { moduleId: 'alpha', version: '1.0.0', state: 'pending', createdAt: new Date() };
  const fakeDb = { moduleRequest: {
    groupBy: async ({ where }: any) => where.authorId === 'dev' ? [{ moduleId: 'alpha', _count: { _all: 1 }, _max: { createdAt: row.createdAt } }] : [],
    findFirst: async () => row,
  } };
  registerStudioRoutes(app, { getPrisma: () => fakeDb, permissionsOf: async (user) => Object.fromEntries(user.perms.map((f: string) => [f, { enabled: true }])) });
  // Разделы разработчика: настоящая проверка подписи запроса с сертификатом владельца, остальное — заглушки сервера
  const rootKey = crypto.generateKeyPairSync('ed25519').privateKey, rootHex = publicHexOf(rootKey);
  const certificates: string[] = [];
  const accepted: Array<{ id: string; moduleId: string; files: string[]; author: string; checks: any; baseRelease: string | null; parentRequest: string | null }> = [];
  const trusted = () => readCertificates(certificates, rootHex, { releases: new Set(), keys: new Set() });
  app.get('/api/studio/certificate', (req, res) => {
    const known = trusted().has(String(req.query.key));
    res.json({ status: known ? 'issued' : 'none', name: known ? 'Разработчик' : '' });
  });
  const certRequests: any[] = [];
  app.post('/api/modules/certificate-requests', (req, res) => { certRequests.push(req.body); res.json({ ok: true }); });
  app.get('/api/studio/releases', (_req, res) => res.json({ releases: [] }));
  app.get('/api/studio/requests', (_req, res) => res.json({ requests: accepted.map((a, i) => ({ id: a.id, moduleId: a.moduleId, version: '0.1.0', state: i ? 'returned' : 'pending', parentId: null, changelog: 'x', channel: 'test', createdAt: new Date().toISOString(), decidedAt: null, review: i ? { note: 'Поправьте', comments: [{ path: 'form.json', line: 2, text: 'подпись' }] } : null })) }));
  app.post('/api/modules/requests', express.json({ limit: '60mb' }), (req: any, res) => {
    const checked = verifyRequest({ signature: req.body.signature, bundle: new Uint8Array(Buffer.from(req.body.bundle, 'base64')), rootHex, certificates: trusted() });
    if (!checked.ok) return res.status(400).json({ error: checked.why });
    const id = `req-${accepted.length + 1}`;
    accepted.push({ id, moduleId: checked.claim.moduleId, files: Object.keys(checked.files), author: checked.claim.author, checks: JSON.parse(checked.claim.meta.checks), baseRelease: checked.claim.baseRelease, parentRequest: checked.claim.parentRequest });
    res.json({ id });
  });
  const transitions: any[] = [];
  const reportId = '11111111-1111-4111-8111-111111111111';
  app.get('/api/feedback/reports', (req, res) => res.json({ data: req.query.scope === 'modules' ? [{ id: reportId, number: 7, title: 'Падает расчёт', moduleId: 'demo-ts', moduleVersion: '0.1.0', status: 'IN_PROGRESS', impact: 'HIGH', priority: 'P1', revision: 3, resolvedVersion: null, createdAt: '2026-11-10', moduleKnown: false, authorId: 'secret-author', description: 'секрет' }] : [] }));
  app.get('/api/modules/crashes', (_req, res) => res.json({ data: [{ moduleId: 'alpha', version: '0.1.0', kind: 'timeout', count: 4, extra: 'x' }, { moduleId: 'foreign-mod', version: '1.0.0', kind: 'crash', count: 9 }] }));
  app.post('/api/feedback/reports/:id/transition', (req, res) => { transitions.push({ id: req.params.id, ...req.body }); res.json({ data: { id: req.params.id } }); });
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
      class Win { constructor(o){ created = this; this.options=o; this.webContents={ setWindowOpenHandler(){}, on(){}, send:(c,d)=>sent.push([c,d]), mainFrame:{}, capturePage: async () => ({ toPNG: () => Buffer.from([0x89,0x50,0x4e,0x47,1,2,3,4,5,6,7,8]) }) }; }
        setMenu(){} loadFile(){ return Promise.resolve(); } on(){} once(){} show(){} isDestroyed(){ return false; } }
      module.exports = { __handlers: handlers, __sent: sent, __win: () => created,
        app: { whenReady: () => Promise.resolve(), on: (e, f) => handlers.set('app:' + e, f), quit(){ globalThis.__quitAt = globalThis.__cleaned === true ? 'после очистки' : 'до очистки'; }, getPath: () => process.env.STUDIO_TEST_DATA },
        BrowserWindow: Win, dialog: { showOpenDialog: async () => process.env.STUDIO_TEST_VAULT ? { canceled: false, filePaths: [process.env.STUDIO_TEST_VAULT] } : { canceled: true, filePaths: [] } }, ipcMain: { handle: (c, f) => handlers.set(c, f), on: (c, f) => handlers.set('on:' + c, f), removeAllListeners() {}, removeHandler() {} },
        nativeImage: { createFromPath: () => ({}) },
        protocol: { registerSchemesAsPrivileged(){}, handle: (scheme, fn) => handlers.set('protocol:' + scheme, fn) },
        // Хранилище с настоящим обратимым преобразованием: без него адрес не расшифровать, а открытым текстом он на диск не попадает
        safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('hex').split('').reverse().join('')), decryptString: (b) => Buffer.from(Buffer.from(b).toString().split('').reverse().join(''), 'hex').toString('utf8') } };`);
    const runtimeStub = path.join(temp, 'runtime.cjs');
    fs.writeFileSync(runtimeStub, `let stops = 0; module.exports = { __stops: () => stops, startDatabaseRuntime: async (o) => { if (process.env.STUDIO_TEST_SLOW) return new Promise((_, reject) => o.signal.addEventListener('abort', () => setTimeout(() => { globalThis.__cleaned = true; reject(new Error('Подключение к общей базе отменено.')); }, 250))); if (o.signal && o.signal.aborted) throw new Error('Подключение к общей базе отменено.'); return ({ origin: ${JSON.stringify(origin)}, display: 'MariaDB / MySQL · stub', stop: async () => { stops++; } }); }, __last: null };`);
    const out = path.join(temp, 'main.cjs');
    process.env.STUDIO_TEST_DATA = path.join(temp, 'data');
    // Окно подпрограммы, рабочий поток и заготовки лежат рядом с main.cjs, как в упакованной Studio
    await require('../studio/build-assets.cjs').buildDeveloperAssets({ app: temp, esbuild });
    await esbuild.build({
      entryPoints: [path.join(root, 'studio/shell/main.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      define: { __STUDIO_VERSION__: '"0.0.1"', __STUDIO_BUILD__: '"developer"', __STUDIO_NAME__: '"Flux Studio"' },
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
    const everyFile = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? everyFile(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    const data = path.join(temp, 'data');
    ok('адрес без «запомнить» нигде не сохранён', !fs.existsSync(data) || everyFile(data).every((f) => !fs.readFileSync(f, 'latin1').includes('U:P@H')));
    ok('в окно уходит только перечисленный набор состояния', Object.keys((await call('state')).value).sort().join() === 'build,connected,display,name,owner,remembered,sections,user,version,warning');


    console.log('Подключение: операция не отменяет сама себя');
    ok('«Подключиться» доходит до конца: сброс прежнего подключения не прерывает текущее', (await call('connect', { uri: 'mysql://U:P@H:3306/Flux' })).value.connected === true);
    ok('повторное подключение поверх прежнего тоже проходит', (await call('connect', { uri: 'mysql://U:P@H:3306/Flux' })).value.connected === true);
    await call('disconnect');

    console.log('Вход владельца файлом ключа');
    const vaultApi = require('../studio/owner/src/vault.cjs');
    const vaultPassword = 'синтетический пароль хранилища';
    const ownerPem = ownerKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const vaultFile = path.join(temp, 'synthetic.flux-owner');
    fs.writeFileSync(vaultFile, await vaultApi.encrypt({ v: 1, kind: 'backup', keys: { owner: { privatePem: ownerPem, publicHex: ownerPublicHex } }, licenses: [], updates: [] }, vaultPassword));
    const foreignFile = path.join(temp, 'foreign.flux-owner');
    fs.writeFileSync(foreignFile, '{"format":"NOTVAULT"}');
    ok('вход владельца без подключения отказан', /подключитесь/i.test((await call('ownerLogin', { password: vaultPassword })).error));
    await call('connect', { uri: 'mysql://U:P@H:3306/Flux' });
    ok('без выбранного файла вход отказан', /выберите файл/i.test((await call('ownerLogin', { password: vaultPassword })).error));
    process.env.STUDIO_TEST_VAULT = '';
    ok('закрытое окно выбора — «отмена», а не ошибка', (await call('ownerSelectKey')).value.canceled === true);
    process.env.STUDIO_TEST_VAULT = foreignFile;
    const wrong = await call('ownerSelectKey');
    ok('чужой файл отклонён при выборе, с причиной', wrong.ok && wrong.value.ok === false && /не является зашифрованным хранилищем/.test(wrong.value.error));
    process.env.STUDIO_TEST_VAULT = vaultFile;
    const picked = await call('ownerSelectKey');
    ok('нужный файл выбран, окну отдано только имя', picked.ok && picked.value.name === 'synthetic.flux-owner' && !JSON.stringify(picked).includes(temp));
    const badPassword = await call('ownerLogin', { password: 'неверный пароль хранилища' });
    ok('неверный пароль: отказ понятным текстом, сессии нет', badPassword.ok === false && /пароль именно этого файла/.test(badPassword.error) && (await call('state')).value.user === null);
    ok('короткий пароль отклонён до расшифровки', (await call('ownerLogin', { password: 'коротко' })).ok === false);
    const ownerIn = await call('ownerLogin', { password: vaultPassword });
    ok('владелец входит файлом ключа', ownerIn.ok && ownerIn.value.user.id === 'owner');
    ok('токен владельца окну не уходит', !JSON.stringify([ownerIn, electron.__sent, await call('state')]).includes('token-owner'));
    ok('разделы владельца видны вошедшему владельцем', (await call('state')).value.owner === true && (await call('state')).value.sections.length === 1);
    ok('и раздел из точки входа открывается', (await call('openSection', { id: 'extra' })).ok);
    ok('закрытый ключ не лежит в данных программы', !fs.existsSync(data) || !everyFile(data).some((f) => fs.readFileSync(f, 'latin1').includes('PRIVATE KEY')));
    ok('после входа выбор файла сброшен: повторный вход без выбора отказан', /выберите файл/i.test((await call('ownerLogin', { password: vaultPassword })).error));
    await call('logout');
    ok('после выхода разделов владельца нет', (await call('state')).value.owner === false);
    const afterDev = await call('login', { symbol: 'dev', password: 'dev-pass' });
    ok('вошедший по логину разработчик не получает разделов владельца', afterDev.ok && afterDev.value.owner === false);
    await call('disconnect');

    console.log('Закрытие окна посреди подключения');
    process.env.STUDIO_TEST_SLOW = '1';
    const hanging = call('connect', { uri: 'mysql://U:P@H:3306/Flux' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    electron.__handlers.get('app:window-all-closed')();
    await hanging;
    for (let i = 0; i < 100 && !(globalThis as any).__quitAt; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    ok('программа закрывается только после остановки запущенного Flux (дочерний процесс не остаётся)', (globalThis as any).__cleaned === true && (globalThis as any).__quitAt === 'после очистки');
    delete process.env.STUDIO_TEST_SLOW;

    console.log('Запомненный адрес');
    ok('до запоминания сохранённой базы нет', (await call('state')).value.remembered === '');
    ok('«запомнить»: подключение проходит', (await call('connect', { uri: 'mysql://U:P@H:3306/Flux', remember: true })).ok);
    const saved = everyFile(data).filter((f) => /database-address/.test(f));
    ok('адрес записан зашифрованным, пароля открытым текстом нет', saved.length === 1 && !fs.readFileSync(saved[0], 'latin1').includes('U:P@H') && !fs.readFileSync(saved[0], 'latin1').includes('mysql://'));
    ok('окну показана только база без пароля', (await call('state')).value.remembered === 'MariaDB / MySQL · stub' && !JSON.stringify((await call('state')).value).includes('U:P'));
    await call('disconnect');
    ok('подключение по сохранённому адресу без ввода', (await call('connectRemembered')).value.connected === true);
    ok('в окно не ушёл ни пароль базы, ни адрес', !JSON.stringify(electron.__sent).includes('U:P'));
    await call('disconnect');
    await call('forgetBase');
    ok('«Забыть адрес» удаляет файл', everyFile(data).every((f) => !/database-address/.test(f)) && (await call('connectRemembered')).ok === false);
    await call('connect', { uri: 'mysql://U:P@H:3306/Flux' });
    ok('предупреждение «обновите Studio», если Flux в базе новее', /старее Flux 9\.9\.9/.test((await call('state')).value.warning));

    console.log('Разделы разработчика');
    ok('действие разработчика без входа закрыто', (await call('keyRequest')).ok === false);
    await call('login', { symbol: 'dev', password: 'dev-pass' });
    ok('ключа ещё нет', (await call('keyInfo')).value.exists === false && (await call('keyCertificate')).value.status === 'nokey');
    const key = (await call('keyCreate')).value;
    ok('ключ создан; в ответе окну только открытая часть', key.exists && /^[0-9a-f]{64}$/.test(key.publicKey) && Object.keys(key).sort().join() === 'available,createdAt,damaged,exists,publicKey');
    const keyFile = fs.readFileSync(path.join(data, 'developer-key.json'), 'utf8');
    ok('закрытый ключ не лежит открытым текстом', !/PRIVATE KEY/.test(keyFile) && !Buffer.from(JSON.parse(keyFile).secret, 'base64').toString('latin1').includes('PRIVATE KEY'));
    ok('сертификата ещё нет', (await call('keyCertificate')).value.status === 'none');
    const parsedRequest = parseCertificateRequest((await call('keyRequest')).value.text);
    ok('запрос сертификата несёт ключ и профиль', parsedRequest?.key === key.publicKey && parsedRequest.userId === 'dev');
    ok('запрос сертификата уходит в очередь: ключ и имя, без закрытой части', (await call('keyRequestSend')).ok && certRequests.length === 1 && certRequests[0].key === key.publicKey && Object.keys(certRequests[0]).sort().join() === 'key,name');
    ok('статус «запрос отправлен» виден, пока сертификата нет', (await call('keyCertificate')).value.status === 'requested');
    certificates.push(sealEnvelope('certificate', { v: 1, key: key.publicKey, userId: 'dev', name: 'Разработчик', iat: Date.now() }, rootKey));
    ok('после выдачи владельцем сертификат виден', (await call('keyCertificate')).value.status === 'issued');
    ok('заготовок семь', (await call('templates')).value.length === 7);
    ok('неверный идентификатор отклоняется', (await call('draftCreate', { template: 'typescript', id: 'Bad Id', name: 'x' })).ok === false);
    ok('неизвестная заготовка отклоняется', (await call('draftCreate', { template: 'cobol', id: 'demo', name: 'x' })).ok === false);
    ok('проект создан из заготовки', (await call('draftCreate', { template: 'typescript', id: 'demo-ts', name: 'Пример' })).ok);
    ok('путь вне проекта не сохраняется', (await call('draftSave', { id: 'demo-ts', path: '../evil.txt', text: 'x' })).ok === false);
    ok('чужой идентификатор в действии отклоняется', (await call('draftTree', { id: '../x' })).ok === false);
    ok('проверка без снимков и «что нового» не проходит', (await call('check', { id: 'demo-ts' })).value.ok === false);
    ok('отправка при непройденной проверке недоступна', /не пройдена/.test((await call('publish', { id: 'demo-ts' })).error) && accepted.length === 0);
    const started = await call('runStart', { id: 'demo-ts', projectId: 'p1', entry: 'equipment', entityId: 'p1-e-fan' });
    ok('запуск: адрес страницы по протоколу flux-module', started.ok && started.value.url.startsWith('flux-module://run/'));
    const protocolHandler = electron.__handlers.get('protocol:flux-module');
    const fetchAsset = async (u: string, method = 'GET') => protocolHandler({ url: u, method });
    const html = await fetchAsset('flux-module://run/index.html');
    ok('index.html отдан с изоляцией sandbox в CSP', html.status === 200 && /sandbox allow-scripts/.test(html.headers.get('content-security-policy')));
    ok('runtime.js содержит форму подпрограммы', (await (await fetchAsset('flux-module://run/runtime.js')).text()).includes('Статистика числовых параметров'));
    ok('чужой хост, путь вне набора и не-GET — 404', (await fetchAsset('flux-module://other/index.html')).status === 404 && (await fetchAsset('flux-module://run/secret.txt')).status === 404 && (await fetchAsset('flux-module://run/runtime.js', 'POST')).status === 404);
    const read = (resource: string, entityId?: string) => call('runRead', { resource, entityId });
    ok('чтение из тестовой базы по объявленному reads', (await read('equipment')).value.params.length === 5);
    ok('чтение необъявленного ресурса отклонено', (await read('catalog')).ok === false);
    ok('неизвестный ресурс отклонён', (await read('files')).ok === false);
    const shot = (theme: string, w = 300) => call('runShot', { id: 'demo-ts', theme, rect: { x: 0, y: 0, width: w, height: 200 } });
    ok('снимок обеих тем сохраняется в проект', (await shot('light')).ok && (await shot('dark')).ok);
    ok('снимок с нулевой областью и неизвестной темой отклонён', (await shot('dark', 0)).ok === false && (await shot('sepia')).ok === false);
    await call('draftState', { id: 'demo-ts', changelog: 'Первая версия', comment: 'Проверьте', channel: 'test' });
    const checked = (await call('check', { id: 'demo-ts' })).value;
    ok('проверка проходит после снимков и «что нового»', checked.ok === true);
    const sent = await call('publish', { id: 'demo-ts' });
    ok('отправка: запрос принят сервером, подписан ключом разработчика с сертификатом', sent.ok && accepted.length === 1 && accepted[0].author === key.publicKey);
    ok('в запросе исходники, runtime, снимки; отчёт приложен', ['logic/main.ts', 'build/runtime.js', 'store/light.png', 'store/dark.png', 'manifest.json'].every((f) => accepted[0].files.includes(f)) && accepted[0].checks.ok === true);
    ok('в ответах окну и в запросе нет токена и закрытого ключа', !JSON.stringify([sent, electron.__sent]).includes('token-dev') && !JSON.stringify(accepted).includes(JSON.parse(keyFile).secret));
    ok('предупреждение о версии приходит с ответом отправки', /9\.9\.9/.test(sent.value.warning));
    ok('статус запроса виден разработчику', (await call('requests')).value[0].state === 'pending');
    await call('draftState', { id: 'demo-ts', changelog: 'Исправил' });
    ok('повторная отправка продолжает историю: родитель — прежний запрос', (await call('publish', { id: 'demo-ts' })).ok && accepted[1].parentRequest === 'req-1');
    fs.rmSync(path.join(data, 'developer-key.json'));
    ok('без ключа отправка невозможна', (await call('publish', { id: 'demo-ts' })).ok === false);

    console.log('Ошибки');
    const errors = (await call('errors')).value;
    ok('обращения и счётчики по своей подпрограмме', errors.reports[0].number === 7 && errors.crashes[0].count === 4 && errors.crashes[0].kind === 'timeout');
    ok('в окно не уходит лишнее из ответа сервера (автор, описание)', !JSON.stringify(errors).includes('secret'));
    ok('счётчики только своих подпрограмм, даже если сервер отдал все', errors.crashes.length === 1 && errors.crashes[0].moduleId === 'alpha');
    ok('неверная версия исправления отклоняется', (await call('errorFixed', { reportId, version: '1.2', revision: 3 })).ok === false && transitions.length === 0);
    ok('чужой идентификатор обращения отклоняется', (await call('errorFixed', { reportId: '../x', version: '1.2.3', revision: 3 })).ok === false);
    ok('«исправлено в версии» уходит на проверку автору с ревизией', (await call('errorFixed', { reportId, version: '0.2.0', revision: 3 })).ok
      && transitions[0].to === 'VERIFY' && transitions[0].resolvedVersion === '0.2.0' && transitions[0].expectedRevision === 3 && /^[0-9a-f-]{36}$/.test(transitions[0].clientRequestId));
  } finally {
    server.close();
    delete process.env.STUDIO_TEST_DATA;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\nFlux Studio: оболочка и вход — ${passed} проверок пройдено`);
}
main().catch((error) => { console.error(error); process.exit(1); });
