/**
 * «Запустить во Flux» из Studio в настоящем Electron: папка обмена, проверка пакета разработки главным процессом,
 * настоящий протокол flux-module://, настоящее окно программы (ModuleFrame) и мост.
 *
 * Пакет подписан тестовым ключом разработчика с сертификатом тестового корня и лежит в папке обмена так, как его кладёт Studio.
 * Что доказывается:
 * - у своего человека пакет виден, но без согласия на разрешения не отдаётся; верное согласие (с отпечатком из манифеста) открывает его;
 * - у другого человека, без сертификата от владельца, после просрочки аренды, после «Убрать» и после отзыва ключа не отдаётся;
 * - пакет разработки на время заменяет установленную программу того же имени и отдаёт её обратно, когда он остановлен;
 * - новая сборка просит согласия заново; контрольные примеры блокируют пакет разработки, как выпуск;
 * - из программы запись в данные Flux по-прежнему невозможна (тот же мост: READ_ONLY).
 *
 * Запуск (Linux): xvfb-run -a npx tsx scripts/test-modules-dev-run-native.ts   Нужна сборка: npx vite build
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
  const { permissionsDigest } = await import('../modules/store/model');
  const { DEV_LEASE_TTL_MS, DEV_RUN_FILES } = await import('../modules/trust/devRun');
  const { PAGE_MIN_FLUX } = await import('../modules/page/model');
  const { languageBundle, fixtureManifest } = await import('./fixtures/moduleLanguages');
  const { certificateEnvelope, devLeaseEnvelope, devRunEnvelope, hexOf, newKey, releaseEnvelope, revocationEnvelope } = await import('./fixtures/moduleTrust');

  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-dev-run-native-'));
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const exchange = path.join(data, 'dev-run');
  const shots = process.env.FLUX_MODULE_SHOTS || path.join(temp, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev);

  // ── Выпущенная программа dev-page 1.0.0, установленная у человека «u»: подписана владельцем ──
  const CLIENT = '<script src="/_flux/flux.v1.js"></script>';
  const html = (title: string) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/_flux/flux-ui.v1.css"></head><body>${CLIENT}<h1 id="t">${title}</h1><script src="/ui/app.js"></script></body></html>`;
  const pageManifest = (id: string, version: string, extra: Record<string, unknown> = {}) => ({ id, name: `Программа ${id}`, version, author: 'Flux', contractVersion: 2, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page',
    store: { category: 'calc', summary: 'Проверка', requires: { flux: PAGE_MIN_FLUX } }, ...extra });
  const pageBundle = (id: string, version: string, title: string, extra: Record<string, unknown> = {}) => packBundle({
    'manifest.json': JSON.stringify(pageManifest(id, version, extra)), 'logic/main.ts': 'export default {};',
    'ui/index.html': html(title), 'ui/app.js': "flux.ready.then(() => { document.body.dataset.ready = '1'; });",
  });
  const cache = new ModuleCache(data, rootHex);
  {
    const bundle = pageBundle('dev-page', '1.0.0', 'ВЫПУСК 1.0.0');
    const signature = releaseEnvelope(root, bundle, { moduleId: 'dev-page', version: '1.0.0', author: devHex, contractVersion: 2 });
    const result = await cache.install({ id: 'rel-dev-page', moduleId: 'dev-page', version: '1.0.0', signature }, splitChunks(bundle));
    assert.ok(result.ok, `выпуск: ${result.why}`);
  }
  const selection = new ModuleSelection(path.join(data, 'selection.json'));
  await selection.load(); await selection.activate('u'); await selection.install('dev-page', '1.0.0', { dirty: false });

  /** Кладёт папку обмена так, как её кладёт Studio: пакет и run.json раньше аренды */
  function place(moduleId: string, bundle: Uint8Array, p: { certUser?: string; runUser?: string; leaseAt?: number } = {}) {
    const dir = path.join(exchange, moduleId);
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, DEV_RUN_FILES.lease), { force: true });
    const version = JSON.parse(Buffer.from(packedManifest(bundle)).toString('utf8')).version;
    fs.writeFileSync(path.join(dir, DEV_RUN_FILES.bundle), bundle);
    fs.writeFileSync(path.join(dir, DEV_RUN_FILES.run), JSON.stringify({ v: 1, certificate: certificateEnvelope(root, devHex, p.certUser ?? 'u'),
      run: devRunEnvelope(dev, bundle, { moduleId, version, userId: p.runUser ?? 'u' }) }));
    fs.writeFileSync(path.join(dir, DEV_RUN_FILES.lease), devLeaseEnvelope(dev, bundle, { iat: p.leaseAt ?? Date.now() }));
  }
  const { unpackBundle } = await import('../modules/trust/bundle');
  const packedManifest = (bundle: Uint8Array) => unpackBundle(bundle)['manifest.json'];
  const renew = (moduleId: string, bundle: Uint8Array, iat = Date.now()) => fs.writeFileSync(path.join(exchange, moduleId, DEV_RUN_FILES.lease), devLeaseEnvelope(dev, bundle, { iat }));
  // «Studio открыта»: аренду каждые 5 с продлевает сама проверка, пока ей не скажут «закрыта» (срок аренды — 75 с, а набор идёт дольше)
  const studio = new Map<string, { bundle: Uint8Array; open: boolean }>();
  const keeper = setInterval(() => { for (const [id, s] of studio) if (s.open && fs.existsSync(path.join(exchange, id))) { try { renew(id, s.bundle); } catch { /* папку убирают */ } } }, 5000);
  const placeOpen = (moduleId: string, bundle: Uint8Array, p: { certUser?: string; runUser?: string } = {}) => { place(moduleId, bundle, p); studio.set(moduleId, { bundle, open: true }); };

  const devPage = pageBundle('dev-page', '0.2.0', 'РАЗРАБОТКА 0.2.0', { permissions: [{ kind: 'internet', does: 'Показывает курсы валют' }], contractVersion: 3 });
  const devSolo = pageBundle('dev-solo', '0.1.0', 'СОЛО 0.1.0');
  placeOpen('dev-page', devPage);
  placeOpen('dev-solo', devSolo);
  placeOpen('dev-other', pageBundle('dev-other', '0.1.0', 'ЧУЖАЯ'), { certUser: 'u2', runUser: 'u2' });
  placeOpen('dev-mixed', pageBundle('dev-mixed', '0.1.0', 'СМЕШАННАЯ'), { certUser: 'u', runUser: 'u2' });
  const pyBundle = languageBundle('python', { id: 'dev-py' });
  placeOpen('dev-py', pyBundle);

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
    env: { ...process.env, FLUX_MODULE_FIXTURE_DIR: temp, FLUX_MODULE_FIXTURE_URL: `${url}/`, FLUX_TEST_ROOT: rootHex, FLUX_TEST_DIR: data, FLUX_TEST_DEV_DIR: exchange, FLUX_FAKE_COM: '1' }, timeout: 60000 });
  const page = await electron.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForLoadState('load');

  const ipc = (channel: string, payload?: unknown) => page.evaluate(([c, d]) => (window as any).electron.ipcRenderer.invoke(c, d), [channel, payload] as [string, unknown]);
  const fetchMain = (target: string) => electron.evaluate(async ({ net }, u) => { const r = await net.fetch(u); return { status: r.status, text: r.status === 200 ? await r.text() : '' }; }, target);
  const items = async () => ((await ipc('modules:devRuns')) as any).items as any[];
  const item = async (id: string) => (await items()).find(i => i.moduleId === id);
  // Опрос папки обмена при обращении не чаще раза в полторы секунды: после правки файлов даём ему пройти
  const settle = () => page.waitForTimeout(1700);
  const titleOf = async (id: string) => (await fetchMain(`flux-module://${id}/ui/index.html`)).text.match(/<h1 id="t">([^<]*)</)?.[1] ?? null;
  const changes = () => page.evaluate(() => (window as any).__devChanged as number);
  const listen = () => page.evaluate(() => { (window as any).__devChanged = 0; (window as any).electron.ipcRenderer.on('modules:devChanged', () => { (window as any).__devChanged++; }); });
  const manifestOfDev = (bundle: Uint8Array) => JSON.parse(Buffer.from(packedManifest(bundle)).toString('utf8'));
  const accept = async (id: string, bundle: Uint8Array) => {
    const it = await item(id);
    return ipc('modules:devAccept', { moduleId: id, sha256: it.sha256, digest: permissionsDigest(manifestOfDev(bundle)) }) as Promise<any>;
  };
  await listen();

  try {
    // ── 1. Что видит человек и что запускается без согласия ──
    await settle();
    const ids = (await items()).map(i => i.moduleId).sort();
    check(`у человека «u» виден его пакет и отказанный смешанный; чужой не виден: ${ids}`, ids.includes('dev-page') && ids.includes('dev-solo') && ids.includes('dev-mixed') && !ids.includes('dev-other'));
    const page0 = await item('dev-page');
    check('проверенный пакет: манифест, разработчик, не принят', page0.live && !page0.accepted && page0.version === '0.2.0' && page0.developer === 'Разработчик' && page0.manifest?.id === 'dev-page');
    check('смешанный пакет отказан словами: собран другим человеком', !(await item('dev-mixed')).live && /другим человеком/.test((await item('dev-mixed')).why));
    check('без согласия пакет разработки не отдаётся (у программы без выпуска — 404)', (await fetchMain('flux-module://dev-solo/ui/index.html')).status === 404);
    check('без согласия работает установленный выпуск, а не пакет разработки', await titleOf('dev-page') === 'ВЫПУСК 1.0.0');
    check('чужой и смешанный пакеты не отдаются', (await fetchMain('flux-module://dev-other/ui/index.html')).status === 404 && (await fetchMain('flux-module://dev-mixed/ui/index.html')).status === 404);
    const state0 = await ipc('modules:state') as any;
    check('состояние Store: выпуск в runnable, разработка отдельно и не принята', state0.runnable.some((r: any) => r.manifest.id === 'dev-page' && r.version === '1.0.0')
      && state0.dev.some((d: any) => d.moduleId === 'dev-page' && !d.accepted));

    // ── 2. Согласие ──
    const bad = await ipc('modules:devAccept', { moduleId: 'dev-page', sha256: page0.sha256, digest: 'не те разрешения' }) as any;
    check('согласие с чужим отпечатком разрешений отклонено', bad.ok === false && /не совпали/.test(bad.error));
    check('согласие на чужой хеш сборки отклонено', (await ipc('modules:devAccept', { moduleId: 'dev-page', sha256: 'a'.repeat(64), digest: permissionsDigest(manifestOfDev(devPage)) }) as any).ok === false);
    check('согласие на не прошедший проверку пакет отклонено', (await ipc('modules:devAccept', { moduleId: 'dev-mixed', sha256: 'a'.repeat(64), digest: 'x' }) as any).ok === false);
    const before = await changes();
    check('верное согласие принято', (await accept('dev-page', devPage)).ok === true);
    check('окно известили событием', (await page.waitForFunction(n => (window as any).__devChanged > n, before).then(() => true, () => false)));
    check('согласие на разрешения сборки: пакет разработки заменил установленный выпуск', await titleOf('dev-page') === 'РАЗРАБОТКА 0.2.0');
    const state1 = await ipc('modules:state') as any;
    check('в состоянии Store выпуск по-прежнему в runnable, разработка принята', state1.runnable.some((r: any) => r.manifest.id === 'dev-page' && r.version === '1.0.0') && state1.dev.some((d: any) => d.moduleId === 'dev-page' && d.accepted));
    check('автор из пакета — разработчик с сертификатом, запись не в кэше выпусков', !fs.existsSync(path.join(data, 'releases', 'dev-page', '0.2.0')) && fs.existsSync(path.join(data, 'releases', 'dev-page', '1.0.0')));
    check('протокол: страница с CSP страницы, клиент Flux, чужие пути 404', (await fetchMain('flux-module://dev-page/_flux/flux.v1.js')).status === 200
      && (await fetchMain('flux-module://dev-page/manifest.json')).status === 404 && (await fetchMain('flux-module://dev-page/ui/%2e%2e/manifest.json')).status === 404);

    // ── 3. Окно программы: пакет разработки запускается настоящим ModuleFrame, а запись в данные Flux невозможна ──
    const manifestJson = JSON.stringify(manifestOfDev(devPage));
    await page.goto(`${url}/?manifest=${encodeURIComponent(manifestJson)}`);
    await page.waitForLoadState('load');
    const started = Date.now();
    let frame: any;
    while (Date.now() - started < 30000) {
      frame = page.frames().find(f => f.url().startsWith('flux-module://dev-page/'));
      if (frame && await frame.evaluate(() => document.body.dataset.ready === '1').catch(() => false)) break;
      await page.waitForTimeout(200);
    }
    check('окно программы разработки запущено, страница — сборка разработки', !!frame && await frame.locator('#t').innerText() === 'РАЗРАБОТКА 0.2.0');
    await frame.evaluate('globalThis.__name = (fn) => fn');
    const reply = await frame.evaluate(() => new Promise<any>(resolve => {
      const session = window.name || location.hash.slice(1);
      addEventListener('message', e => { if (e.data && e.data.id === 'w1') resolve(e.data); });
      parent.postMessage({ flux: 'module', v: 1, session, id: 'w1', type: 'write-equipment', value: 1 }, '*');
      setTimeout(() => resolve({ timeout: true }), 3000);
    }));
    check(`запись в данные Flux из программы разработки — READ_ONLY (${JSON.stringify(reply).slice(0, 120)})`, JSON.stringify(reply).includes('READ_ONLY'));
    check('чтение того же моста работает', await frame.evaluate(async () => (await flux.read('project'))?.name) === 'Тестовый проект');
    for (const dark of [false, true]) {
      await page.evaluate(d => document.documentElement.classList.toggle('dark', d), dark);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(shots, `dev-run-${dark ? 'dark' : 'light'}.png`) });
    }
    await page.goto(`${url}/`); await page.waitForLoadState('load'); await listen();

    // ── 4. Срок аренды ──
    const gone = await changes();
    studio.get('dev-page')!.open = false;
    renew('dev-page', devPage, Date.now() - DEV_LEASE_TTL_MS - 5000);
    await settle();
    check('аренда просрочена: возвращается установленный выпуск', await titleOf('dev-page') === 'ВЫПУСК 1.0.0');
    const expired = await item('dev-page');
    check('в списке причина словами, пакет не живой', !expired.live && /Studio закрыта/.test(expired.why));
    check('окну сообщено об истечении', await changes() > gone);
    studio.get('dev-page')!.open = true;
    renew('dev-page', devPage);
    await settle();
    check('Studio продлила аренду: та же сборка запускается снова, согласие в памяти', await titleOf('dev-page') === 'РАЗРАБОТКА 0.2.0');

    // ── 5. Другой человек на этом же компьютере ──
    await ipc('modules:activate', { userId: 'u2' });
    check('у другого вошедшего пакет не отдаётся: выпуск не установлен — 404', (await fetchMain('flux-module://dev-page/ui/index.html')).status === 404);
    check('и список разработки у него без чужого', (await items()).length === 1 && (await items())[0].moduleId === 'dev-other');
    await ipc('modules:activate', { userId: 'u' });
    check('вернулся свой человек: согласие в памяти действует', await titleOf('dev-page') === 'РАЗРАБОТКА 0.2.0');

    // ── 6. Новая сборка просит согласия заново ──
    const devPage2 = pageBundle('dev-page', '0.2.1', 'РАЗРАБОТКА 0.2.1', { permissions: [{ kind: 'internet', does: 'Показывает курсы валют' }], contractVersion: 3 });
    placeOpen('dev-page', devPage2);
    await settle();
    check('новая сборка проверена, но не принята: снова работает выпуск', (await item('dev-page')).version === '0.2.1' && !(await item('dev-page')).accepted && await titleOf('dev-page') === 'ВЫПУСК 1.0.0');
    check('согласие на новую сборку принято и действует', (await accept('dev-page', devPage2)).ok === true && await titleOf('dev-page') === 'РАЗРАБОТКА 0.2.1');

    // ── 7. «Убрать» ──
    const removed = await ipc('modules:devRemove', { moduleId: 'dev-page' }) as any;
    check('«Убрать»: папка обмена удалена, запись исчезла', removed.ok === true && !fs.existsSync(path.join(exchange, 'dev-page')) && !(await item('dev-page')));
    check('после «Убрать» работает установленный выпуск', await titleOf('dev-page') === 'ВЫПУСК 1.0.0');
    await settle();
    check('опрос не вернул убранное', !(await item('dev-page')));

    // ── 8. Программа без выпуска: запуск, потом папку убрала Studio ──
    check('dev-solo принята', (await accept('dev-solo', devSolo)).ok === true && await titleOf('dev-solo') === 'СОЛО 0.1.0');
    fs.rmSync(path.join(exchange, 'dev-solo'), { recursive: true, force: true });
    await settle();
    check('папка исчезла (Studio убрала сама): 404', (await fetchMain('flux-module://dev-solo/ui/index.html')).status === 404 && !(await item('dev-solo')));

    // ── 9. Контрольные примеры действуют как у выпуска ──
    const pyVersion = fixtureManifest('python').version;
    const py = await item('dev-py');
    check('Python-пакет проверен', py.live && py.version === pyVersion);
    check('до согласия логика Python не отдаётся', (await fetchMain('flux-module://dev-py/logic.py')).status === 404);
    check('Python принят: логика отдаётся', (await accept('dev-py', pyBundle)).ok === true && (await fetchMain('flux-module://dev-py/logic.py')).status === 200);
    const gate = await ipc('modules:controls', { moduleId: 'dev-py' }) as any;
    check('контрольные примеры нужны и ещё не прогонялись', gate.ok && gate.required === true && gate.status === 'unknown');
    await ipc('modules:controls-result', { moduleId: 'dev-py', version: pyVersion, outcome: 'mismatch' });
    check('расхождение контрольных примеров закрывает код пакета разработки', (await fetchMain('flux-module://dev-py/logic.py')).status === 404 && (await fetchMain('flux-module://dev-py/runtime.js')).status === 404);

    // ── 10. Отзыв ключа разработчика останавливает запуск без нового пакета ──
    const solo2 = pageBundle('dev-solo', '0.1.1', 'СОЛО 0.1.1');
    placeOpen('dev-solo', solo2);
    await settle();
    check('dev-solo положена заново и принята', (await accept('dev-solo', solo2)).ok === true && await titleOf('dev-solo') === 'СОЛО 0.1.1');
    await ipc('modules:sync', { revocations: [revocationEnvelope(root, 'key', devHex)] });
    await settle();
    check('ключ отозван владельцем: пакет разработки не отдаётся, причина в списке', (await fetchMain('flux-module://dev-solo/ui/index.html')).status === 404 && /отозван/.test((await item('dev-solo')).why));

    check(`без ошибок исполнения окна Flux: ${JSON.stringify(errors)}`, errors.length === 0);
    console.log(`\n${passed} проверок пройдено. Снимки: ${shots}`);
  } finally {
    clearInterval(keeper);
    await electron.close(); server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
