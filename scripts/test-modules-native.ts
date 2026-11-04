import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { build } from 'esbuild';
import { _electron, type Frame } from 'playwright-core';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap';
import { setPrisma, setBroadcaster } from '../server/context';
import { registerProjectRoutes } from '../server/routes/projects';
import { registerTagRoutes } from '../server/routes/tags';
import { registerEquipmentCoreRoutes } from '../server/routes/equipmentCore';

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-modules-'));
const shots = process.env.FLUX_MODULE_SHOTS || path.join(temp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dbPath = path.join(temp, 'test.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let passed = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); }
const app = express();
const server = createServer(app);
const io = new Server(server);
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
async function main() {
  await bootstrapLocalDatabase(dbPath, prisma, fs.readFileSync('prisma/schema.prisma', 'utf8'), () => {});
  setPrisma(prisma);
  setBroadcaster((event, detail) => io.emit(event, detail));
  await prisma.project.createMany({ data: [{ id: 'p', name: 'Тестовый проект', code: 'P' }, { id: 'p2', name: 'Другой проект' }] });
  await prisma.equipmentSystem.create({ data: { id: 's', name: 'П1', projectId: 'p', category: 'AHU' } });
  await prisma.monoblock.create({ data: { id: 'b', name: 'Моноблок', systemId: 's' } });
  await prisma.tag.create({ data: { id: 't', identifier: 'P1-FAN', projectId: 'p' } });
  await prisma.componentElement.create({ data: { id: 'e', name: 'Вентилятор', itemCode: 'бл1', monoblockId: 'b', equipType: 'ВЕНТИЛЯТОР',
    specs: JSON.stringify({ groups: [{ title: 'Основные', params: [{ key: 'Расход воздуха', value: '1200', unit: 'м³/ч' }] }] }), tags: { connect: { id: 't' } } } });
  await prisma.componentElement.create({ data: { id: 'child', name: 'Двигатель', itemCode: 'дв1', monoblockId: 'b', parentElementId: 'e' } });
  app.use(express.json());
  // Подмена только входа: синтетический авторизованный профиль; маршруты и БД настоящие.
  app.use((req, _res, next) => { (req as any).authUser = { id: 'u', role: 'OWNER', name: 'Проверка' }; next(); });
  registerProjectRoutes(app, { enforce: async () => true, notifyAll: async () => {} });
  registerTagRoutes(app, { io, notifyAll: async () => {} });
  registerEquipmentCoreRoutes(app);
  const built = path.resolve('dist');
  const css = fs.readdirSync(path.join(built, 'assets')).filter(file => file.endsWith('.css'));
  await build({ entryPoints: ['scripts/fixtures/modules-host.tsx'], bundle: true, platform: 'browser', outfile: path.join(temp, 'host.js'),
    define: { __APP_VERSION__: '"test"', __FLUX_E3_FAKE__: 'false', 'process.env.NODE_ENV': '"production"' } });
  await build({ entryPoints: ['scripts/fixtures/modules-native-main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'main.cjs') });
  await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'preload.js') });
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">${css.map(file => `<link rel="stylesheet" href="/assets/${file}">`).join('')}</head><body style="margin:0"><div id="root"></div><script src="/host.js"></script></body></html>`));
  app.get('/host.js', (_req, res) => res.sendFile(path.join(temp, 'host.js')));
  app.use('/assets', express.static(path.join(built, 'assets')));
  let leaked = 0;
  app.all('/must-not-reach', (_req, res) => { leaked++; res.json({ leaked: true }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  electron = await _electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', ...(process.env.DISPLAY ? [] : ['--ozone-platform=headless'])] : []), path.join(temp, 'main.cjs')],
    env: { ...process.env, FLUX_MODULE_FIXTURE_DIR: temp, FLUX_MODULE_FIXTURE_URL: url }, timeout: 45000 });
  const page = await electron.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
  await page.waitForFunction(() => document.documentElement.dataset.socket === 'ready');
  const frame = () => page.frames().find(item => item.url().startsWith('flux-module://'))!;
  await page.locator('iframe').waitFor();
  await frame().getByText('1200', { exact: true }).waitFor();
  check('промышленный протокол показывает позицию и её параметры', await frame().getByText('Вентилятор', { exact: true }).count() === 1);
  check('событие открывает позицию с тегом', await frame().getByText('P1-FAN', { exact: true }).count() === 1);
  check('iframe другого источника имеет только allow-scripts', await page.locator('iframe').getAttribute('sandbox') === 'allow-scripts' && new URL(frame().url()).protocol === 'flux-module:');
  for (const width of [1440, 1024]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    if (dark !== (theme === 'dark')) await page.locator('#theme').click();
    await frame().getByText('1200', { exact: true }).waitFor();
    const geometry = await frame().evaluate(() => ({
      scroll: document.documentElement.scrollWidth, width: innerWidth,
      rows: Array.from(document.querySelectorAll('tbody tr')).map(row => row.getBoundingClientRect().height),
      texts: Array.from(document.querySelectorAll('td,th,span,h2')).map(node => { const style = getComputedStyle(node); return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) }; }),
      surface: getComputedStyle(document.documentElement).getPropertyValue('--flux-surface').trim(),
    }));
    check(`${width}/${theme}: геометрия без прокрутки, мелкого шрифта и жирного`, geometry.scroll <= geometry.width && geometry.rows.every(h => h >= 28 && h <= 36)
      && geometry.texts.every(item => item.size >= 12 && [400, 500, 600].includes(item.weight)));
    fs.writeFileSync(path.join(shots, `${width}-${theme}.json`), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: path.join(shots, `${width}-${theme}.png`) });
  }
  check('без ошибок исполнения и консоли до атак', errors.length === 0);
  const isolation = await frame().evaluate(() => {
    const attempt = (fn: () => unknown) => { try { return fn(); } catch (_) { return 'denied'; } };
    return { parentCookie: attempt(() => parent.document.cookie), parentStorage: attempt(() => parent.localStorage.getItem('flux_parent_storage')),
      ownCookie: attempt(() => document.cookie), ownStorage: attempt(() => localStorage.getItem('flux_parent_storage')),
      ipc: typeof (window as any).electron, node: typeof (window as any).require };
  });
  check('cookie и localStorage Flux закрыты', isolation.parentCookie === 'denied' && isolation.parentStorage === 'denied' && isolation.ownCookie === 'denied' && isolation.ownStorage === 'denied');
  check('модуль не получает IPC и Node даже с настоящим preload родителя', isolation.ipc === 'undefined' && isolation.node === 'undefined' && await page.evaluate(() => typeof (window as any).electron) === 'object');
  const network = await frame().evaluate(async target => {
    try { await fetch(target); return true; } catch (_) { return false; }
  }, `${url}/must-not-reach`);
  check('CSP не пропускает запрос к API Flux', !network && leaked === 0);
  const workerNetwork = await frame().evaluate(async target => {
    const worker = new Worker(URL.createObjectURL(new Blob([`fetch(${JSON.stringify(target)}).then(()=>postMessage('leaked'),()=>postMessage('blocked'))`], { type: 'text/javascript' })));
    return new Promise(resolve => { worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); }; });
  }, `${url}/must-not-reach`);
  check('Worker наследует запрет сети', workerNetwork === 'blocked' && leaked === 0);
  const ipcResult = await frame().evaluate(async () => {
    const message = { flux: 'module', v: 1, session: location.hash.slice(1), id: 'write-probe', type: 'write', resource: 'equipment', entityId: 'e', data: { name: 'Испорчено' } };
    return new Promise(resolve => { const listen = (event: MessageEvent) => { if (event.data?.id === message.id) { window.removeEventListener('message', listen); resolve(event.data); } }; window.addEventListener('message', listen); parent.postMessage(message, '*'); });
  });
  check('попытка записи получает READ_ONLY, БД не меняется', (ipcResult as any).code === 'READ_ONLY' && (await prisma.componentElement.findUnique({ where: { id: 'e' } })).name === 'Вентилятор');
  const invalid = await frame().evaluate(async () => {
    let count = 0;
    const listener = (event: MessageEvent) => { if (event.data?.id === 'invalid') count++; };
    window.addEventListener('message', listener);
    parent.postMessage({ flux: 'module', v: 1, session: location.hash.slice(1), id: 'invalid', type: 'read', resource: 'equipment', extra: true }, '*');
    await new Promise(resolve => setTimeout(resolve, 200)); window.removeEventListener('message', listener); return count;
  });
  check('сообщение вне схемы отбрасывается', invalid === 0);
  const timeout = await page.evaluate(async () => {
    const result = (window as any).runModuleWorker('while(true){}', 'recalc', { timeoutMs: 50, read: async () => null });
    const started = performance.now();
    try { await result.result; return false; } catch (error) { return (error as Error).message === 'TIMEOUT' && performance.now() - started < 3000; }
  });
  check('зависший Worker принудительно остановлен по времени', timeout);
  const before = await prisma.componentElement.findUnique({ where: { id: 'e' } });
  const edited = await fetch(`${url}/api/equipment/component/e/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group: 'Основные', key: 'Расход воздуха', value: '2400' }) });
  check('правка проходит настоящий маршрут Flux', edited.ok);
  await frame().getByText('2400', { exact: true }).waitFor();
  check('изменение SQLite через API и entity:changed дошло до открытого модуля', (await prisma.componentElement.findUnique({ where: { id: 'e' } })).version > before.version);
  await page.locator('#start').click();
  await frame().getByText('Откройте модуль из карточки оборудования или тега.').waitFor();
  await page.getByTestId('tag-launch').getByRole('button').click();
  await frame().getByText('2400', { exact: true }).waitFor();
  check('вход из тега разрешает связанную позицию', await frame().getByText('P1-FAN', { exact: true }).count() === 1);
  await page.locator('#project').click();
  await frame().getByText('Откройте модуль из карточки оборудования или тега.').waitFor();
  check('смена проекта удаляет данные прежней позиции', await frame().getByText('2400', { exact: true }).count() === 0);
  await frame().evaluate(target => { location.href = target; }, `${url}/must-not-reach`);
  await page.waitForTimeout(150);
  check('iframe не уходит на внешний адрес навигацией', !!frame() && leaked === 0);
  console.log(`\n${passed} проверок пройдено. Снимки: ${shots}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await electron?.close(); io.close(); server.close(); await prisma.$disconnect();
});
