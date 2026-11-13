/**
 * Метод на TypeScript (`flux.programs.call`) в настоящем Chromium: настоящие ModuleCompute и окно-раннер вокруг настоящего
 * изолированного кадра `ts.html` с теми же заголовками (`moduleHeaders` — CSP + sandbox), что отдаёт electron/modules.ts.
 *
 * Что проверено: успех и параллельные вызовы; логика из сборки Flux (esbuild) и из Studio (CommonJS); часы стоят, случайность
 * от зерна; НЕТ состояния между вызовами (переменная модуля и глобальная); пределы — время (Worker завершается), вход, выход, файл;
 * ошибка логики не выдаёт текст; НЕТ СЕТИ — fetch, XHR, WebSocket, EventSource, importScripts, import() наружу «закрыты», а
 * внешний сервер не получил ни одного обращения; нет DOM, хранилищ, вложенных Worker'ов, flux.*.
 * Каждая защита проверена мутацией: с ослабленным заголовком или кодом хоста проверка обязана упасть.
 *
 * Чего здесь нет: протокола `flux-module://` и Electron (адрес кадра подставлен http-сервером с теми же заголовками) —
 * это проверяет test-modules-compute-native на Windows в CI.
 *
 * Запуск: FLUX_CHROME=/путь/к/chrome npx tsx scripts/test-modules-ts-host.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build, type Plugin } from 'esbuild';
import { verifySkip } from './verifySkip';
import { buildModuleLogic, buildTsHostAssets } from '../modules/build';
import { MODULE_CSP, TS_HOST_FILE, moduleAssetPath, moduleHeaders } from '../modules/protocol';
import { assembleLogic } from '../studio/shared/runtime';
import type { ModuleManifest } from '../modules/contract';

let passed = 0, failedCount = 0;
const report = (name: string, condition: unknown) => { if (condition) { passed++; console.log('  ✓', name); } else { failedCount++; console.error('  ✗', name); } };

const MANIFEST = {
  id: 'rates-ts', name: 'Курсы', version: '1.0.0', author: 'Flux', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts', language: 'typescript',
  exports: ['convert', 'counter', 'time', 'spin', 'big', 'throw', 'nothing', 'shape', 'globals', 'net'].map(method => ({ method, does: `Метод ${method} считает значение по входным данным` })),
} as unknown as ModuleManifest;

const LOGIC = `
let calls = 0;
const out = (value: unknown) => ({ state: {}, calc: { out: value } });
async function attempt(fn: () => unknown) {
  try { return 'прошло:' + String(await fn()).slice(0, 40); } catch { return 'закрыто'; }
}
export async function compute(input: any) {
  const g = globalThis as any;
  const data = input.data;
  switch (input.export) {
    case 'convert': return out({ value: Math.round(data.amount * data.rate * 100) / 100 });
    case 'counter': g.__seen = (g.__seen ?? 0) + 1; return out({ module: ++calls, global: g.__seen });
    case 'time': return out({ random: Math.random(), now: Date.now(), made: new Date().getTime(), perf: performance.now() });
    case 'spin': for (;;) { /* бесконечный цикл */ }
    case 'big': return out({ text: 'я'.repeat(300000) });
    case 'throw': throw new Error('СЕКРЕТ-В-ОШИБКЕ ' + JSON.stringify(data));
    case 'nothing': return undefined;
    case 'shape': return { wrong: 1 };
    case 'globals': return out({
      flux: typeof g.flux, parent: typeof g.parent, document: typeof g.document, window: typeof g.window, localStorage: typeof g.localStorage,
      worker: typeof g.Worker, sharedWorker: typeof g.SharedWorker, serviceWorker: typeof g.ServiceWorker,
      indexedDB: await attempt(() => new Promise((res, rej) => { const r = g.indexedDB.open('x'); r.onsuccess = () => res('открыта'); r.onerror = () => rej(new Error('x')); })),
      caches: await attempt(() => g.caches.open('x')),
    });
    case 'net': return out({
      fetch: await attempt(() => g.fetch(data.url + '/fetch').then((r: Response) => r.status)),
      xhr: await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', data.url + '/xhr'); x.onload = () => res(x.status); x.onerror = () => rej(new Error('x')); x.send(); })),
      websocket: await attempt(() => new Promise((res, rej) => { const s = new WebSocket(data.url.replace('http', 'ws') + '/ws'); s.onopen = () => res('open'); s.onerror = () => rej(new Error('x')); s.onclose = () => rej(new Error('c')); })),
      eventsource: await attempt(() => new Promise((res, rej) => { const s = new EventSource(data.url + '/sse'); s.onopen = () => res('open'); s.onerror = () => rej(new Error('x')); })),
      importScripts: await attempt(() => g.importScripts(data.url + '/script.js')),
      dynamicImport: await attempt(() => import(data.url + '/module.js')),
      beacon: await attempt(() => g.navigator.sendBeacon(data.url + '/beacon', 'x')),
    });
    default: return out({ unknown: input.export });
  }
}
`;
const LOGIC_NO_COMPUTE = 'export const other = 1;';
/** Уже собранный файл с синтаксической ошибкой: сборка такое не выпустила бы, но хост обязан пережить любой файл из пакета */
const LOGIC_SYNTAX = 'globalThis.__fluxLogic = { compute( {{{';

async function main() {
  const chrome = process.env.FLUX_CHROME || '/usr/bin/chromium';
  if (!fs.existsSync(chrome)) {
    // В CI тихий пропуск недопустим: без живого кадра вся проверка изоляции была бы пустой
    if (process.env.CI) { failedCount++; console.error(`  ✗ в CI нет Chromium (${chrome}): живая проверка изоляции не выполнена`); return; }
    verifySkip('нет Chromium (FLUX_CHROME)'); return;
  }
  const { chromium } = await import('playwright-core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-ts-host-'));
  fs.mkdirSync(path.join(dir, 'logic'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logic/main.ts'), LOGIC);
  const fluxBuilt = await buildModuleLogic(dir, MANIFEST);
  fs.writeFileSync(path.join(dir, 'logic/main.ts'), LOGIC_NO_COMPUTE);
  const noComputeBuilt = await buildModuleLogic(dir, MANIFEST);
  fs.writeFileSync(path.join(dir, 'logic/main.ts'), LOGIC);
  const studioBuilt = assembleLogic(MANIFEST, { 'logic/main.ts': new TextEncoder().encode(LOGIC) } as never);

  console.log('1. Сборка: файл логики и заголовки хоста');
  report('сборка Flux (esbuild) кладёт функции логики в globalThis.__fluxLogic', /globalThis\.__fluxLogic\s*=/.test(fluxBuilt) && fluxBuilt.length < 20_000);
  report('сборка Studio (CommonJS) даёт тот же договор без ошибок', studioBuilt.problem === '' && /^globalThis\.__fluxLogic=/.test(studioBuilt.logic));
  report('сборка не нужна без exports: пустой ответ', assembleLogic({ ...MANIFEST, exports: undefined } as never, { 'logic/main.ts': new TextEncoder().encode(LOGIC) } as never).logic === '');
  report('страница и скрипт хоста TypeScript отдаются по общему адресу _compute', !!moduleAssetPath('flux-module://_compute/ts.html', ['_compute']) && !!moduleAssetPath('flux-module://_compute/ts-host.js', ['_compute']));
  report('TS_HOST_FILE узнаёт только свои два файла', TS_HOST_FILE.test('ts.html') && TS_HOST_FILE.test('ts-host.js') && !['index.html', 'host.js', 'ts.htm', 'pyodide/ts.html'].some(f => TS_HOST_FILE.test(f)));
  report('CSP хоста TypeScript: connect-src none, без wasm-unsafe-eval, sandbox', /connect-src 'none'/.test(MODULE_CSP) && !/wasm-unsafe-eval/.test(MODULE_CSP) && /sandbox allow-scripts/.test(MODULE_CSP)
    && moduleHeaders('text/html', false)['Content-Security-Policy'] === MODULE_CSP);
  const electron = fs.readFileSync('electron/modules.ts', 'utf8');
  report('electron/modules.ts отдаёт файлы хоста TypeScript со строгим CSP, а хост Python — с COMPUTE_CSP', electron.includes('moduleHeaders(contentType(asset.file), !TS_HOST_FILE.test(asset.file))'));

  const harness = (await build({ entryPoints: ['scripts/fixtures/ts-host-harness.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0].text;
  const real = await buildTsHostAssets();
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });

  /** Один полный прогон: свой внешний сервер-ловушка, своя страница, свои заголовки CSP и своя сборка хоста */
  async function battery(csp: string, assets: Record<string, string>) {
    const results: Array<[string, boolean]> = [];
    const check = (name: string, condition: unknown) => { results.push([name, !!condition]); };
    const leaks: string[] = [];
    const outside = http.createServer((req, res) => {
      leaks.push(req.url || '');
      const type = /module\.js/.test(req.url || '') ? 'text/javascript' : /script\.js/.test(req.url || '') ? 'text/javascript' : /sse/.test(req.url || '') ? 'text/event-stream' : 'text/plain';
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': type });
      res.end(/module\.js/.test(req.url || '') ? 'export default 1' : /script\.js/.test(req.url || '') ? 'self.__canary = 1' : 'x');
    });
    outside.on('upgrade', (req, socket) => { leaks.push(req.url || ''); socket.destroy(); });
    await new Promise<void>(r => outside.listen(0, '127.0.0.1', r));
    const server = http.createServer((req, res) => {
      const file = (req.url || '/').split('?')[0];
      if (file === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta charset="utf-8"><body><script>${harness}</script>`); return; }
      const name = file.replace(/^\/_compute\//, '');
      if (file.startsWith('/_compute/') && assets[name] !== undefined) {
        res.writeHead(200, { ...moduleHeaders(name.endsWith('.js') ? 'text/javascript' : 'text/html', false), 'Content-Security-Policy': csp }); res.end(assets[name]); return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const canary = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    const context = await browser.newContext();
    const tab = await context.newPage();
    try {
      await tab.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const call = (id: string, input: unknown, timeoutMs?: number) => tab.evaluate(([i, x, t]) => (window as any).__h.call(i, x, t), [id, input, timeoutMs] as const);
      const setLogic = (id: string, text: string) => tab.evaluate(([i, t]) => (window as any).__h.setLogic(i, t), [id, text] as const);
      await setLogic('rates-ts', fluxBuilt);
      await setLogic('rates-studio', studioBuilt.logic);
      await setLogic('no-compute', noComputeBuilt);
      await setLogic('syntax', LOGIC_SYNTAX);
      const out = (r: any) => r?.ok ? r.output.calc.out : null;

      // Успех
      let r: any = await call('rates-ts', { export: 'convert', data: { amount: 100, rate: 0.9 } });
      check('успех: метод считает и отвечает calc.out', r.ok && out(r).value === 90);
      r = await call('rates-studio', { export: 'convert', data: { amount: 2, rate: 3 } });
      check('логика из сборки Studio (CommonJS) исполняется тем же хостом', r.ok && out(r).value === 6);
      const many = await Promise.all([1, 2, 3, 4, 5, 6].map(n => call('rates-ts', { export: 'convert', data: { amount: n, rate: 2 } })));
      check('шесть вызовов одновременно: каждый получает свой ответ', many.every((m: any, i: number) => m.ok && out(m).value === (i + 1) * 2));

      // Детерминизм
      const t1: any = await call('rates-ts', { export: 'time', data: {} }), t2: any = await call('rates-ts', { export: 'time', data: {} });
      check('часы стоят: Date.now() и new Date() — 0, performance.now() — 0', t1.ok && out(t1).now === 0 && out(t1).made === 0 && out(t1).perf === 0);
      check('случайность только от зерна: тот же вход — то же число', t1.ok && t2.ok && out(t1).random === out(t2).random && out(t1).random >= 0 && out(t1).random < 1);

      // Нет состояния
      const c1: any = await call('rates-ts', { export: 'counter', data: {} }), c2: any = await call('rates-ts', { export: 'counter', data: {} });
      check('нет состояния между вызовами: переменная модуля и глобальная начинаются заново', c1.ok && c2.ok && out(c1).module === 1 && out(c2).module === 1 && out(c1).global === 1 && out(c2).global === 1);

      // Пределы
      const spin: any = await call('rates-ts', { export: 'spin', data: {} }, 400);
      check('время: бесконечный цикл остановлен TIMEOUT в пределах предела', !spin.ok && spin.code === 'TIMEOUT' && spin.ms >= 350 && spin.ms < 1800);
      const after: any = await call('rates-ts', { export: 'convert', data: { amount: 1, rate: 5 } });
      check('после остановки хост жив: следующий вызов работает', after.ok && out(after).value === 5);
      const failures: string[] = await tab.evaluate(() => (window as any).__h.failures());
      check('остановка по времени записана в счётчик сбоев видом, а не текстом', failures.includes('rates-ts@1.0.0:timeout'));
      const big: any = await call('rates-ts', { export: 'big', data: {} });
      check('выход: больше 256 КиБ — BAD_OUTPUT', !big.ok && big.code === 'BAD_OUTPUT');
      const huge: any = await call('rates-ts', { export: 'convert', data: { text: 'я'.repeat(600_000) } });
      check('вход: больше 1 МиБ — BAD_INPUT, расчёт не запускался', !huge.ok && huge.code === 'BAD_INPUT');
      await setLogic('huge-file', `${fluxBuilt}\n/*${'x'.repeat(1024 * 1024)}*/`);
      const hugeFile: any = await call('huge-file', { export: 'convert', data: { amount: 1, rate: 1 } });
      check('файл логики больше 1 МиБ — ABI на стороне окна', !hugeFile.ok && hugeFile.code === 'ABI');
      const direct1: any = await tab.evaluate((s) => (window as any).__h.direct(s, '{}'), `/*${'x'.repeat(1024 * 1024 + 10)}*/`);
      check('хост сам не берёт файл логики больше 1 МиБ (BAD_INPUT)', !direct1.ok && direct1.code === 'BAD_INPUT');
      const direct2: any = await tab.evaluate((s) => (window as any).__h.direct('globalThis.__fluxLogic={compute(){return {}}}', s), `{"a":"${'x'.repeat(1024 * 1024 + 10)}"}`);
      check('хост сам не берёт вход больше 1 МиБ (BAD_INPUT)', !direct2.ok && direct2.code === 'BAD_INPUT');

      // Ошибки логики
      const thrown: any = await call('rates-ts', { export: 'throw', data: { имя: 'ДАННЫЕ-ВЫЗОВА' } });
      check('ошибка логики — CRASH, а текст ошибки и данные вызова наружу не идут', !thrown.ok && thrown.code === 'CRASH' && !/СЕКРЕТ|ДАННЫЕ-ВЫЗОВА/.test(thrown.message));
      const nothing: any = await call('rates-ts', { export: 'nothing', data: {} });
      check('compute ничего не вернула — BAD_OUTPUT', !nothing.ok && nothing.code === 'BAD_OUTPUT');
      const shape: any = await call('rates-ts', { export: 'shape', data: {} });
      check('ответ не по схеме договора — BAD_OUTPUT', !shape.ok && shape.code === 'BAD_OUTPUT');
      const noCompute: any = await call('no-compute', { export: 'convert', data: {} });
      check('в логике нет compute — ABI', !noCompute.ok && noCompute.code === 'ABI');
      const syntax: any = await call('syntax', { export: 'convert', data: {} });
      check('файл логики с синтаксической ошибкой — не успех', !syntax.ok);

      // Нет DOM, хранилищ, вложенных Worker'ов, flux.*
      const globals: any = await call('rates-ts', { export: 'globals', data: {} });
      const g = out(globals);
      check('нет flux, parent, document, window, localStorage', globals.ok && ['flux', 'parent', 'document', 'window', 'localStorage'].every(k => g[k] === 'undefined'));
      check('вложенные Worker, SharedWorker и ServiceWorker закрыты прологом', globals.ok && g.worker === 'undefined' && g.sharedWorker === 'undefined' && g.serviceWorker === 'undefined');
      check('IndexedDB и Cache API в кадре без источника не открываются', globals.ok && g.indexedDB === 'закрыто' && g.caches === 'закрыто');

      // Нет сети
      const net: any = await call('rates-ts', { export: 'net', data: { url: canary } }, 12_000);
      const attempts = out(net);
      for (const kind of ['fetch', 'xhr', 'websocket', 'eventsource', 'importScripts', 'dynamicImport']) check(`сеть закрыта: ${kind}`, net.ok && attempts[kind] === 'закрыто');
      check('внешний сервер не получил ни одного обращения (HTTP и WebSocket)', leaks.length === 0);

      // Кадр один и выгружается
      check('кадр хоста один на все вызовы', (await tab.evaluate(() => (window as any).__h.frames())) === 1);
      await tab.evaluate(() => (window as any).__h.dispose());
      check('закрытие окна убирает кадр хоста', (await tab.evaluate(() => (window as any).__h.frames())) === 0);
    } finally { await context.close(); outside.close(); server.close(); }
    return { results, leaks };
  }

  console.log('2. Настоящий кадр, настоящий Worker, настоящая CSP');
  const run = await battery(MODULE_CSP, real);
  for (const [name, ok] of run.results) report(name, ok);

  console.log('3. Мутации: ослабленная защита обязана быть замечена');
  const swap = (file: string, from: string, to: string, ...more: string[]): Plugin => ({
    name: 'mutant', setup(b) {
      b.onLoad({ filter: new RegExp(`${file.replace(/\./g, '\\.')}$`) }, args => {
        // На Windows git отдаёт файлы с CRLF: многострочный фрагмент мутации иначе не находится
        let source = fs.readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
        for (const [x, y] of [[from, to], ...(more.length ? [[more[0], more[1]]] : [])]) {
          if (!source.includes(x)) throw new Error(`мутант: в ${file} нет фрагмента «${x}»`);
          source = source.replace(x, y);
        }
        return { contents: source, loader: 'ts' };
      });
    },
  });
  const mutants: Array<{ name: string; csp?: string; plugin?: Plugin; leaks?: boolean }> = [
    { name: 'CSP без запрета сети (connect-src, script-src, default-src открыты)', csp: MODULE_CSP.replace("connect-src 'none'", 'connect-src *').replace("script-src 'self'", 'script-src *').replace("default-src 'none'", 'default-src *'), leaks: true },
    { name: 'хост не останавливает Worker по времени', plugin: swap('tsHostFrame.ts', "setTimeout(() => settle(id, { ok: false, code: 'TIMEOUT' }), timeoutMs)", 'setTimeout(() => {}, timeoutMs)') },
    { name: 'пролог не закрывает вложенные Worker', plugin: swap('prologue.ts', "['Worker', 'SharedWorker', 'ServiceWorker']", '[]') },
    { name: 'часы идут (Date.now() настоящее)', plugin: swap('deterministic.ts', 'static now() { return 0; }', 'static now() { return RealDate.now(); }') },
    { name: 'текст ошибки логики уходит наружу', plugin: swap('tsWorker.ts', "  } catch {\n    // Текст ошибки логики наружу не идёт: в нём могут быть данные вызова\n    post({ id, type: 'failed', code: 'CRASH' });", "  } catch (error) {\n    post({ id, type: 'failed', code: 'CRASH', detail: String((error as Error).message) });") },
    { name: 'Worker живёт между вызовами (удачно закончивший остаётся для следующего)', plugin: swap('tsHostFrame.ts', 'const worker = new Worker(blob);', 'const worker: Worker = (globalThis as any).__keep ?? new Worker(blob); (globalThis as any).__keep = null;', '  item.worker.terminate();\n', '  if (message.ok) (globalThis as any).__keep = item.worker; else item.worker.terminate();\n') },
    { name: 'хост принимает файл логики любого размера', plugin: swap('tsHostFrame.ts', 'data.source.length > LIMITS.tsFileBytes ||', '') },
    { name: 'хост принимает вход любого размера', plugin: swap('tsHostFrame.ts', '|| data.input.length > LIMITS.inputBytes', '') },
  ];
  for (const mutant of mutants) {
    const assets = mutant.plugin ? await buildTsHostAssets({ plugins: [mutant.plugin] }) : real;
    const result = await battery(mutant.csp ?? MODULE_CSP, assets);
    const lost = result.results.filter(([, ok]) => !ok).length;
    report(`мутация «${mutant.name}» замечена (${lost} проверок упало${mutant.leaks ? `, до внешнего сервера дошло ${result.leaks.length}` : ''})`, lost > 0 && (!mutant.leaks || result.leaks.length > 0));
  }

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(() => {
  if (failedCount) { console.error(`\nПРОВАЛ: ${failedCount} проверок`); process.exit(1); }
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}, error => { console.error(error); process.exit(1); });
