/**
 * Flux Store и самостоятельные программы в браузере на НАСТОЯЩЕЙ службе: витрину, разрешения и манифесты строят настоящие
 * маршруты (server/routes/modulePublishing.ts) над одноразовой SQLite, выпуски подписаны и опубликованы настоящим путём (запрос
 * разработчика, выпуск владельца, допуск администратором). Подставлен только главный процесс (scripts/fixtures/store-ui.tsx):
 * его каналы пишутся в журнал страницы, чтобы видеть, что окно просит стереть данные и когда.
 *
 * Что доказывается: метка «Работает без связи» — только у самостоятельной программы без интернета, сети и обращений к другим
 * программам (подключение к программе на компьютере метку не снимает); она есть в карточке, на странице и в окне установки;
 * окно удаления самостоятельной программы говорит про данные на компьютере, и удаление просит главный процесс стереть
 * область `released` именно этой программы; у остальных программ этого нет; мерки и снимки обеих тем.
 *
 * Запуск: FLUX_CHROME=… npx tsx scripts/test-modules-store-standalone-ui.ts   (свой Vite на свободном порту; без Chromium печатает FLUX_VERIFY_SKIP)
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { findChromeOrUndefined } from './chromePath';
import { verifySkip } from './verifySkip';
import { certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope } from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STORE_SHOTS || path.join(os.tmpdir(), 'flux-store-standalone-shots');

async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function main() {
  const chrome = findChromeOrUndefined();
  if (!chrome) { verifySkip('нет Chromium (FLUX_CHROME)'); return; }
  fs.mkdirSync(shots, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-store-standalone-'));
  const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev);

  // ── Настоящая служба: маршруты модулей над SQLite ──
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  const log: string[] = [];
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), m => log.push(m));
  assert.ok(!log.some(m => /Не удалось|Ошибка при/.test(m)), 'схема Store не создана');
  const people: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' }, admin: { id: 'admin', name: 'Админ', role: 'ADMIN' },
    dev: { id: 'dev', name: 'Разработчик', role: 'MODULE_DEVELOPER', perms: ['module.develop'] }, ann: { id: 'ann', name: 'Анна Сидорова', role: 'ENGINEER_AUTO' },
  };
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex, can: (u: any, f: string) => u.role === 'OWNER' || (u.perms || []).includes(f) });
  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() as any : null };
  };
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex, 'dev') });
  const publish = async (id: string, name: string, summary: string, patch: Record<string, unknown>) => {
    const manifest = { id, name, entries: ['start'], reads: [], ...patch, store: { category: 'other', summary, description: `${summary}. Данные хранятся на этом компьютере.`, color: '#2563eb' } };
    const bundle = moduleBundle('1.0.0', {}, manifest);
    const sent = await call('dev', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, bundle, { moduleId: id, version: '1.0.0', changelog: 'Первая версия', contractVersion: 3 }), bundle: Buffer.from(bundle).toString('base64') });
    assert.equal(sent.status, 200, sent.body?.error);
    const released = await call('owner', `/api/modules/requests/${sent.body.id}/release`, 'POST', { signature: releaseEnvelope(root, bundle, { moduleId: id, version: '1.0.0', author: devHex, request: sent.body.id, channel: 'production', contractVersion: 3 }) });
    assert.equal(released.status, 200, released.body?.error);
    assert.equal((await call('admin', `/api/modules/store/${id}/admission`, 'POST', { status: 'admitted' })).status, 200);
  };
  const com = [{ id: 'fso', kind: 'com', progId: 'Scripting.FileSystemObject', allowDangerous: true, app: 'Файловые имена Windows', does: 'Разбирает имена файлов на части, не читая и не записывая диск', access: 'read' }];
  await publish('quick-notes', 'Быстрые заметки', 'Заметки инженера', { contractVersion: 3 });
  await publish('com-notes', 'Заметки с E3', 'Заметки и имена файлов', { contractVersion: 3, connections: com });
  await publish('net-rates', 'Курсы валют', 'Курсы из открытых сервисов', { contractVersion: 3, permissions: [{ kind: 'internet', does: 'Загружает курсы валют из открытых сервисов' }] });
  await publish('lan-probe', 'Опрос сети', 'Опрашивает контроллеры', { contractVersion: 3, permissions: [{ kind: 'lan', does: 'Находит контроллеры в локальной сети цеха' }] });
  await publish('chain-notes', 'Заметки с расчётом', 'Берёт значение у другой программы', { contractVersion: 3, permissions: [{ kind: 'program', program: 'quick-notes', does: 'Берёт у быстрых заметок последнюю запись' }] });
  await publish('flux-reader', 'Читатель проекта', 'Показывает данные проекта', { contractVersion: 3, reads: ['project'] });
  await publish('equip-notes', 'Заметки к позиции', 'Заметки к оборудованию', { contractVersion: 3, entries: ['start', 'equipment'] });
  const listings: any[] = (await call('ann', '/api/modules/store')).body.listings;
  check(`настоящая витрина отдаёт семь допущенных программ (${listings.length})`, listings.length === 7);

  // ── Свой Vite: экран Store и настоящая служба за прокси (Authorization подставляет прокси: вошёл «ann») ──
  // Свой Vite всегда: за его прокси стоит настоящая служба этого набора (общий сервер разработки до неё не дотянется)
  const port = await freePort();
  const vite: ViteDevServer = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null,
    proxy: { '/api': { target: origin, changeOrigin: true, headers: { Authorization: 'Bearer ann' } } } } });
  await vite.listen();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    // Подставлен только главный процесс (store-ui.tsx): его запросы вместе с данными пишутся в журнал страницы
    const ipcLog = () => page.evaluate(() => (window as any).__ipcLog as Array<{ channel: string; data: any }>);
    const offlineLabel = (id: string) => page.locator(`[data-testid="stx-card-${id}"] [data-testid="stx-offline"]`);
    const setTheme = (dark: boolean) => page.evaluate(d => { document.documentElement.classList.toggle('dark', d); }, dark);
    const measure = async (selector: string) => page.locator(selector).first().evaluate(node => {
      const cs = getComputedStyle(node); const bounds = node.getBoundingClientRect();
      return { font: parseFloat(cs.fontSize), weight: cs.fontWeight, height: bounds.height, right: bounds.right, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });

    await page.goto(`${base}/scripts/fixtures/store-ui.html`);
    await page.getByTestId('stx-hero').waitFor();
    await page.getByTestId('stx-nav-apps').click();
    await page.getByTestId('stx-card-quick-notes').waitFor();
    // Карточки появляются по одной (задержка по номеру): снимок и замер — после того, как все показались целиком
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="stx-card-"]')].every(card => getComputedStyle(card).opacity === '1'));

    console.log('Метка в карточках витрины');
    check('«Быстрые заметки» (самостоятельная без разрешений): метка есть', await offlineLabel('quick-notes').count() === 1);
    check('текст метки — «Работает без связи», строкой карточки и без обрезки многоточием', await offlineLabel('quick-notes').innerText() === 'Работает без связи'
      && await offlineLabel('quick-notes').evaluate(node => node.scrollWidth <= node.clientWidth));
    check('подключение к программе на компьютере (COM) метку не снимает', await offlineLabel('com-notes').count() === 1);
    for (const [id, why] of [['net-rates', 'интернет'], ['lan-probe', 'локальная сеть'], ['chain-notes', 'обращение к другой программе'], ['flux-reader', 'читает данные Flux'], ['equip-notes', 'открывается из карточки оборудования']] as const) {
      check(`без метки: ${id} (${why})`, await page.getByTestId(`stx-card-${id}`).count() === 1 && await offlineLabel(id).count() === 0);
    }
    for (const dark of [false, true]) {
      await setTheme(dark);
      const m = await measure('[data-testid="stx-card-quick-notes"] [data-testid="stx-offline"]');
      check(`${dark ? 'тёмная' : 'светлая'}: метка в карточке — шрифт не мельче 12 px, горизонтальной прокрутки нет (${m.font}px)`, m.font >= 12 && m.overflowX <= 0);
      await page.screenshot({ path: path.join(shots, `store-cards-${dark ? 'dark' : 'light'}.png`) });
    }
    await setTheme(false);

    console.log('Страница программы и окно установки');
    await page.getByTestId('stx-card-quick-notes').click();
    await page.getByTestId('stx-page').waitFor();
    check('на странице программы метка в строке сведений, с пояснением', await page.locator('.stx-ph [data-testid="stx-offline"]').innerText() === 'Работает без связи'
      && /Не просит доступа к интернету/.test(await page.locator('.stx-ph [data-testid="stx-offline"]').getAttribute('title') || ''));
    await page.locator('.stx-ph').getByTestId('stx-act-quick-notes').click();
    await page.getByTestId('stx-dialog').waitFor();
    const dialogText = await page.getByTestId('stx-dialog').innerText();
    check('окно установки: разрешения настоящего манифеста — «Не читает данные Flux», «Ничего не записывает»', /Не читает данные Flux/.test(dialogText) && /Ничего не записывает/.test(dialogText));
    check('окно установки: метка и честное пояснение, что Flux без связи пока не запускается', /Работает без связи\./.test(dialogText) && /Сам Flux без связи пока не запускается/.test(dialogText));
    for (const dark of [false, true]) {
      await setTheme(dark);
      const m = await measure('[data-testid="stx-dialog"] [data-testid="stx-offline"]');
      check(`${dark ? 'тёмная' : 'светлая'}: пояснение в окне установки — шрифт не мельче 12 px, прокрутки нет (${m.font}px)`, m.font >= 12 && m.overflowX <= 0
        && await page.getByTestId('stx-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await page.screenshot({ path: path.join(shots, `store-dialog-${dark ? 'dark' : 'light'}.png`) });
    }
    await setTheme(false);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    // Установка на настоящем маршруте сервера; выбор человека в главном процессе подставлен записью в его подделку (store-ui.tsx):
    // сам путь установки с подписями проверяют test-modules-store и test-modules-store-ui
    const install = async (id: string) => {
      const row = (await call('ann', '/api/modules/store')).body.listings.find((l: any) => l.moduleId === id);
      assert.equal((await call('ann', `/api/modules/installs/${id}`, 'PUT', { version: row.version })).status, 200);
      await page.evaluate(([listingId, version, manifest]) => {
        const verified = JSON.parse(sessionStorage.getItem('stx-verified') || '[]'), installed = JSON.parse(sessionStorage.getItem('stx-installed') || '{}');
        verified.push({ moduleId: listingId, version, channel: 'production', author: 'k', manifest }); installed[listingId] = { version, at: 1 };
        sessionStorage.setItem('stx-verified', JSON.stringify(verified)); sessionStorage.setItem('stx-installed', JSON.stringify(installed));
      }, [id, row.version, row.manifest] as const);
    };
    await install('quick-notes');
    check('сервер записал установку (настоящий маршрут)', (await call('ann', '/api/modules/installs')).body.installs.some((i: any) => i.moduleId === 'quick-notes'));
    await page.goto(`${base}/scripts/fixtures/store-ui.html`);

    console.log('Окно установки у программы с интернетом: метки нет');
    await page.getByTestId('stx-nav-apps').click();
    await page.getByTestId('stx-card-net-rates').click();
    await page.locator('.stx-ph').getByTestId('stx-act-net-rates').click();
    await page.getByTestId('stx-dialog').waitFor();
    check('программа с интернетом: в окне есть заметная строка, метки «без связи» нет', /Обращается к любому адресу в интернете/.test(await page.getByTestId('stx-dialog').innerText())
      && await page.locator('[data-testid="stx-dialog"] [data-testid="stx-offline"]').count() === 0 && await page.locator('.stx-ph [data-testid="stx-offline"]').count() === 0);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();

    console.log('Удаление: данные на этом компьютере');
    await page.getByTestId('stx-nav-library').click();
    await page.getByRole('button', { name: 'Удалить' }).first().click();
    const note = page.getByTestId('stx-delete-data');
    await note.waitFor();
    check('окно удаления самостоятельной программы: «Сохранённые программой данные на этом компьютере будут удалены»', await note.innerText() === 'Сохранённые программой данные на этом компьютере будут удалены');
    for (const dark of [false, true]) {
      await setTheme(dark);
      const m = await measure('[data-testid="stx-delete-data"]');
      check(`${dark ? 'тёмная' : 'светлая'}: строка в окне удаления — шрифт не мельче 12 px, прокрутки нет (${m.font}px)`, m.font >= 12 && m.overflowX <= 0);
      await page.screenshot({ path: path.join(shots, `store-remove-${dark ? 'dark' : 'light'}.png`) });
    }
    await setTheme(false);
    const before = (await ipcLog()).length;
    await page.getByRole('button', { name: 'Удалить', exact: true }).last().click();
    await page.waitForFunction(() => (window as any).__ipcLog.some((e: any) => e.channel === 'modules:state-clear'));
    const cleared = (await ipcLog()).slice(before).filter(e => e.channel === 'modules:state-clear');
    check('удаление просит главный процесс стереть область released именно этой программы, один раз', cleared.length === 1 && cleared[0].data.moduleId === 'quick-notes' && cleared[0].data.scope === 'released');
    check('до очистки программа снята и в главном процессе, и на сервере', (await ipcLog()).slice(before).findIndex(e => e.channel === 'modules:remove') < (await ipcLog()).slice(before).findIndex(e => e.channel === 'modules:state-clear')
      && !(await call('ann', '/api/modules/installs')).body.installs.some((i: any) => i.moduleId === 'quick-notes'));

    console.log('Удаление программы, читающей данные Flux: данных на диске нет, строки и очистки нет');
    await install('flux-reader');
    await page.goto(`${base}/scripts/fixtures/store-ui.html`);
    await page.getByTestId('stx-nav-library').click();
    await page.getByRole('button', { name: 'Удалить' }).first().click();
    await page.getByRole('button', { name: 'Удалить', exact: true }).last().waitFor();
    check('у программы, читающей данные Flux, строки про данные нет', await page.getByTestId('stx-delete-data').count() === 0);
    const beforeReader = (await ipcLog()).length;
    await page.getByRole('button', { name: 'Удалить', exact: true }).last().click();
    await page.waitForFunction(n => (window as any).__ipcLog.slice(n).some((e: any) => e.channel === 'modules:remove'), beforeReader);
    await page.waitForTimeout(300);
    check('и главный процесс стереть данные не просили', !(await ipcLog()).slice(beforeReader).some(e => e.channel === 'modules:state-clear'));

    check(`без ошибок исполнения страницы: ${JSON.stringify(errors)}`, errors.length === 0);
    console.log(`\n${passed} проверок пройдено. Снимки: ${shots}`);
  } finally {
    await browser.close();
    await vite.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
