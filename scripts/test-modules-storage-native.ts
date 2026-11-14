/**
 * Хранилище самостоятельной программы в настоящем Electron: подписанные выпуски, настоящие протокол, мост окна, IPC и главный
 * процесс (electron/moduleStorage.ts), настоящий диск. Окно проверок — настоящий ModuleFrame, кадр программы — настоящий sandbox.
 *
 * Что доказывается на настоящем пути:
 * - самостоятельная программа (ничего не читает во Flux, открывается из «Пуска») сохраняет состояние в файл
 *   `<данные>/program-data/<человек>/<id>/released/state.json`, и после перезагрузки окна получает его обратно;
 * - состояние ровно 1 МиБ проходит через postMessage кадра, мост и IPC; на байт больше — LIMIT, прежнее состояние цело;
 * - программа, читающая данные Flux, остаётся в памяти окна: на диск ничего не попадает, после перезагрузки окна состояния нет;
 * - повреждённый файл не затирается: откладывается рядом, программа получает пустое состояние;
 * - IPC очистки: чужая область (studio), неизвестная область и негодный идентификатор отвергнуты, своя области удалена, соседние целы.
 *
 * Запуск (Linux): xvfb-run -a npx tsx scripts/test-modules-storage-native.ts   Нужна сборка: npx vite build
 */
import { verifySkip } from './verifySkip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';

declare const flux: any;
const MIB = 1024 * 1024;

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
  const { userDirName } = await import('../modules/storage/disk');
  const { hexOf, newKey, releaseEnvelope } = await import('./fixtures/moduleTrust');

  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-storage-native-'));
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const storageDir = path.join(temp, 'program-data');
  const root = newKey(), rootHex = hexOf(root), dev = hexOf(newKey());
  const USER = 'u';

  // ── Подписанные выпуски: самостоятельная программа, вторая самостоятельная (для проверки соседей) и читающая данные Flux ──
  const cache = new ModuleCache(data, rootHex);
  const manifests: Record<string, any> = {};
  const installed: string[] = [];
  const html = (body: string) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><script src="/_flux/flux.v1.js"></script>${body}</body></html>`;
  const manifest = (id: string, reads: string[]) => ({ id, name: `Программа ${id}`, version: '1.0.0', author: 'Flux', contractVersion: 3, entries: ['start'], reads, logic: 'logic/main.ts', ui: 'page',
    store: { category: 'calc', summary: 'Проверка хранилища', requires: { flux: '1.0.0' } } });
  for (const [id, reads] of [['store-notes', []], ['store-twin', []], ['store-reader', ['project']]] as Array<[string, string[]]>) {
    const m = manifest(id, reads);
    const bundle = packBundle({ 'manifest.json': JSON.stringify(m), 'logic/main.ts': 'export default {};',
      'ui/index.html': html("<p id='t'>программа</p><script src='/ui/app.js'></script>"), 'ui/app.js': "flux.ready.then(() => { document.body.dataset.ready = '1'; });" });
    const signature = releaseEnvelope(root, bundle, { moduleId: id, version: m.version, author: dev, contractVersion: 3 });
    const result = await cache.install({ id: `rel-${id}`, moduleId: id, version: m.version, signature }, splitChunks(bundle));
    assert.ok(result.ok, `${id}: ${result.why}`);
    installed.push(id); manifests[id] = m;
  }
  const selection = new ModuleSelection(path.join(data, 'selection.json'));
  await selection.load(); await selection.activate(USER);
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
    env: { ...process.env, FLUX_MODULE_FIXTURE_DIR: temp, FLUX_MODULE_FIXTURE_URL: `${url}/`, FLUX_TEST_ROOT: rootHex, FLUX_TEST_DIR: data, FLUX_TEST_STORAGE_DIR: storageDir, FLUX_FAKE_COM: '1' }, timeout: 60000 });
  const page = await electron.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (process.env.FLUX_DEBUG) console.log('[console]', m.type(), m.text()); });
  await page.waitForLoadState('load');
  const open = async (id: string) => {
    await page.goto(`${url}/?manifest=${encodeURIComponent(JSON.stringify(manifests[id]))}&n=${Date.now()}`);
    await page.waitForLoadState('load');
  };
  const frameOf = (id: string) => page.frames().find(f => f.url().startsWith(`flux-module://${id}/`));
  const waitReady = async (id: string, ms = 30000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const f = frameOf(id);
      if (f && await f.evaluate(() => document.body.dataset.ready === '1').catch(() => false)) return f;
      await page.waitForTimeout(200);
    }
    throw new Error(`кадр ${id} не дошёл до готовности; сейчас: ${frameOf(id)?.url()}`);
  };
  // tsx кладёт в сериализуемые функции __name; в кадре его нет
  const ev = async (f: NonNullable<ReturnType<typeof frameOf>>, fn: any, arg?: unknown): Promise<any> => { await f.evaluate('globalThis.__name = (fn) => fn'); return f.evaluate(fn, arg); };
  const stateFile = (id: string, scope = 'released') => path.join(storageDir, userDirName(USER), id, scope, 'state.json');
  const get = (f: NonNullable<ReturnType<typeof frameOf>>) => ev(f, () => flux.state.get());
  const set = (f: NonNullable<ReturnType<typeof frameOf>>, state: unknown) => ev(f, (s: unknown) => flux.state.set(s as Record<string, unknown>).then(() => 'ok', (e: any) => e.code), state);
  const invoke = (channel: string, payload: unknown) => page.evaluate(([c, p]) => (window as any).electron.ipcRenderer.invoke(c as string, p), [channel, payload] as const);
  const big = (bytes: number) => ({ t: 'a'.repeat(bytes - '{"t":""}'.length) });

  try {
    // ── 1. Самостоятельная программа: диск ──
    await open('store-notes');
    let notes = await waitReady('store-notes');
    check('состояния ещё нет — пустой объект', Object.keys(await get(notes)).length === 0);
    check('сохранение проходит', await set(notes, { n: 1, text: 'Заметка' }) === 'ok');
    const saved = JSON.parse(fs.readFileSync(stateFile('store-notes'), 'utf8'));
    check('файл лежит в <данные>/program-data/<человек>/<программа>/released/state.json', saved.format === 1 && saved.program === 'store-notes' && saved.state.n === 1);
    check('в имени папки нет идентификатора человека, только его хеш', !stateFile('store-notes').includes(`${path.sep}${USER}${path.sep}`) && /^[0-9a-f]{32}$/.test(userDirName(USER)));
    check('в конверте версия записавшего и время', typeof saved.writtenBy === 'string' && !Number.isNaN(Date.parse(saved.savedAt)));
    check('временных файлов рядом нет', fs.readdirSync(path.dirname(stateFile('store-notes'))).join() === 'state.json');
    await open('store-notes');
    notes = await waitReady('store-notes');
    check('после перезагрузки окна (память окна потеряна) состояние читается с диска', (await get(notes)).text === 'Заметка');

    // ── 2. Предел 1 МиБ через настоящий postMessage и IPC ──
    check('ровно 1 МиБ сохраняется', await set(notes, big(MIB)) === 'ok' && fs.statSync(stateFile('store-notes')).size > MIB);
    check('на байт больше — LIMIT', await set(notes, big(MIB + 1)) === 'LIMIT');
    check('после отказа прежнее состояние цело (1 МиБ)', ((await get(notes)).t as string).length === MIB - '{"t":""}'.length);
    check('после отказа рядом нет временных файлов', fs.readdirSync(path.dirname(stateFile('store-notes'))).join() === 'state.json');
    check('сохранение не-объекта отвергнуто схемой моста, а не молча принято', await ev(notes, () => (flux.state.set as any)([1]).then(() => 'ok', (e: any) => e.code)) !== 'ok');
    await set(notes, { n: 2 });

    // ── 3. Программа, читающая данные Flux: только память окна ──
    await open('store-reader');
    let reader = await waitReady('store-reader');
    check('читающая программа сохраняет в память окна', await set(reader, { secret: 'данные проекта' }) === 'ok' && (await get(reader)).secret === 'данные проекта');
    check('на диск ничего не попало: нет папки программы', !fs.existsSync(path.join(storageDir, userDirName(USER), 'store-reader')));
    check('у читающей программы прежний предел 256 КиБ', await set(reader, big(256 * 1024 + 1)) === 'LIMIT' && await set(reader, big(256 * 1024)) === 'ok');
    await open('store-reader');
    reader = await waitReady('store-reader');
    check('после перезагрузки окна состояния нет (память, как раньше)', Object.keys(await get(reader)).length === 0);

    // ── 4. Повреждённый файл не затирается ──
    await open('store-twin');
    const twin = await waitReady('store-twin');
    await set(twin, { keep: 'меня' });
    fs.writeFileSync(stateFile('store-twin'), '{"format":1,"program":"store-twin","state":{"keep"');
    await open('store-twin');
    const twin2 = await waitReady('store-twin');
    check('повреждённый файл: программа получает пустое состояние', Object.keys(await get(twin2)).length === 0);
    const dir = path.dirname(stateFile('store-twin'));
    const brokenName = fs.readdirSync(dir).find(n => n.startsWith('state.broken-'));
    check('сам файл отложен рядом, байт в байт', !!brokenName && fs.readFileSync(path.join(dir, brokenName!), 'utf8') === '{"format":1,"program":"store-twin","state":{"keep"');
    check('после новой записи есть и новое состояние, и отложенный файл', await set(twin2, { fresh: 1 }) === 'ok' && (await get(twin2)).fresh === 1 && fs.readdirSync(dir).length === 2);

    // ── 5. Очистка по IPC: только своя область и точный путь ──
    const before = fs.readdirSync(path.join(storageDir, userDirName(USER))).sort().join();
    check('область studio окну Flux не принадлежит — отказ', (await invoke('modules:state-clear', { moduleId: 'store-notes', scope: 'studio' })).ok === false);
    check('неизвестная область — отказ', (await invoke('modules:state-clear', { moduleId: 'store-notes', scope: 'all' })).ok === false && (await invoke('modules:state-clear', { moduleId: 'store-notes' })).ok === false);
    for (const bad of ['..', '../store-twin', 'store-notes/..', '', 'Store-Notes']) {
      check(`негодный идентификатор «${bad}» — отказ`, (await invoke('modules:state-clear', { moduleId: bad, scope: 'released' })).ok === false);
    }
    check('после отказов ничего не удалено', fs.readdirSync(path.join(storageDir, userDirName(USER))).sort().join() === before && fs.existsSync(stateFile('store-notes')) && fs.existsSync(stateFile('store-twin')));
    check('объём области по IPC', typeof (await invoke('modules:state-usage', { moduleId: 'store-notes', scope: 'released' })).bytes === 'number');
    const cleared = await invoke('modules:state-clear', { moduleId: 'store-notes', scope: 'released' });
    check('очистка released: папка программы удалена', cleared.ok === true && cleared.removed === true && !fs.existsSync(path.join(storageDir, userDirName(USER), 'store-notes')));
    check('другая самостоятельная программа и её отложенный файл целы', fs.existsSync(stateFile('store-twin')) && fs.readdirSync(path.dirname(stateFile('store-twin'))).length === 2);
    await open('store-notes');
    notes = await waitReady('store-notes');
    check('после удаления программа начинает с пустого состояния', Object.keys(await get(notes)).length === 0);

    check(`без ошибок исполнения окна Flux: ${JSON.stringify(errors)}`, errors.length === 0);
    console.log(`\n${passed} проверок пройдено.`);
  } finally {
    await electron.close(); server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
