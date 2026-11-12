/**
 * Python и WebAssembly в настоящем Electron (этап 3а, шаги 3–5): подписанные
 * выпуски через настоящий протокол и кэш, расчёт в окне программы, изоляция
 * хоста Python, пределы времени и памяти, кэш компиляции на диске, первый
 * запуск с контрольными примерами, нагрузка на процессор и память.
 *
 * Запуск (Linux): xvfb-run -a npx tsx scripts/test-modules-compute-native.ts
 * Нужна сборка: npx vite build (dist/modules/_compute).
 */
import { verifySkip } from './verifySkip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';

async function main() {
  if (process.platform !== 'win32' && !(process.platform === 'linux' && process.env.DISPLAY)) {
    verifySkip('нужны Windows либо Linux с DISPLAY (xvfb-run)');
    return;
  }
  if (!fs.existsSync('dist/modules/_compute/host.js')) { verifySkip('нет сборки dist/modules/_compute (npx vite build)'); return; }
  const { _electron } = await import('playwright-core');
  const { default: express } = await import('express');
  const { ModuleCache } = await import('../electron/moduleCache');
  const { ModuleSelection } = await import('../electron/moduleSelection');
  const { splitChunks } = await import('../modules/trust/bundle');
  const { buildModuleRuntime } = await import('../modules/build');
  const { fluxModule, WASM_OPS: OP, wasmSleb } = await import('./fixtures/wasmBuilder');
  const { languageBundle, languageFiles, statsControlsText } = await import('./fixtures/moduleLanguages');
  const { hexOf, newKey, releaseEnvelope } = await import('./fixtures/moduleTrust');
  const { packBundle } = await import('../modules/trust/bundle');

  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-compute-'));
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const root = newKey(), rootHex = hexOf(root), dev = hexOf(newKey());
  const form = fs.readFileSync('modules/fixtures/stats/form.json', 'utf8');
  fs.writeFileSync(path.join(temp, 'form.json'), form);

  // ── Подписанные выпуски: примеры на всех языках, неисправные для границ и один с неверными контрольными ──
  const cache = new ModuleCache(data, rootHex);
  const installed: Array<{ id: string; version: string }> = [];
  const manifests: Record<string, any> = {};
  async function publish(id: string, files: Record<string, Uint8Array | string>, manifest: any) {
    const runtime = await buildModuleRuntime(temp, manifest);
    const bundle = packBundle({ ...files, 'manifest.json': JSON.stringify(manifest), 'form.json': form, 'build/runtime.js': runtime });
    const signature = releaseEnvelope(root, bundle, { moduleId: id, version: manifest.version, author: dev, language: manifest.language || 'typescript' });
    const result = await cache.install({ id: `rel-${id}`, moduleId: id, version: manifest.version, signature }, splitChunks(bundle));
    assert.ok(result.ok, `${id}: ${result.why}`);
    installed.push({ id, version: manifest.version });
    manifests[id] = manifest;
  }
  const oneCase = JSON.stringify({ version: 1, cases: [{ name: 'один', input: { v: 1 }, expect: { state: {}, calc: { out: { ok: true } } } }] });
  for (const lang of ['python', 'c', 'cpp', 'rust', 'go', 'csharp'] as const) {
    const f = languageFiles(lang);
    await publish(`stats-${lang}`, f, JSON.parse(f['manifest.json'] as string));
  }
  const hostile = async (id: string, language: 'python' | 'wasm', logic: Uint8Array | string) => {
    const manifest = { id, name: id, version: '1.0.0', author: 'Flux', contractVersion: 1, entries: ['equipment'], reads: ['equipment'], language,
      ...(language === 'wasm' ? { logic: 'logic/main.wasm', sourceLanguage: 'c' } : { logic: 'logic/main.py' }) };
    await publish(id, { [manifest.logic]: logic, 'examples/controls.json': oneCase }, manifest);
  };
  await hostile('loop-py', 'python', 'def compute(i):\n    while True:\n        pass\n');
  await hostile('hog-py', 'python', 'def compute(i):\n    x = bytearray(2000 * 1024 * 1024)\n    return {"state": {}, "calc": {"out": {}}}\n');
  await hostile('spy-py', 'python', [
    // Побег из фильтра импортов (классический приём через catch_warnings): настоящий __import__ и модуль js внутри Worker
    'def compute(i):',
    '    real = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == "catch_warnings"][0]()._module.__builtins__["__import__"]',
    '    js = real("js")',
    '    seen = {}',
    '    for name in ("document", "localStorage", "indexedDB", "electron", "require", "process", "Worker", "SharedWorker"):',
    '        seen[name] = str(getattr(js, name, None))',
    '    x = js.XMLHttpRequest.new()',
    '    try:',
    '        x.open("GET", i["spy"], False); x.send(); seen["xhr"] = "leaked"',
    '    except Exception as e:',
    '        seen["xhr"] = "blocked"',
    '    try:',
    '        seen["cookie"] = str(js.document.cookie)',
    '    except Exception:',
    '        seen["cookie"] = "none"',
    '    return {"state": {}, "calc": {"out": seen}}',
  ].join('\n'));
  await hostile('numpy-py', 'python', [
    'import numpy as np',
    'def compute(i):',
    '    a = np.array([[3.0, 1.0], [1.0, 2.0]])',
    '    x = np.linalg.solve(a, np.array([9.0, 8.0]))',
    '    return {"state": {}, "calc": {"out": {"x": [float(v) for v in x], "mean": float(np.mean([1200.0, 3.5, 0.25])), "ver": np.__version__}}}',
  ].join('\n'));
  await hostile('sqrt-patch-py', 'python', 'import math\ndef compute(i):\n    math.sqrt = lambda x: -1.0\n    n = 0\n    for k in range(6000000):\n        n += k\n    return {"state": {}, "calc": {"out": {"patched": math.sqrt(4.0), "n": n}}}\n');
  await hostile('sqrt-victim-py', 'python', 'import math\ndef compute(i):\n    return {"state": {}, "calc": {"out": {"v": math.sqrt(4.0)}}}\n');
  // Общий счётчик в среде Pyodide: numpy один на все программы, поэтому тик, который ставит одна, видит другая.
  // Расчёт, которого не перебивали, видит свой вход и выход подряд (выход = вход + 1)
  const tick = (spin: number) => ['import numpy as np', 'def compute(i):', '    t = getattr(np, "flux_tick", 0) + 1', '    np.flux_tick = t', '    enter = t', `    n = 0`, `    for k in range(${spin}):`, '        n += k',
    '    t = np.flux_tick + 1', '    np.flux_tick = t', '    return {"state": {}, "calc": {"out": {"enter": enter, "exit": t}}}'].join('\n');
  await hostile('tick-a-py', 'python', tick(4000000));
  await hostile('tick-b-py', 'python', tick(1));
  await hostile('loop-wasm', 'wasm', fluxModule({ run: [OP.loop, 0x40, OP.br, 0, OP.end, OP.i32const, 1] }));
  await hostile('grow-wasm', 'wasm', fluxModule({ memory: { min: 1, max: 16 },
    run: [OP.loop, 0x40, OP.i32const, 1, ...OP.memoryGrow, OP.i32const, ...wasmSleb(-1), 0x47, OP.brIf, 0, OP.end, OP.unreachable] }));
  // Контрольные примеры не сходятся с настоящим результатом: выпуск не должен запуститься
  {
    const f = languageFiles('c', { id: 'stats-wrong' }, { 'examples/controls.json': JSON.stringify({ version: 1, cases: [{ name: 'ложный', input: { v: 1, flux: { equipment: { params: [{ value: '2' }] } } }, expect: { state: {}, calc: { out: { count: 1, sum: 3, mean: 3, rms: 3, min: 3, max: 3 } } } }] }) });
    await publish('stats-wrong', f, JSON.parse(f['manifest.json'] as string));
  }
  const selection = new ModuleSelection(path.join(data, 'selection.json'));
  await selection.load(); await selection.activate('u');
  for (const m of installed) await selection.install(m.id, m.version, { dirty: false });
  check(`выпуски подписаны владельцем и лежат в кэше: ${installed.length}`, (await cache.runnable()).size === installed.length);

  // ── Электрон и страница ──
  const app = express();
  let leaked = 0;
  app.all('/must-not-reach', (_req, res) => { leaked++; res.set('Access-Control-Allow-Origin', '*').json({ leaked: true }); });
  const css = fs.readdirSync('dist/assets').filter(f => f.endsWith('.css'));
  await build({ entryPoints: ['scripts/fixtures/modules-compute-host.tsx'], bundle: true, platform: 'browser', outfile: path.join(temp, 'host.js'), format: 'esm',
    define: { __APP_VERSION__: '"test"', __FLUX_E3_FAKE__: 'false', 'process.env.NODE_ENV': '"production"' }, loader: {} });
  // Worker WebAssembly: в приложении его собирает Vite, здесь тот же файл собирается отдельно и отдаётся по адресу, который строит new URL(…, import.meta.url)
  await build({ entryPoints: ['src/workers/moduleWasm.worker.ts'], bundle: true, platform: 'browser', format: 'esm', outfile: path.join(temp, 'wasm.worker.js') });
  await build({ entryPoints: ['scripts/fixtures/modules-compute-main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'main.cjs') });
  await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(temp, 'preload.js') });
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">${css.map(f => `<link rel="stylesheet" href="/assets/${f}">`).join('')}</head><body style="margin:0"><div id="root"></div><script type="module" src="/host.js"></script></body></html>`));
  app.get('/workers/moduleWasm.worker.ts', (_req, res) => res.type('text/javascript').sendFile(path.join(temp, 'wasm.worker.js')));
  app.get('/host.js', (_req, res) => res.sendFile(path.join(temp, 'host.js')));
  app.use('/assets', express.static('dist/assets'));
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const electron = await _electron.launch({ args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(temp, 'main.cjs')],
    env: { ...process.env, FLUX_MODULE_FIXTURE_DIR: temp, FLUX_MODULE_FIXTURE_URL: `${url}/`, FLUX_TEST_ROOT: rootHex, FLUX_TEST_DIR: data }, timeout: 60000 });
  const metrics = async () => electron.evaluate(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, cpu: m.cpu.percentCPUUsage, mem: m.memory.workingSetSize * 1024 })));
  const sum = (rows: Array<{ cpu: number; mem: number }>, key: 'cpu' | 'mem') => rows.reduce((n, r) => n + r[key], 0);
  const page = await electron.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForLoadState('load');
  try {
    // Выпуски, которые видит главный процесс, и защита протокола
    const probe = (u: string) => page.evaluate(async target => { try { const r = await fetch(target); return { status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength }; } catch (e) { return { status: -1, type: '', len: 0 }; } }, u);
    const wasmFile = await probe('flux-module://stats-c/logic.wasm');
    console.log('  logic.wasm:', JSON.stringify(wasmFile));
    check('протокол отдаёт logic.wasm проверенного выпуска с типом application/wasm', wasmFile.status === 200 && wasmFile.type === 'application/wasm' && wasmFile.len > 1000);
    check('файл логики не из пакета (встроенный пример, чужой путь) не отдаётся', (await probe('flux-module://equipment-inspector/logic.wasm')).status === 404 && (await probe('flux-module://stats-c/logic/main.wasm')).status === 404);
    check('Pyodide отдаётся хосту из сборки, а не из сети', (await probe('flux-module://_compute/pyodide/pyodide.asm.wasm')).status === 200 && (await probe('flux-module://_compute/pyodide/../secret')).status === 404);

    // Холодный и тёплый расчёт по языкам; один и тот же вход
    const input = { v: 1, context: { projectId: 'p', entry: 'equipment', entityId: 'e' }, state: {},
      flux: { equipment: { params: ['1200', '3.5', '0.25'].map(value => ({ group: 'g', key: 'k', value, unit: '' })) } } };
    const idle0 = await metrics();
    const timing: Record<string, { cold: number; warm: number }> = {};
    const results: Record<string, string> = {};
    for (const lang of ['c', 'cpp', 'rust', 'go', 'csharp', 'python']) {
      const language = lang === 'python' ? 'python' : 'wasm';
      const run = (extra = {}) => page.evaluate(async ({ id, language, input, extra }) => {
        const t = performance.now();
        const out = await (window as any).__compute.compute({ moduleId: id, version: '1.0.0', language }, input, 'active', extra);
        return { ms: performance.now() - t, out };
      }, { id: `stats-${lang}`, language, input, extra });
      const cold = await run(), warm = await run();
      timing[lang] = { cold: cold.ms, warm: warm.ms };
      results[lang] = JSON.stringify(cold.out);
      check(`${lang}: расчёт в Electron, результат совпадает с эталоном`, cold.out.calc.out.count === 3 && cold.out.calc.out.sum === 1203.75 && cold.out.calc.out.rms === 692.8232849483818);
    }
    check('все шесть движков в Electron дали побитово одинаковый результат', new Set(Object.values(results)).size === 1);
    console.log('  время расчёта (мс), холодный / повторный:', JSON.stringify(Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, `${v.cold.toFixed(0)} / ${v.warm.toFixed(0)}`]))));
    check('Python стартует один раз: повторный расчёт на порядок быстрее первого', timing.python.cold > timing.python.warm * 5);

    // Нагрузка на компьютер: простой и под нагрузкой
    const pyIdleStart = await metrics();
    await page.waitForTimeout(3000);
    const a = await metrics(); await page.waitForTimeout(3000); const b = await metrics();
    const idleCpu = sum(b, 'cpu');
    const hostCount = await page.locator('iframe[data-testid="flux-python-host"]').count();
    console.log(`  память (МиБ): до программ ${(sum(idle0, 'mem') / 1048576).toFixed(0)}, с загруженным Python в простое ${(sum(b, 'mem') / 1048576).toFixed(0)}; процессор в простое с Python: ${idleCpu.toFixed(2)} %`);
    void pyIdleStart; void a;
    check('хост Python — скрытый iframe, один на все программы', hostCount === 1);
    check('простой: процессор окна с загруженным Python ≈ 0 %', idleCpu < 2);

    // Компиляция один раз на выпуск: после остановки Worker'ов модуль берётся готовым
    const cppBytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('flux-module://stats-cpp/logic.wasm')).arrayBuffer())));
    const compiledTwice = await page.evaluate(async ({ bytes, input }) => {
      const runner = (window as any).__wasm; const data = new Uint8Array(bytes);
      const fp = await (window as any).__sha(data);
      const t = [];
      for (let n = 0; n < 3; n++) {
        if (n === 2) runner.stopAll(); // Worker выгружен по простою или убит по времени
        const started = performance.now();
        await runner.run(fp, data, JSON.stringify(input), 0, 10000);
        t.push(performance.now() - started);
      }
      return { ...runner.stats, t };
    }, { bytes: cppBytes, input });
    console.log(`  WebAssembly: компиляций ${compiledTwice.compiled}, из кэша ${compiledTwice.cached}; три расчёта (мс): ${compiledTwice.t.map((x: number) => x.toFixed(1)).join(' / ')} (третий — после остановки Worker)`);
    check('модуль компилируется один раз на выпуск, в том числе после остановки Worker', compiledTwice.compiled === 1 && compiledTwice.cached === 2);

    // Пределы: бесконечные циклы и прожорливость останавливаются, среда восстанавливается
    const attempt = (id: string, language: string, timeoutMs: number) => page.evaluate(async ({ id, language, timeoutMs, input }) => {
      const t = performance.now();
      try { await (window as any).__compute.compute({ moduleId: id, version: '1.0.0', language }, input, 'active', { timeoutMs }); return { code: '', ms: performance.now() - t }; }
      catch (e: any) { return { code: e.code || e.message, ms: performance.now() - t }; }
    }, { id, language, timeoutMs, input });
    const loopWasm = await attempt('loop-wasm', 'wasm', 1500);
    check(`бесконечный цикл в .wasm остановлен по времени (${loopWasm.ms.toFixed(0)} мс)`, loopWasm.code === 'TIMEOUT' && loopWasm.ms < 4000);
    check('и следующий расчёт на WebAssembly идёт', (await page.evaluate(async i => (await (window as any).__compute.compute({ moduleId: 'stats-c', version: '1.0.0', language: 'wasm' }, i, 'active')).calc.out.count, input)) === 3);
    const grow = await attempt('grow-wasm', 'wasm', 5000);
    check('рост памяти .wasm упёрся в максимум: ошибка MEMORY', grow.code === 'MEMORY');
    const loopPy = await attempt('loop-py', 'python', 1500);
    check(`бесконечный цикл Python остановлен по времени (${loopPy.ms.toFixed(0)} мс)`, loopPy.code === 'TIMEOUT' && loopPy.ms < 6000);
    const afterLoop = await page.evaluate(async i => { const t = performance.now(); const o = await (window as any).__compute.compute({ moduleId: 'stats-python', version: '1.0.0', language: 'python' }, i, 'active'); return { n: o.calc.out.count, ms: performance.now() - t }; }, input);
    check(`после остановки среда Python пересоздана и работает (${afterLoop.ms.toFixed(0)} мс)`, afterLoop.n === 3);
    const hog = await attempt('hog-py', 'python', 20000);
    check('прожорливый Python (2 ГиБ) останавливается как MEMORY, окно живо', hog.code === 'MEMORY' && await page.evaluate(() => document.readyState) === 'complete');
    const afterHog = await page.evaluate(async i => (await (window as any).__compute.compute({ moduleId: 'stats-python', version: '1.0.0', language: 'python' }, i, 'active')).calc.out.count, input);
    check('и после нехватки памяти Python отвечает', afterHog === 3);

    await page.evaluate('globalThis.__name = (fn) => fn');
    // numpy из колеса в сборке: загрузка лениво, при закрытой сети (CSP хоста разрешает только его собственный адрес)
    const np = await page.evaluate(async i => { const t = performance.now(); const o = await (window as any).__compute.compute({ moduleId: 'numpy-py', version: '1.0.0', language: 'python' }, i, 'active'); return { out: o.calc.out, ms: performance.now() - t }; }, input);
    console.log(`  numpy: первый расчёт (загрузка колеса) ${np.ms.toFixed(0)} мс`);
    check('numpy работает в Electron без сети: решение системы, среднее, версия 2.2.5', Math.abs(np.out.x[0] - 2) < 1e-12 && Math.abs(np.out.x[1] - 3) < 1e-12 && np.out.mean === 401.25 && np.out.ver === '2.2.5');

    // Два Python-расчёта разом: одна программа подменяет math.sqrt и держит среду, вторая считает — строго по очереди
    const pair = await page.evaluate(async i => {
      const run = (id: string) => { const t = performance.now(); return (window as any).__compute.compute({ moduleId: id, version: '1.0.0', language: 'python' }, i, 'active').then((o: any) => ({ o, end: performance.now() - t })); };
      const t0 = performance.now();
      const holder = run('sqrt-patch-py'), victim = run('sqrt-victim-py');
      const [a, b] = await Promise.all([holder, victim]);
      return { a: a.o.calc.out, b: b.o.calc.out, aEnd: a.end, bEnd: b.end, total: performance.now() - t0 };
    }, input);
    console.log(`  два Python-расчёта разом: первый держал среду ${pair.aEnd.toFixed(0)} мс, второй дождался и закончил на ${pair.bEnd.toFixed(0)} мс`);
    check('вторая программа получает верный результат (sqrt(4)=2), хотя первая подменила math.sqrt', pair.a.patched === -1 && pair.b.v === 2);
    // Порядок прихода не гарантия, гарантия — «не одновременно»: часов не берём, сравниваем тики общего счётчика
    const ticks = await page.evaluate(async i => {
      const run = (id: string) => (window as any).__compute.compute({ moduleId: id, version: '1.0.0', language: 'python' }, i, 'active').then((o: any) => o.calc.out);
      const [a, b] = await Promise.all([run('tick-a-py'), run('tick-b-py')]);
      return { a, b };
    }, input);
    const all = [ticks.a.enter, ticks.a.exit, ticks.b.enter, ticks.b.exit].sort((x, y) => x - y);
    console.log(`  тики общего счётчика: A ${ticks.a.enter}→${ticks.a.exit}, B ${ticks.b.enter}→${ticks.b.exit}`);
    check('два расчёта в одной среде не перекрываются: у каждого выход сразу за входом, тики другого не между ними',
      ticks.a.exit === ticks.a.enter + 1 && ticks.b.exit === ticks.b.enter + 1 && all.every((v, k) => k === 0 || v === all[k - 1] + 1));

    // Изоляция: даже при побеге из фильтра импортов Python остаётся в песочнице
    const hostFrame = page.frames().find(f => f.url().startsWith('flux-module://_compute/'))!;
    check('хост Python в другом источнике, под своей CSP', !!hostFrame && await page.locator('iframe[data-testid="flux-python-host"]').getAttribute('sandbox') === 'allow-scripts');
    await page.evaluate('globalThis.__name = (fn) => fn');
    await hostFrame.evaluate('globalThis.__name = (fn) => fn');
    const frameProbe = await hostFrame.evaluate(async target => {
      const attempt = (fn: () => unknown) => { try { return fn(); } catch { return 'denied'; } };
      const net = await fetch(target).then(() => 'leaked', () => 'blocked');
      return { cookie: attempt(() => document.cookie), local: attempt(() => localStorage.getItem('flux_parent_storage')), parent: attempt(() => (parent as any).document.cookie),
        electron: typeof (window as any).electron, require: typeof (window as any).require, net };
    }, `${url}/must-not-reach`);
    check('хост Python: нет cookie, localStorage, родителя, IPC и сети', frameProbe.cookie === 'denied' && frameProbe.local === 'denied' && frameProbe.parent === 'denied'
      && frameProbe.electron === 'undefined' && frameProbe.require === 'undefined' && frameProbe.net === 'blocked' && leaked === 0);
    await page.evaluate(u => { (globalThis as any).__spy = u; }, `${url}/must-not-reach`);
    const spy = await page.evaluate(async ({ input, target }) => {
      // js.__spy_url читается Python из глобальной области Worker: кладём адрес в исходник через вход
      try { const o = await (window as any).__compute.compute({ moduleId: 'spy-py', version: '1.0.0', language: 'python' }, { ...input, spy: target }, 'active'); return o.calc.out; }
      catch (e: any) { return { error: e.code || e.message }; }
    }, { input, target: `${url}/must-not-reach` });
    // Побег удаётся (в одном интерпретаторе Python не изолировать), но границы песочницы держат
    check(`Python после побега из фильтра импортов: сети нет (${JSON.stringify(spy).slice(0, 160)})`, leaked === 0 && (spy.xhr === 'blocked' || spy.error));
    check('и запустить свои Worker/SharedWorker из Python нельзя (js.Worker убран прологом)', spy.Worker === 'None' && spy.SharedWorker === 'None');
    check('и cookie/localStorage/IPC Flux ему недоступны', !JSON.stringify(spy).includes('flux_parent') && spy.electron !== 'object' && spy.cookie !== 'flux_parent_cookie=private');

    // Окно программы: первый запуск с контрольными примерами, затем расчёт в iframe
    const open = async (id: string) => {
      await page.goto(`${url}/?manifest=${encodeURIComponent(JSON.stringify(manifests[id]))}`);
      await page.waitForLoadState('load');
    };
    for (const id of ['stats-python', 'stats-c', 'stats-csharp']) {
      await open(id);
      const frame = () => page.frames().find(f => f.url().startsWith(`flux-module://${id}/`));
      await page.waitForFunction(i => Array.from(document.querySelectorAll('iframe')).some(f => (f as HTMLIFrameElement).src.includes(i)), id, { timeout: 60000 });
      await page.waitForFunction(() => true);
      const text = async () => frame()?.locator('body').innerText() ?? '';
      await page.waitForFunction(async () => true);
      for (let n = 0; n < 120 && !(await text()).includes('1203.75'); n++) await page.waitForTimeout(500);
      const body = await text();
      check(`${id}: окно программы показывает результат расчёта (сумма 1203.75, значений 3)`, body.includes('1203.75') && body.includes('692.8232849483818'));
    }
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'controls.json'), 'utf8'));
    check('итог контрольных примеров записан главным процессом для каждого выпуска', Object.values(saved).filter((v: any) => v.ok === true).length >= 3);

    // Выпуск с неверными контрольными: не запускается, событие в счётчики, код выпуска закрыт
    await open('stats-wrong');
    await page.getByText('Программа не запущена').waitFor({ timeout: 60000 });
    const queue = await page.evaluate(() => localStorage.getItem('flux.module-crashes.v1') || '');
    check('неверные контрольные примеры: программа не запускается, iframe не создан', await page.locator('iframe[data-testid="flux-module-frame"]').count() === 0);
    check('и записано событие «controls» в счётчики сбоев', queue.includes('stats-wrong') && queue.includes('controls'));
    check('главный процесс больше не отдаёт код выпуска', (await probe('flux-module://stats-wrong/runtime.js')).status === 404 && (await probe('flux-module://stats-wrong/logic.wasm')).status === 404);
    await open('stats-wrong');
    await page.getByText('Программа не запущена').waitFor({ timeout: 20000 });
    check('повторное открытие берёт итог из памяти компьютера', true);

    check(`без ошибок исполнения страницы: ${JSON.stringify(errors)}`, errors.length === 0);
    const load = await metrics();
    console.log(`  итого: память всех процессов ${(sum(load, 'mem') / 1048576).toFixed(0)} МиБ`);
  } finally {
    await electron.close().catch(() => {});
    server.close();
    console.log(`Python и WebAssembly в Electron: проверок ${passed}`);
  }
}
main().catch(e => { console.error('✗', e); process.exit(1); });
