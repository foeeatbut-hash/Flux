/**
 * Страница программы (договор v2) в настоящем Electron: подписанные выпуски через настоящий протокол flux-module://,
 * кэш проверенных выпусков, ModuleFrame, навигация кадра и окно запроса Flux.
 *
 * Что доказывается на настоящем пути (а не на самодельном http-хосте, как в test-modules-page):
 * - страница показывается, отдаётся с CSP страницы, `_flux/` отдаётся, чужие и служебные пути, `..`, `%2e`, абсолютные — 404;
 * - программа с формой не получает ui/**, форма работает как прежде;
 * - переход кадра наружу, на другую программу и на служебный файл отменён; чужие ui-файлы не грузятся;
 * - ссылка на вторую страницу пакета работает вместе с мостом, мост переживает переход не по ссылке (window.name);
 * - шестое окно — LIMIT, необъявленная страница — DENIED; saveFile показывает вопрос Flux, исполняемые имена отклоняются;
 * - зависшая страница даёт «Программа не отвечает» с перезапуском, страница без клиента flux.v1.js баннера не получает;
 * - WebRTC в кадре не раскрывает адреса компьютера.
 *
 * Запуск (Linux): xvfb-run -a npx tsx scripts/test-modules-page-native.ts   Нужна сборка: npx vite build
 */
import { verifySkip } from './verifySkip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';

declare const flux: any;

async function main() {
  if (process.platform !== 'win32' && !(process.platform === 'linux' && process.env.DISPLAY)) {
    if (process.env.CI) throw new Error('В CI нужен дисплей (Windows или xvfb-run): проверка в настоящем Electron обязательна');
    verifySkip('нужны Windows либо Linux с DISPLAY (xvfb-run)');
    return;
  }
  if (!fs.existsSync('dist/modules/_shell/index.html') || !fs.existsSync('dist/modules/_flux/flux.v1.js')) {
    if (process.env.CI) throw new Error('В CI нет сборки dist/modules (_shell, _flux): npm run build');
    verifySkip('нет сборки dist/modules (npx vite build)');
    return;
  }
  const { _electron } = await import('playwright-core');
  const { default: express } = await import('express');
  const { ModuleCache } = await import('../electron/moduleCache');
  const { ModuleSelection } = await import('../electron/moduleSelection');
  const { splitChunks, packBundle } = await import('../modules/trust/bundle');
  const { buildModuleRuntime } = await import('../modules/build');
  const { PAGE_CSP } = await import('../modules/protocol');
  const { PAGE_MIN_FLUX } = await import('../modules/page/model');
  const { hexOf, newKey, releaseEnvelope } = await import('./fixtures/moduleTrust');

  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-page-native-'));
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const shots = process.env.FLUX_MODULE_SHOTS || path.join(temp, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const root = newKey(), rootHex = hexOf(root), dev = hexOf(newKey());

  // ── Подписанные выпуски: четыре страницы и одна форма ──
  const cache = new ModuleCache(data, rootHex);
  const manifests: Record<string, any> = {};
  const installed: string[] = [];
  const CLIENT = '<script src="/_flux/flux.v1.js"></script>';
  const html = (body: string, client = true) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/_flux/flux-ui.v1.css"></head><body>${client ? CLIENT : ""}${body}</body></html>`;
  const pageManifest = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Программа ${id}`, version: '1.0.0', author: 'Flux', contractVersion: 2, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page',
    store: { category: 'calc', summary: 'Проверка', requires: { flux: PAGE_MIN_FLUX } }, ...extra });
  async function publishFiles(id: string, manifest: any, files: Record<string, string>, contractVersion = 2) {
    const bundle = packBundle({ 'manifest.json': JSON.stringify(manifest), 'logic/main.ts': 'export default {};', ...files });
    const signature = releaseEnvelope(root, bundle, { moduleId: id, version: manifest.version, author: dev, contractVersion });
    const result = await cache.install({ id: `rel-${id}`, moduleId: id, version: manifest.version, signature }, splitChunks(bundle));
    assert.ok(result.ok, `${id}: ${result.why}`);
    installed.push(id); manifests[id] = manifest;
  }
  await publishFiles('page-app', pageManifest('page-app', { pages: ['second.html'] }), {
    'ui/index.html': html('<h1 id="t">Страница программы</h1><a id="next" href="second.html">Вторая</a><canvas id="c" width="40" height="20"></canvas><script src="/ui/app.js"></script>'),
    'ui/app.js': "flux.ready.then(() => { document.body.dataset.ready = '1'; });",
    'ui/second.html': html('<p id="second">вторая страница</p><script src="/ui/second.js"></script>'),
    'ui/second.js': "flux.ready.then(() => { document.body.dataset.ready = '1'; return flux.state.set({ second: true }); });",
  });
  await publishFiles('page-other', pageManifest('page-other'), {
    'ui/index.html': html('<h1>Чужая программа</h1>'), 'ui/secret.js': 'window.__secret = 1;',
    'ui/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
  });
  await publishFiles('page-hang', pageManifest('page-hang'), {
    'ui/index.html': html('<p>зависнет</p><script src="/ui/hang.js"></script>'),
    'ui/hang.js': "flux.ready.then(() => setTimeout(() => { for (;;) {} }, 300));",
  });
  await publishFiles('page-noclient', pageManifest('page-noclient'), { 'ui/index.html': html('<p id="plain">страница без клиента</p>', false) });
  // Форма v1: пакет с runtime.js, как раньше (и положенные в него ui-файлы отдаваться не должны)
  {
    const dir = path.join(temp, 'form-app');
    fs.cpSync(path.join('modules/fixtures', 'equipment-inspector'), dir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.id = 'form-app';
    const runtime = await buildModuleRuntime(dir, manifest);
    const bundle = packBundle({ 'manifest.json': JSON.stringify(manifest), 'form.json': fs.readFileSync(path.join(dir, 'form.json'), 'utf8'),
      'logic/main.ts': fs.readFileSync(path.join(dir, 'logic/main.ts'), 'utf8'), 'build/runtime.js': runtime, 'ui/index.html': '<h1>не должна отдаваться</h1>' });
    const signature = releaseEnvelope(root, bundle, { moduleId: 'form-app', version: manifest.version, author: dev });
    const result = await cache.install({ id: 'rel-form-app', moduleId: 'form-app', version: manifest.version, signature }, splitChunks(bundle));
    assert.ok(result.ok, `form-app: ${result.why}`);
    installed.push('form-app'); manifests['form-app'] = manifest;
  }
  const selection = new ModuleSelection(path.join(data, 'selection.json'));
  await selection.load(); await selection.activate('u');
  for (const id of installed) await selection.install(id, manifests[id].version, { dirty: false });
  check(`выпуски подписаны владельцем и лежат в кэше: ${installed.length}`, (await cache.runnable()).size === installed.length);

  // ── Электрон и страница-хост ──
  const app = express();
  const css = fs.readdirSync('dist/assets').filter(f => f.endsWith('.css'));
  await build({ entryPoints: ['scripts/fixtures/modules-page-host.tsx'], bundle: true, platform: 'browser', outfile: path.join(temp, 'host.js'), format: 'esm',
    define: { __APP_VERSION__: '"test"', __FLUX_E3_FAKE__: 'false', 'process.env.NODE_ENV': '"production"' } });
  await build({ entryPoints: ['scripts/fixtures/modules-conn-main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'main.cjs') });
  await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'preload.js') });
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">${css.map(f => `<link rel="stylesheet" href="/assets/${f}">`).join('')}</head><body style="margin:0"><div id="root"></div><script type="module" src="/host.js"></script></body></html>`));
  app.get('/host.js', (_req, res) => res.sendFile(path.join(temp, 'host.js')));
  app.use('/assets', express.static('dist/assets'));
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const electron = await _electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(temp, 'main.cjs')],
    env: { ...process.env, FLUX_MODULE_FIXTURE_DIR: temp, FLUX_MODULE_FIXTURE_URL: `${url}/`, FLUX_TEST_ROOT: rootHex, FLUX_TEST_DIR: data, FLUX_FAKE_COM: '1' }, timeout: 60000 });
  const page = await electron.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (process.env.FLUX_DEBUG) console.log('[console]', m.type(), m.text()); });
  await page.waitForLoadState('load');
  const open = async (id: string, query = '') => {
    await page.goto(`${url}/?manifest=${encodeURIComponent(JSON.stringify(manifests[id]))}${query}`);
    await page.waitForLoadState('load');
  };
  const frameOf = (id: string) => page.frames().find(f => f.url().startsWith(`flux-module://${id}/`));
  const waitFrame = async (id: string, ready: (f: NonNullable<ReturnType<typeof frameOf>>) => Promise<boolean>, ms = 30000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const f = frameOf(id);
      if (f && await ready(f).catch(() => false)) return f;
      await page.waitForTimeout(200);
    }
    const dbg = await frameOf(id)?.evaluate(() => ({ flux: typeof (window as any).flux, name: window.name, hash: location.hash, ready: document.body.dataset.ready, scripts: [...document.scripts].map(x => x.src) })).catch(e => String(e));
    console.log('состояние кадра:', JSON.stringify(dbg));
    throw new Error(`кадр ${id} не дошёл до нужного состояния; сейчас: ${frameOf(id)?.url()}`);
  };
  // tsx кладёт в сериализуемые функции __name; в кадре его нет
  const ev = async (f: NonNullable<ReturnType<typeof frameOf>>, fn: any, arg?: unknown): Promise<any> => { await f.evaluate('globalThis.__name = (fn) => fn'); return f.evaluate(fn, arg); };
  const ready = (f: NonNullable<ReturnType<typeof frameOf>>) => f.evaluate(() => document.body.dataset.ready === '1');
  // Запрос через настоящий обработчик протокола (net.fetch главного процесса): статус и заголовки как отдаёт Flux
  const fetchMain = (target: string) => electron.evaluate(async ({ net }, u) => {
    const r = await net.fetch(u); return { status: r.status, csp: r.headers.get('content-security-policy'), type: r.headers.get('content-type') };
  }, target);
  try {
    // ── 1. Страница показывается настоящим ModuleFrame ──
    await open('page-app');
    const frame = await waitFrame('page-app', ready);
    check('ModuleFrame показывает страницу программы по flux-module://', new URL(frame.url()).pathname === '/ui/index.html' && (await frame.locator('#t').innerText()) === 'Страница программы');
    check('кадр с sandbox allow-scripts и именем-сессией', await page.locator('iframe').getAttribute('sandbox') === 'allow-scripts' && (await page.locator('iframe').getAttribute('name'))!.length > 10);
    const own = await fetchMain('flux-module://page-app/ui/index.html');
    check('страница отдаётся с CSP страницы', own.status === 200 && own.csp === PAGE_CSP && /text\/html/.test(own.type || ''));
    check('клиент и набор Flux отдаются', (await fetchMain('flux-module://page-app/_flux/flux.v1.js')).status === 200 && (await fetchMain('flux-module://page-app/_flux/flux-ui.v1.css')).status === 200);
    check('набор Flux в странице применён (тема приходит токенами)', await ev(frame, () => !!getComputedStyle(document.documentElement).getPropertyValue('--flux-surface').trim()));
    for (const dark of [false, true]) {
      await page.evaluate(d => document.documentElement.classList.toggle('dark', d), dark);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, `page-${dark ? 'dark' : 'light'}.png`) });
    }

    // ── 2. Адреса: чужое, служебное и обходные пути — 404 ──
    const notFound = [
      'flux-module://page-app/ui/%2e%2e/manifest.json', 'flux-module://page-app/ui/../manifest.json', 'flux-module://page-app/ui/..%2fmanifest.json',
      'flux-module://page-app//etc/passwd', 'flux-module://page-app/ui//etc/passwd', 'flux-module://page-app/manifest.json', 'flux-module://page-app/logic/main.ts',
      'flux-module://page-app/ui/absent.js', 'flux-module://page-app/ui/.hidden.js', 'flux-module://page-app/_flux/other.js', 'flux-module://page-app/_flux/../runtime.js',
      'flux-module://page-app/build/runtime.js', 'flux-module://nobody/ui/index.html', 'flux-module://form-app/ui/index.html', 'flux-module://form-app/ui/%2e%2e/manifest.json',
    ];
    for (const target of notFound) check(`404: ${target}`, (await fetchMain(target)).status === 404);
    check('ui/ другой программы отдаётся только ей самой (по своему адресу)', (await fetchMain('flux-module://page-other/ui/secret.js')).status === 200);

    // ── 3. Навигация кадра ──
    for (const target of ['https://example.com/', 'file:///etc/passwd', 'flux-module://page-other/ui/index.html', 'flux-module://page-app/runtime.js', 'flux-module://page-app/index.html', 'flux-module://page-app/ui/second.js']) {
      await ev(frame, t => { location.href = t; }, target).catch(() => undefined);
      await page.waitForTimeout(500);
      check(`переход кадра отменён: ${target}`, frameOf('page-app')?.url().startsWith('flux-module://page-app/ui/index.html') === true);
    }
    const foreign = await ev(frame, () => new Promise<Record<string, string>>(resolve => {
      const out: Record<string, string> = {};
      const done = () => { if (Object.keys(out).length === 2) resolve(out); };
      const s = document.createElement('script'); s.src = 'flux-module://page-other/ui/secret.js';
      s.onload = () => { out.script = 'loaded'; done(); }; s.onerror = () => { out.script = 'blocked'; done(); }; document.head.append(s);
      const i = new Image(); i.onload = () => { out.image = 'loaded'; done(); }; i.onerror = () => { out.image = 'blocked'; done(); }; i.src = 'flux-module://page-other/ui/logo.svg';
    }));
    check('скрипт и картинка чужой программы не грузятся', foreign.script === 'blocked' && foreign.image === 'blocked' && await ev(frame, () => (window as any).__secret) === undefined);

    // ── 4. Вторая страница и мост ──
    await frame.click('#next');
    const second = await waitFrame('page-app', async f => f.url().includes('/ui/second.html') && await ready(f));
    check('ссылка на вторую страницу пакета работает, мост на ней отвечает', await ev(second, async () => (await flux.state.get()).second === true));
    await ev(second, () => { location.href = '/ui/index.html'; });
    const back = await waitFrame('page-app', async f => f.url().includes('/ui/index.html') && await ready(f));
    check('мост переживает переход не по ссылке (сессия в имени кадра)', await ev(back, async () => (await flux.read('project'))?.name) === 'Тестовый проект');

    // ── 5. Окна и сохранение ──
    check('необъявленная страница окна — DENIED', await ev(back, () => flux.windows.open('secret.html').then(() => 'ok', (e: any) => e.code)) === 'DENIED');
    await page.evaluate(() => (window as any).__fillWindows('page-app', 5));
    check('шестое окно — LIMIT', await ev(back, () => flux.windows.open('second.html').then(() => 'ok', (e: any) => e.code)) === 'LIMIT');
    check('saveFile показывает вопрос Flux с именем файла и отдаёт файл', await ev(back, () => flux.saveFile('result.csv', 'a;b\n1;2', 'text/csv')) === 'saved'
      && (await page.evaluate(() => (window as any).__dialogs as string[])).some(t => t.includes('result.csv')));
    const asked = (await page.evaluate(() => (window as any).__dialogs as string[])).length;
    for (const bad of ['setup.exe', 'run.BAT', 'CON', 'x.lnk']) {
      check(`saveFile отклоняет «${bad}» без вопроса`, await ev(back, n => flux.saveFile(n, 'x').then(() => 'ok', (e: any) => e.code), bad) === 'DENIED');
    }
    check('вопрос по запрещённым именам не показывался', (await page.evaluate(() => (window as any).__dialogs as string[])).length === asked);
    await page.evaluate(() => { (window as any).__answer = false; });
    await page.waitForTimeout(1100);
    check('отказ человека — CANCELLED', await ev(back, () => flux.saveFile('again.csv', 'x').then(() => 'ok', (e: any) => e.code)) === 'CANCELLED');
    await page.evaluate(() => { (window as any).__answer = true; });

    // ── 6. WebRTC не раскрывает адреса ──
    const candidates = await ev(back, () => new Promise<string[]>(resolve => {
      const found: string[] = [];
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('x');
        pc.onicecandidate = e => { if (e.candidate) found.push(e.candidate.candidate); };
        void pc.createOffer().then(o => pc.setLocalDescription(o));
        setTimeout(() => { pc.close(); resolve(found); }, 2500);
      } catch { resolve(found); }
    }));
    check(`WebRTC: локальных адресов в кандидатах нет (${candidates.length})`, candidates.every(c => !/ typ host/.test(c)));

    // ── 7. Программа с формой работает как прежде и ui/** не получает ──
    await open('form-app');
    const form = await waitFrame('form-app', async f => (await f.locator('body').innerText()).includes('Откройте модуль'));
    check('форма v1 открывается как прежде и отдаётся из runtime.js', new URL(form.url()).pathname === '/index.html' && (await fetchMain('flux-module://form-app/runtime.js')).status === 200);
    check('форма не получает ui/** даже если файл лежит в пакете', (await fetchMain('flux-module://form-app/ui/index.html')).status === 404);

    // ── 8. «Программа не отвечает» ──
    await open('page-noclient', '&hang=3000');
    await waitFrame('page-noclient', async f => (await f.locator('#plain').innerText()) === 'страница без клиента');
    await page.waitForTimeout(7000);
    check('страница без клиента flux.v1.js баннера не получает', await page.getByTestId('module-hung').count() === 0);
    await open('page-hang', '&hang=3000');
    await page.getByTestId('module-hung').waitFor({ timeout: 30000 });
    check('зависшая страница: «Программа не отвечает», остальной Flux жив (кнопка темы отвечает)', (await page.getByTestId('module-hung').innerText()).includes('не отвечает')
      && await page.evaluate(() => { document.getElementById('theme')!.click(); return true; }));
    await page.getByTestId('module-hung').getByRole('button', { name: 'Перезапустить' }).click();
    await page.getByTestId('module-hung').waitFor({ state: 'detached', timeout: 5000 });
    check('«Перезапустить» перезагружает кадр, баннер снят', true);
    check(`без ошибок исполнения окна Flux: ${JSON.stringify(errors)}`, errors.length === 0);
    console.log(`\n${passed} проверок пройдено. Снимки: ${shots}`);
  } finally {
    await electron.close(); server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
