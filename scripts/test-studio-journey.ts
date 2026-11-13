/**
 * Путь «новая программа → проверить → запросить право → владелец выдал → опубликовать → владелец выпустил» насквозь.
 *
 * Без Electron: главный процесс разработчика собирается как в программе (esbuild) с заглушками окна, а сервер —
 * настоящие маршруты Flux на одноразовой SQLite. Владелец — настоящие действия его главного процесса
 * (studio/owner/src/console.cjs) с синтетическим хранилищем. Настоящий запуск обеих Studio под Electron — в CI
 * (`test-studio-electron-start.ts`), здесь доказывается то, что между окнами: данные и права.
 *
 * Запуск: npx tsx scripts/test-studio-journey.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import esbuild from 'esbuild';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerStudioRoutes } from '../server/routes/studio';
import { registerStudioDeveloperRoutes, studioPublishGate } from '../server/routes/studioDeveloper';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { requiresOwner } from '../server/accessPolicy';
import { openEnvelope } from '../modules/trust/envelope';

const Database = require('better-sqlite3');
const vaultApi = require('../studio/owner/src/vault.cjs');
const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-journey-'));
  const file = path.join(temp, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8'), () => {});

  const vault = vaultApi.generateVaults().main;
  const rootHex: string = vault.keys.update.publicHex;
  const grant = JSON.stringify({ 'module.develop': { enabled: true } });
  const people: Record<string, any> = {
    dev: { id: 'dev', name: 'Разработчик', role: 'ENGINEER_VENT', permissions: grant, password: 'dev-pass' },
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER', permissions: '{}', password: '' },
  };
  const tokenOf = (id: string) => `token-${id}-long-enough`;
  const can = (user: any, feature: string) => user?.role === 'OWNER' || !!JSON.parse(user?.permissions || '{}')[feature]?.enabled;
  const permissionsOf = async (user: any) => JSON.parse(user.permissions || '{}');
  const app = express();
  app.use(express.json({ limit: '60mb' }));
  app.post('/api/login', (req, res) => {
    const person = people[String(req.body?.symbol)];
    if (!person?.password || person.password !== req.body?.password) return res.status(401).json({ success: false, message: 'Неверный логин или пароль.' });
    res.json({ success: true, user: { id: person.id }, token: tokenOf(person.id) });
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '9.9.9' }));
  app.use('/api', (req: any, res, next) => {
    req.authUser = Object.values(people).find((p: any) => `Bearer ${tokenOf(p.id)}` === req.headers.authorization);
    if (!req.authUser) return res.status(401).json({ error: 'Нужен вход.' });
    if (requiresOwner(req.originalUrl.split('?')[0], req.method) && req.authUser.role !== 'OWNER') return res.status(403).json({ error: 'Доступно только владельцу.' });
    next();
  });
  registerStudioRoutes(app, { getPrisma: () => db, permissionsOf });
  registerStudioDeveloperRoutes(app, { getPrisma: () => db, permissionsOf, modulePublicKeyHex: rootHex });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, can, modulePublicKeyHex: rootHex, studioGate: studioPublishGate({ permissionsOf, modulePublicKeyHex: rootHex }) });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;

  // Владелец: настоящие действия главного процесса, диалог подтверждения отвечает «да»
  const stubOwner = path.join(temp, 'electron-stub.cjs');
  fs.writeFileSync(stubOwner, 'module.exports = {};');
  const builtOwner = path.join(temp, 'console.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'studio/owner/src/console.cjs')], outfile: builtOwner, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', alias: { electron: stubOwner } });
  const asked: Array<{ message: string; detail: string }> = [];
  const owner = require(builtOwner).createConsoleActions({
    vault: () => vault, token: () => tokenOf('flux-owner'), origin: () => origin, user: () => ({ id: 'flux-owner', name: 'Владелец' }),
    confirm: async (message: string, detail: string) => { asked.push({ message, detail }); return true; }, forward: {},
  });

  try {
    console.log('Главный процесс разработчика');
    const stubs = path.join(temp, 'stubs.cjs');
    fs.writeFileSync(stubs, `
      const handlers = new Map(); const sent = []; let created = null;
      class Win { constructor(o){ created = this; this.options=o; this.webContents={ setWindowOpenHandler(){}, setWebRTCIPHandlingPolicy(){}, session:{ setPermissionRequestHandler(){}, setPermissionCheckHandler(){} }, on(){}, send:(c,d)=>sent.push([c,d]), mainFrame:{}, capturePage: async () => ({ toPNG: () => Buffer.from([0x89,0x50,0x4e,0x47,1,2,3,4,5,6,7,8]) }) }; }
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
    // Окно программы, рабочий поток и заготовки лежат рядом с main.cjs, как в упакованной Studio
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
    shell.startShell([]);
    await new Promise((resolve) => setImmediate(resolve));
    const win = electron.__win();
    const handler = electron.__handlers.get('studio:call');
    const call = (action: string, args: object = {}) => handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, args);
    ok('подключение и вход разработчика', (await call('connect', { uri: 'mysql://U:P@H:3306/Flux' })).ok && (await call('login', { symbol: 'dev', password: 'dev-pass' })).ok);

    console.log('Новая программа и ключ');
    ok('ключ создаётся сам, человек его не видит', (await call('keyEnsure')).ok && (await call('keyInfo')).value.exists === true);
    const key = (await call('keyInfo')).value.publicKey as string;
    ok('новая программа из заготовки', (await call('draftCreate', { template: 'typescript', id: 'journey-ts', name: 'Путь насквозь' })).ok);
    ok('проверка до снимков не проходит', (await call('check', { id: 'journey-ts' })).value.ok === false);

    console.log('Запросить право публиковать');
    ok('права публиковать ещё нет', (await call('keyCertificate')).value.status === 'none');
    ok('одна кнопка отправляет запрос владельцу', (await call('keyRequestSend')).ok && (await call('keyCertificate')).value.status === 'requested');
    const asks = await owner.certificates();
    ok('владелец видит запрос с ключом и профилем', asks.requests.length === 1 && asks.requests[0].key === key && asks.requests[0].userId === 'dev');
    ok('до выдачи опубликовать нельзя', (await call('publish', { id: 'journey-ts' })).ok === false);

    console.log('Владелец выдал право');
    await owner.certify({ key, userId: 'dev', name: 'Разработчик' });
    ok('подпись сертификата принята сервером и сделана ключом владельца', openEnvelope('certificate', (await db.moduleCertificate.findFirst()).signature, rootHex) !== null);
    ok('разработчик видит, что право выдано', (await call('keyCertificate')).value.status === 'issued');

    console.log('Проверить и опубликовать');
    ok('снимки обеих тем', (await call('runStart', { id: 'journey-ts', projectId: 'p1', entry: 'start', entityId: '' })).ok
      && (await call('runShot', { id: 'journey-ts', theme: 'light', rect: { x: 0, y: 0, width: 300, height: 200 } })).ok
      && (await call('runShot', { id: 'journey-ts', theme: 'dark', rect: { x: 0, y: 0, width: 300, height: 200 } })).ok);
    await call('draftState', { id: 'journey-ts', changelog: 'Первая версия', comment: '', channel: 'test' });
    ok('проверка проходит', (await call('check', { id: 'journey-ts' })).value.ok === true);
    const sent = await call('publish', { id: 'journey-ts' });
    ok('запрос на публикацию принят сервером', sent.ok === true && await db.moduleRequest.count({ where: { moduleId: 'journey-ts', state: 'pending' } }) === 1);

    console.log('Владелец выпустил');
    const queue = await owner.requests();
    ok('владелец видит запрос в очереди', queue.requests.length === 1 && queue.requests[0].moduleId === 'journey-ts' && queue.requests[0].authorId === 'dev');
    const view = await owner.request({ id: queue.requests[0].id });
    asked.length = 0;
    const released = await owner.release({ id: queue.requests[0].id, channel: 'test', notBefore: 0, sha256: view.sha256 });
    ok('выпуск подписан и принят', released.release.moduleId === 'journey-ts' && await db.moduleRelease.count({ where: { moduleId: 'journey-ts' } }) === 1);
    ok('владельцу перед подписью показали программу и для кого выпуск', asked.length === 1 && /journey-ts/.test(asked[0].message) && /Для кого/.test(asked[0].detail));
    const mine = (await call('requests')).value;
    ok('разработчик видит, что его запрос выпущен', mine.some((r: any) => r.moduleId === 'journey-ts' && r.state === 'released'));
    const listed = await (await fetch(`${origin}/api/studio/releases?moduleId=journey-ts`, { headers: { Authorization: `Bearer ${tokenOf('dev')}` } })).json() as any;
    ok('и выпуск его программы виден ему в списке выпусков сервера', listed.releases.length === 1);

    console.log('История версий: версия → правка → сравнение → откат');
    const id = 'journey-ts', hist = async (action: string, args: object = {}) => call(action, { id, ...args });
    const first = (await hist('historyList')).value.snapshots;
    ok('отправка сама сохранила версию с номером, по которой потом можно сравнить выпуск', first.length === 1 && first[0].reason === 'publish' && /^\d+\.\d+\.\d+$/.test(first[0].version));
    const original = (await hist('draftFile', { path: 'logic/main.ts' })).value.text as string;
    ok('«Сохранить версию» без правок новой версии не создаёт', (await hist('historySave', { note: 'До правки' })).value.created === false);
    await hist('draftSave', { path: 'logic/main.ts', text: `${original}\n// правка после версии\n` });
    await hist('draftSave', { path: 'docs/note.md', text: 'новый файл\n' });
    const saved = (await hist('historySave', { note: 'После правки' })).value;
    ok('после правки «Сохранить версию» создаёт новую', saved.created === true && saved.snapshot.reason === 'manual' && saved.snapshot.note === 'После правки');
    const cmp = (await hist('historyCompare', { from: first[0].id, to: saved.snapshot.id })).value;
    ok('сравнение: изменённый и добавленный файлы, построчная разница', cmp.files.find((f: any) => f.path === 'docs/note.md')?.status === 'added'
      && cmp.files.find((f: any) => f.path === 'logic/main.ts')?.lines.some((l: any) => l.op === '+' && l.text.includes('правка после версии')));
    // Ещё одна правка, которой в истории нет: её и должен сохранить снимок «перед откатом»
    await hist('draftSave', { path: 'logic/main.ts', text: `${original}\n// правка после версии\n// ещё одна правка\n` });
    const plan = (await hist('historyPlan', { snapshot: first[0].id })).value;
    ok('предпросмотр отката: файл исчезнет, файл изменится; ничего не записано', plan.entries.some((e: any) => e.path === 'docs/note.md' && e.action === 'delete')
      && plan.entries.some((e: any) => e.path === 'logic/main.ts' && e.action === 'modify') && (await hist('draftFile', { path: 'logic/main.ts' })).value.text.includes('ещё одна правка'));
    ok('откат с чужим токеном отклонён', (await hist('historyRollback', { snapshot: first[0].id, token: 'x'.repeat(64) })).ok === false);
    const back = await hist('historyRollback', { snapshot: first[0].id, token: plan.token });
    ok('откат вернул файлы версии отправки', back.ok === true && (await hist('draftFile', { path: 'logic/main.ts' })).value.text === original && (await hist('draftTree')).value.entries.every((e: any) => e.path !== 'docs/note.md'));
    ok('перед откатом сохранено прежнее состояние, проект не потерял правку', back.value.restorePoint.reason === 'before-rollback' && (await hist('historyList')).value.snapshots.length === 3);
    const undo = (await hist('historyPlan', { snapshot: back.value.restorePoint.id })).value;
    ok('откат отменяется откатом к «Перед откатом»', (await hist('historyRollback', { snapshot: back.value.restorePoint.id, token: undo.token })).ok === true
      && (await hist('draftFile', { path: 'logic/main.ts' })).value.text.includes('ещё одна правка'));
    ok('служебная папка истории не видна в дереве и не открывается окном', (await hist('draftTree')).value.entries.every((e: any) => !/(^|\/)\.flux(\/|$)/.test(e.path)) && (await hist('draftFile', { path: '.flux/history/snapshots/x.json' })).ok === false);
    ok('чужой или некорректный проект история не открывает', (await call('historyList', { id: '../x' })).ok === false && (await call('historyList', { id: 'no-such-program' })).ok === false);

    console.log(`\nFlux Studio: путь от новой программы до выпуска — ${passed} проверок пройдено`);
  } finally {
    server.close();
    await db.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
