/**
 * Подключения подпрограмм в настоящем Electron (этап 3б): подписанные выпуски через
 * настоящий протокол и кэш, окно запроса разрешения у человека, HTTP-пример против
 * локального сервера, COM-пример (на Windows — настоящий Scripting.FileSystemObject,
 * на других ОС — поддельный), журнал, разрешения и снимки обеих тем.
 *
 * Запуск (Linux): xvfb-run -a npx tsx scripts/test-modules-connections-native.ts
 * Нужна сборка: npx vite build (dist/modules/_shell).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';

async function main() {
  if (process.platform !== 'win32' && !(process.platform === 'linux' && process.env.DISPLAY)) {
    console.log('FLUX_VERIFY_SKIP: нужны Windows либо Linux с DISPLAY (xvfb-run)');
    return;
  }
  if (!fs.existsSync('dist/modules/_shell/index.html')) { console.log('FLUX_VERIFY_SKIP: нет сборки dist/modules/_shell (npx vite build)'); return; }
  const { _electron } = await import('playwright-core');
  const { default: express } = await import('express');
  const { ModuleCache } = await import('../electron/moduleCache');
  const { ModuleSelection } = await import('../electron/moduleSelection');
  const { splitChunks, packBundle } = await import('../modules/trust/bundle');
  const { buildModuleRuntime } = await import('../modules/build');
  const { hexOf, newKey, releaseEnvelope } = await import('./fixtures/moduleTrust');

  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-conn-native-'));
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const shots = process.env.FLUX_MODULE_SHOTS || path.join(temp, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const root = newKey(), rootHex = hexOf(root), dev = hexOf(newKey());

  // ── Сервер, к которому подпрограмма имеет право ходить (и счётчик обращений) ──
  const hits: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const api = createServer((req, res) => { hits.push({ url: req.url || '', headers: req.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answer: 42 })); });
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  const apiPort = (api.address() as any).port;

  // ── Подписанные выпуски: каждый — своя папка, чтобы собрать runtime.js ──
  const cache = new ModuleCache(data, rootHex);
  const manifests: Record<string, any> = {};
  const installed: string[] = [];
  async function publish(id: string, fixture: string, patch: (manifest: any) => void, logic?: string) {
    const dir = path.join(temp, id);
    fs.cpSync(path.join('modules/fixtures', fixture), dir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.id = id; patch(manifest);
    if (logic) fs.writeFileSync(path.join(dir, 'logic/main.ts'), logic);
    const runtime = await buildModuleRuntime(dir, manifest);
    const bundle = packBundle({ 'manifest.json': JSON.stringify(manifest), 'form.json': fs.readFileSync(path.join(dir, 'form.json'), 'utf8'),
      'logic/main.ts': fs.readFileSync(path.join(dir, 'logic/main.ts'), 'utf8'), 'build/runtime.js': runtime });
    const signature = releaseEnvelope(root, bundle, { moduleId: id, version: manifest.version, author: dev });
    const result = await cache.install({ id: `rel-${id}`, moduleId: id, version: manifest.version, signature }, splitChunks(bundle));
    assert.ok(result.ok, `${id}: ${result.why}`);
    installed.push(id); manifests[id] = manifest;
  }
  const point = (m: any) => { m.connections[0].url = `http://127.0.0.1:${apiPort}`; };
  await publish('conn-once', 'connections-http', point);
  await publish('conn-never', 'connections-http', point);
  await publish('conn-strict', 'connections-http', point, [
    "import type { ModuleApi } from '../../../contract';",
    'export function setup({ flux, state, calc, connect }: ModuleApi) {',
    '  flux.on(\'changed\', async () => {',
    '    const tries: string[] = [];',
    // Необъявленное подключение, чужой адрес в вызове и выход за префикс: ни одно не должно дойти до сервера
    "    try { await connect.http('nope', { method: 'GET', path: '/api/ping' }); tries.push('ok'); } catch (e) { tries.push((e as Error).message); }",
    "    try { await (connect as any).call('api', { op: 'http', method: 'GET', path: '/api/ping', url: 'http://127.0.0.1:1' }); tries.push('ok'); } catch (e) { tries.push((e as Error).message); }",
    '    state.problem = tries.join(\',\'); calc.out = { answer: \'\' };',
    '  });',
    '}',
  ].join('\n'));
  await publish('connections-com', 'connections-com', () => {});
  const selection = new ModuleSelection(path.join(data, 'selection.json'));
  await selection.load(); await selection.activate('u');
  for (const id of installed) await selection.install(id, '1.0.0', { dirty: false });
  check(`выпуски подписаны владельцем и лежат в кэше: ${installed.length}`, (await cache.runnable()).size === installed.length);

  // ── Электрон и страница ──
  const app = express();
  let journalRows: any[] = [];
  const css = fs.readdirSync('dist/assets').filter(f => f.endsWith('.css'));
  await build({ entryPoints: ['scripts/fixtures/modules-conn-host.tsx'], bundle: true, platform: 'browser', outfile: path.join(temp, 'host.js'), format: 'esm',
    define: { __APP_VERSION__: '"test"', __FLUX_E3_FAKE__: 'false', 'process.env.NODE_ENV': '"production"' } });
  await build({ entryPoints: ['scripts/fixtures/modules-conn-main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'main.cjs') });
  await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'preload.js') });
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">${css.map(f => `<link rel="stylesheet" href="/assets/${f}">`).join('')}</head><body style="margin:0"><div id="root"></div><script type="module" src="/host.js"></script></body></html>`));
  app.get('/host.js', (_req, res) => res.sendFile(path.join(temp, 'host.js')));
  app.get('/api/modules/journal', (_req, res) => res.json({ role: 'admin', entries: journalRows }));
  app.use('/assets', express.static('dist/assets'));
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const electron = await _electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(temp, 'main.cjs')],
    env: { ...process.env, FLUX_MODULE_FIXTURE_DIR: temp, FLUX_MODULE_FIXTURE_URL: `${url}/`, FLUX_TEST_ROOT: rootHex, FLUX_TEST_DIR: data, ...(process.platform === 'win32' ? {} : { FLUX_FAKE_COM: '1' }) }, timeout: 60000 });
  const page = await electron.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForLoadState('load');
  const ipc = (channel: string, payload: unknown) => page.evaluate(([c, p]) => (window as any).electron.ipcRenderer.invoke(c, p), [channel, payload] as [string, unknown]);
  const open = async (id: string) => {
    await page.goto(`${url}/?manifest=${encodeURIComponent(JSON.stringify(manifests[id]))}`);
    await page.waitForLoadState('load');
  };
  const frameText = async (id: string, needle: string, ms = 30000) => {
    const started = Date.now();
    let text = '';
    while (Date.now() - started < ms) {
      text = (await page.frames().find(f => f.url().startsWith(`flux-module://${id}/`))?.locator('body').innerText().catch(() => '')) || '';
      if (text.includes(needle)) return text;
      await page.waitForTimeout(250);
    }
    return text;
  };
  const prompt = page.locator('[data-testid="grant-prompt"]');
  const theme = async (dark: boolean) => {
    await page.evaluate(d => document.documentElement.classList.toggle('dark', d), dark);
  };
  try {
    // ── 1. Первое обращение: вопрос человеку, канал закрыт, пока он не ответил ──
    await open('conn-once');
    await prompt.waitFor({ timeout: 30000 });
    check('при первом обращении человек видит запрос, а до сервера обращений нет', await prompt.isVisible() && hits.length === 0);
    const title = await page.locator('.fx-dialog-head h3').innerText();
    check('заголовок: «„подпрограмма“ хочет подключиться к программе», одна строка о том, что она будет делать', title.includes('Расчёт на сервере') && title.includes('хочет подключиться к Сервер расчётов')
      && (await prompt.innerText()).includes('Отправляет на сервер расчётов номер проекта'));
    check('по умолчанию выбран «Только сейчас»', await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'grant-once');
    check('в свёрнутом виде нет подробностей и технических деталей', !(await page.locator('[data-testid="grant-details"]').count()) && !(await prompt.innerText()).includes('127.0.0.1'));
    for (const dark of [false, true]) { await theme(dark); await page.screenshot({ path: path.join(shots, `prompt-collapsed-${dark ? 'dark' : 'light'}.png`) }); }
    await page.locator('[data-testid="grant-more"]').click();
    const details = await page.locator('[data-testid="grant-details"]').innerText();
    check('«Подробнее»: что разрешается, чего подпрограмма не получит, кто выпустил и когда проверено', details.includes('отправлять данные') && details.includes('не получит') && details.includes('данные Flux') && details.includes('проверено владельцем'));
    check('технические детали свёрнуты ещё ниже', !(await page.locator('[data-testid="grant-tech-text"]').count()));
    await page.locator('[data-testid="grant-tech"]').click();
    check('«Для специалиста» раскрывает адрес', (await page.locator('[data-testid="grant-tech-text"]').innerText()).includes(`127.0.0.1:${apiPort}`));
    for (const dark of [false, true]) { await theme(dark); await page.screenshot({ path: path.join(shots, `prompt-details-${dark ? 'dark' : 'light'}.png`) }); }
    await theme(false);
    await page.locator('[data-testid="grant-once"]').click();
    const answered = await frameText('conn-once', '42');
    check('«Только сейчас»: вызов прошёл как есть, подпрограмма показала ответ сервера', answered.includes('42') && hits.length === 1 && hits[0].url === '/api/ping?from=flux');
    check('к серверу не ушли cookie Flux; заголовки соответствуют вызову', hits[0].headers.cookie === undefined && hits[0].headers['user-agent'] === 'Flux-Module');

    // «Только сейчас» не запоминается: в новом окне — снова вопрос; Esc = «Не разрешать» и запоминается
    await open('conn-once');
    await prompt.waitFor({ timeout: 30000 });
    check('«Только сейчас» не запомнилось: окно открыто заново — вопрос снова', await prompt.isVisible() && hits.length === 1);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="module-denied"]').waitFor({ timeout: 30000 });
    const denied = await frameText('conn-once', 'NOT_ALLOWED');
    check('Esc = «Не разрешать»: понятная плашка, подпрограмма работает без подключения, канал не открыт', denied.includes('NOT_ALLOWED') && hits.length === 1
      && (await page.locator('[data-testid="module-denied"]').innerText()).includes('Нет доступа к «Сервер расчётов»'));
    for (const dark of [false, true]) { await theme(dark); await page.screenshot({ path: path.join(shots, `denied-banner-${dark ? 'dark' : 'light'}.png`) }); }
    await theme(false);
    await open('conn-once');
    await frameText('conn-once', 'NOT_ALLOWED');
    check('«Не разрешать» запомнилось: вопроса нет, до сервера по-прежнему не дошло', !(await prompt.count()) && hits.length === 1);

    // Плашка «Разрешить…» сбрасывает решение — следующий обмен спрашивает снова; «Разрешить всегда» запоминается
    await page.locator('[data-testid="module-denied"] >> text=Разрешить…').click();
    await prompt.waitFor({ timeout: 30000 });
    await page.locator('[data-testid="grant-always"]').click();
    check('«Разрешить всегда»: вызов прошёл', (await frameText('conn-once', '42')).includes('42') && hits.length === 2);
    await open('conn-once');
    await frameText('conn-once', '42');
    check('«Разрешить всегда» запомнилось: вопроса больше нет', !(await prompt.count()) && hits.length === 3);

    // ── 2. «Не разрешать» кнопкой, у другой подпрограммы ──
    await open('conn-never');
    await prompt.waitFor({ timeout: 30000 });
    await page.locator('[data-testid="grant-never"]').click();
    await page.locator('[data-testid="module-denied"]').waitFor({ timeout: 30000 });
    check('«Не разрешать» кнопкой: отказ без обращения к серверу', hits.length === 3 && (await frameText('conn-never', 'NOT_ALLOWED')).includes('NOT_ALLOWED'));

    // ── 3. Границы: необъявленное подключение, чужой адрес в вызове, путь вне префикса, чужой выпуск ──
    await ipc('modules:grant', { moduleId: 'conn-strict', version: '1.0.0', connection: 'api', session: 'x', decision: 'always' });
    await open('conn-strict');
    const strict = await frameText('conn-strict', 'DENIED');
    check('необъявленное подключение и адрес внутри вызова отвергаются; до сервера ничего не дошло', strict.includes('DENIED,DENIED') && hits.length === 3);
    const outside: any = await ipc('modules:connect', { moduleId: 'conn-once', version: '1.0.0', session: 's', connection: 'api', call: { op: 'http', method: 'GET', path: '/api/../admin' } });
    const forged: any = await ipc('modules:connect', { moduleId: 'conn-once', version: '9.9.9', session: 's', connection: 'api', call: { op: 'http', method: 'GET', path: '/api/ping' } });
    const foreign: any = await ipc('modules:connect', { moduleId: 'нет-такой', version: '1.0.0', session: 's', connection: 'api', call: { op: 'http', method: 'GET', path: '/api/ping' } });
    const undeclaredGrant: any = await ipc('modules:grant', { moduleId: 'conn-once', version: '1.0.0', connection: 'нет', session: 's', decision: 'always' });
    check('главный процесс отказывает: путь вне префикса, неизвестная версия и подпрограмма, разрешение несуществующего подключения', outside.code === 'TARGET' && forged.code === 'DENIED'
      && foreign.code === 'DENIED' && undeclaredGrant.ok === false && hits.length === 3);
    const frames = await page.evaluate(() => document.querySelectorAll('iframe').length);
    check('окно подпрограммы не имеет доступа к IPC: решение «разрешить» возможно только из окна Flux', frames > 0 && await (async () => {
      const f = page.frames().find(x => x.url().startsWith('flux-module://conn-strict/'))!;
      return (await f.evaluate('typeof window.electron')) === 'undefined';
    })());

    // ── 4. COM ──
    await ipc('modules:grant', { moduleId: 'connections-com', version: '1.0.0', connection: 'fso', session: 'x', decision: 'always' });
    await open('connections-com');
    const com = await frameText('connections-com', 'схема-12');
    check(`COM-пример (${process.platform === 'win32' ? 'настоящий Scripting.FileSystemObject' : 'поддельный COM'}): имя без расширения и собранный путь`,
      com.includes('схема-12') && com.includes('C:\\Проекты\\схема-12.dwg'));

    // ── 5. Журнал: что есть и чего нет ──
    await page.waitForTimeout(1500);
    const recent: any = await ipc('modules:journal-recent', { limit: 500 });
    const rows: any[] = recent.entries;
    const text = JSON.stringify(rows);
    console.log('  виды записей:', [...new Set(rows.map(r => `${r.category}/${r.outcome}`))].join(', '));
    check('журнал: запуск, чтения, подключения, решения человека и сообщения подпрограммы', ['lifecycle', 'read', 'connection', 'permission', 'log'].every(c => rows.some(r => r.category === c)));
    check('журнал: итоги вызовов — успех, отказ человека, отказ по границе', rows.some(r => r.category === 'connection' && r.outcome === 'ok') && rows.some(r => r.outcome === 'user-denied') && rows.some(r => r.category === 'connection' && r.outcome === 'target'));
    check('журнал: без содержимого — нет ответа сервера, имени проекта и значений', !text.includes('"answer"') && !text.includes('Тестовый проект') && !text.includes('C:\\\\Проекты') && rows.every(r => typeof r.bytesIn === 'number'));
    const pending: any = await ipc('modules:journal-pending', {});
    check('журнал ждёт отправки на сервер пачкой, подтверждение убирает из очереди', pending.entries.length > 0 && (await ipc('modules:journal-ack', { upTo: pending.entries[pending.entries.length - 1].seq }), (await ipc('modules:journal-pending', {}) as any).entries.length === 0));

    // ── 6. Разрешения и журнал на экране, обе темы ──
    await page.goto(`${url}/?view=grants`);
    await page.waitForSelector('[data-testid="grants-row"]', { timeout: 30000 });
    const grantRows = await page.locator('[data-testid="grants-row"]').count();
    check('раздел «Разрешения»: каждое подключение с выбором «Разрешено / Спрашивать / Запрещено»', grantRows >= 4 && (await page.locator('[data-testid="grants-row"] select').count()) === grantRows);
    for (const dark of [false, true]) { await theme(dark); await page.screenshot({ path: path.join(shots, `grants-${dark ? 'dark' : 'light'}.png`) }); }
    await theme(false);
    await page.locator('[data-testid="grants-row"]', { hasText: 'Расчёт на сервере' }).first().locator('select').first().selectOption('ask');
    await page.waitForTimeout(500);
    const after: any = await ipc('modules:grants', {});
    check('выбор «Спрашивать» записан главным процессом', after.rows.some((r: any) => r.moduleId === 'conn-never' || r.moduleId === 'conn-once') && after.rows.some((r: any) => r.state === 'ask'));
    await page.locator('[data-testid="grants-reset"]').click();
    await page.waitForTimeout(500);
    check('«Сбросить все» возвращает «Спрашивать» везде', (await ipc('modules:grants', {}) as any).rows.every((r: any) => r.state === 'ask'));
    journalRows = rows.map((r: any) => ({ ...r, userName: 'Анна', userId: 'u', moduleId: r.moduleId === 'conn-once' ? 'connections-http' : r.moduleId, at: new Date(r.at).toISOString() }));
    await page.goto(`${url}/?view=journal`);
    await page.waitForSelector('[data-testid="journal-table"]', { timeout: 30000 });
    for (const dark of [false, true]) { await theme(dark); await page.screenshot({ path: path.join(shots, `journal-${dark ? 'dark' : 'light'}.png`) }); }
    check('журнал подпрограмм: таблица с фильтрами и выгрузкой', (await page.locator('[data-testid="journal-table"] tbody tr').count()) > 5 && await page.locator('[data-testid="journal-export"]').isVisible());
    check('ошибок страницы нет', errors.length === 0);
  } finally {
    await electron.close().catch(() => {});
    server.close(); api.close();
  }
  console.log(`\nПройдено проверок: ${passed}`);
}
void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
