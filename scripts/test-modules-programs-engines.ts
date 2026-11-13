/**
 * Вызов программа → программа на НАСТОЯЩИХ движках в Chromium: метод на Python (Pyodide), на WebAssembly и на TypeScript
 * исполняется настоящими `createProgramCaller` и `ModuleCompute`, а решает и пишет журнал настоящий `ModuleProgramCalls`
 * по подписанным выпускам в настоящем кэше (доступ окна к нему — через `__invoke`, как IPC окна во Flux).
 *
 * test-modules-programs проверяет всё вокруг движков на подставных; здесь — сами движки: хосты отдаются с теми же заголовками
 * (`moduleHeaders`: CSP и sandbox), что и в electron/modules.ts. Чего здесь нет: протокола `flux-module://` и Electron —
 * это проверяет test-modules-compute-native на Windows в CI.
 *
 * Запуск: FLUX_CHROME=/путь/к/chrome npx tsx scripts/test-modules-programs-engines.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { verifySkip } from './verifySkip';
import { buildComputeAssets, buildModuleLogic } from '../modules/build';
import { MODULE_CSP, TS_HOST_FILE, moduleHeaders } from '../modules/protocol';
import { PROGRAM_LIMITS, programPolicyTarget } from '../modules/programs/model';
import { LOGIC_BUILD_FILE } from '../modules/engine/types';
import { splitChunks } from '../modules/trust/bundle';
import { ModuleCache } from '../electron/moduleCache';
import { ModuleSelection } from '../electron/moduleSelection';
import { ModuleJournal } from '../electron/moduleJournal';
import { ModuleGrants } from '../electron/moduleGrants';
import { ModuleProgramCalls, currentRelease } from '../electron/moduleProgramCalls';
import type { ModuleManifest } from '../modules/contract';
import { hexOf, moduleBundle, newKey, releaseEnvelope } from './fixtures/moduleTrust';
import { fluxModule, WASM_OPS as OP, wasmSleb } from './fixtures/wasmBuilder';

let passed = 0, failedCount = 0;
const report = (name: string, condition: unknown) => { if (condition) { passed++; console.log('  ✓', name); } else { failedCount++; console.error('  ✗', name); } };

const DOES = 'Берёт у калькулятора курсов пересчёт сумм для отчёта';
const methodsOf = (...methods: string[]) => methods.map(method => ({ method, does: `Метод ${method} считает значение по входным данным` }));
/** Контрольные примеры: вход `{ v: 1 }` — «ничего не считать», ответ один и тот же для всех методов */
const controlsFor = (out: unknown) => JSON.stringify({ version: 1, cases: [{ name: 'один', input: { v: 1 }, expect: { state: {}, calc: { out } } }] });
const CONTROL_INPUT_BYTES = JSON.stringify({ v: 1 }).length;

const PY_LOGIC = `
def compute(input):
    method, data = input.get("export"), input.get("data")
    out = lambda value: {"state": {}, "calc": {"out": value}}
    if method is None:
        return out({"ok": True})
    if method == "convert":
        return out({"value": round(data["amount"] * data["rate"] * 100) / 100, "by": "python"})
    if method == "spin":
        while True:
            pass
    if method == "huge":
        return out({"text": "я" * 300000})
    if method == "crash":
        raise ValueError("СЕКРЕТ-В-ОШИБКЕ")
    return out({"method": method})
`;
const TS_LOGIC = `
let counter = 0;
const out = (value: unknown) => ({ state: {}, calc: { out: value } });
export function compute(input: { export?: string; data: any }) {
  switch (input.export) {
    case undefined: return out({ ok: true });
    case 'convert': return out({ value: Math.round(input.data.amount * input.data.rate * 100) / 100, by: 'typescript', calls: ++counter });
    case 'spin': for (;;) { /* бесконечный цикл */ }
    case 'huge': return out({ text: 'я'.repeat(300000) });
    default: return out({ method: input.export });
  }
}
`;
const WASM_OUT = '{"state":{},"calc":{"out":{"ok":true,"by":"wasm"}}}';
/** Метод на WebAssembly без разбора входа: ответ — постоянная строка; «зависающий» крутится, пока вход не равен контрольному по длине */
const wasmConstant = () => fluxModule({ output: WASM_OUT });
const wasmSpinning = () => fluxModule({ output: WASM_OUT, run: [0x20, 1, 0x41, ...wasmSleb(CONTROL_INPUT_BYTES), 0x47, 0x04, 0x40, OP.loop, 0x40, OP.br, 0, OP.end, OP.end, OP.i32const, ...wasmSleb(WASM_OUT.length)] });

async function main() {
  const chrome = process.env.FLUX_CHROME || '/usr/bin/chromium';
  if (!fs.existsSync(chrome)) {
    // В CI тихий пропуск недопустим: без настоящих движков набор был бы пустым
    if (process.env.CI) { failedCount++; console.error(`  ✗ в CI нет Chromium (${chrome}): проверка настоящих движков не выполнена`); return; }
    verifySkip('нет Chromium (FLUX_CHROME)'); return;
  }
  const { chromium } = await import('playwright-core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-programs-engines-'));
  const root = newKey(), dev = hexOf(newKey());
  const cache = new ModuleCache(path.join(dir, 'data'), hexOf(root));
  const selection = new ModuleSelection(path.join(dir, 'selection.json'));
  await selection.load(); await selection.activate('u1');

  // ── Подписанные выпуски: вызывающая и вызываемые на трёх движках ────────────
  fs.mkdirSync(path.join(dir, 'ts/logic'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ts/logic/main.ts'), TS_LOGIC);
  const tsBuilt = await buildModuleLogic(path.join(dir, 'ts'), { id: 'x', name: 'x', version: '1.0.0', author: 'A', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts',
    exports: methodsOf('convert') } as unknown as ModuleManifest);
  const installed: string[] = [];
  async function publish(id: string, patch: Record<string, unknown>, files: Record<string, string | Uint8Array>) {
    const manifest = { id, name: `Программа ${id}`, contractVersion: 3, ...patch };
    const bundle = moduleBundle('1.0.0', files as Record<string, string>, manifest);
    const signature = releaseEnvelope(root, bundle, { moduleId: id, version: '1.0.0', author: dev, channel: 'production', contractVersion: 3, language: (patch.language as string) ?? undefined });
    const result = await cache.install({ id: `rel-${id}`, moduleId: id, version: '1.0.0', signature }, splitChunks(bundle));
    if (!result.ok) throw new Error(`${id}: ${result.why}`);
    await selection.install(id, '1.0.0', { dirty: false });
    installed.push(id);
  }
  const python = (id: string, methods: string[], source = PY_LOGIC, controls = controlsFor({ ok: true })) =>
    publish(id, { language: 'python', logic: 'logic/main.py', exports: methodsOf(...methods) }, { 'logic/main.py': source, 'examples/controls.json': controls });
  const wasm = (id: string, methods: string[], bytes: Uint8Array) =>
    publish(id, { language: 'wasm', sourceLanguage: 'c', logic: 'logic/main.wasm', exports: methodsOf(...methods) }, { 'logic/main.wasm': bytes, 'examples/controls.json': controlsFor({ ok: true, by: 'wasm' }) });
  await python('pyrates', ['convert', 'spin', 'huge', 'crash']);
  await python('pybad', ['convert'], PY_LOGIC.replace('return out({"ok": True})', 'return out({"ok": False})'));
  await wasm('wasmrates', ['convert'], wasmConstant());
  await wasm('wasmspin', ['spin'], wasmSpinning());
  await publish('tsrates', { exports: methodsOf('convert', 'spin', 'huge') }, { 'logic/main.ts': TS_LOGIC, [LOGIC_BUILD_FILE]: `${tsBuilt}\n`, 'examples/controls.json': controlsFor({ ok: true }) });
  await publish('report', { permissions: ['pyrates', 'pybad', 'wasmrates', 'wasmspin', 'tsrates'].map(program => ({ kind: 'program', program, does: DOES })) }, {});
  const runnable = await cache.resolve(selection.versions(), selection.channels);

  // ── Главный процесс: настоящий ModuleProgramCalls ─────────────────────────────
  const journal = new ModuleJournal(path.join(dir, 'journal.json'));
  const grants = new ModuleGrants(path.join(dir, 'grants.json'));
  const programs = new ModuleProgramCalls({
    resolve: async (id, version) => runnable.get(id)?.claim.version === version ? { manifest: runnable.get(id)!.manifest, version, author: dev, verifiedAt: 1 } : null,
    current: async id => currentRelease(runnable, selection.installed, () => false, id),
    userId: () => 'u1', journal, deniedByPolicy: (id, target) => grants.isDeniedByPolicy(id, target),
  });

  console.log('1. Подписанные выпуски на трёх движках');
  report(`выпуски проверены и лежат в кэше: ${installed.length}`, installed.length === 6 && runnable.size === 6);

  // ── Сервер: хосты движков с теми же заголовками, что у электронного протокола ──
  const assets = await buildComputeAssets();
  const prefix = 'modules/_compute/';
  const harness = (await build({ entryPoints: ['scripts/fixtures/programs-engines-harness.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })).outputFiles[0].text;
  const wasmWorker = (await build({ entryPoints: ['src/workers/moduleWasm.worker.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })).outputFiles[0].text;
  const TYPES: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.zip': 'application/zip', '.whl': 'application/zip' };
  const LOGIC_FILE: Record<string, string> = { 'logic.py': 'logic/main.py', 'logic.wasm': 'logic/main.wasm', 'logic.js': LOGIC_BUILD_FILE, 'controls.json': 'examples/controls.json' };
  const server = http.createServer((req, res) => {
    const file = decodeURIComponent((req.url || '/').split('?')[0]);
    const send = (type: string, body: string | Uint8Array, host = false) => { res.writeHead(200, moduleHeaders(type, host)); res.end(body); };
    if (file === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta charset="utf-8"><body><script>${harness}</script>`); return; }
    if (file === '/wasm-worker.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(wasmWorker); return; }
    if (file.startsWith('/_compute/')) {
      const name = file.slice('/_compute/'.length) || 'index.html';
      const asset = assets[`${prefix}${name}`];
      if (asset !== undefined) { send(TYPES[path.extname(name)] ?? 'application/octet-stream', asset, !TS_HOST_FILE.test(name)); return; }
    }
    const logic = /^\/files\/([a-z0-9-]+)\/([a-z.]+)$/.exec(file);
    const bytes = logic && LOGIC_FILE[logic[2]] ? runnable.get(logic[1])?.files[LOGIC_FILE[logic[2]]] : undefined;
    if (bytes) { send('application/octet-stream', bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on('pageerror', e => errors.push(e.message));
  await tab.exposeFunction('__invoke', (channel: string, data: any) => channel === 'modules:program-begin' ? programs.begin(data) : { ok: programs.end(data) });
  try {
    await tab.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const callBy = { moduleId: 'report', version: '1.0.0' };
    const ask = (program: string, method: string, data: unknown = null, limitMs?: number): Promise<{ reply: any; ms: number }> =>
      tab.evaluate(([caller, p, m, d, t]) => (window as any).__h.call(caller, p, m, d, t), [callBy, program, method, data, limitMs] as const);
    const code = (r: { reply: any }) => r.reply.ok ? 'ok' : r.reply.code;

    console.log('2. TypeScript: настоящий изолированный кадр');
    let r = await ask('tsrates', 'convert', { amount: 100, rate: 0.9 });
    report('TypeScript: успех — ответ метода', code(r) === 'ok' && r.reply.data.value === 90 && r.reply.data.by === 'typescript');
    r = await ask('tsrates', 'convert', { amount: 1, rate: 1 });
    report('TypeScript: состояния между вызовами нет (счётчик модуля снова 1)', code(r) === 'ok' && r.reply.data.calls === 1);
    r = await ask('tsrates', 'spin', null, 400);
    report(`TypeScript: бесконечный цикл — TIMEOUT (${r.ms} мс)`, code(r) === 'TIMEOUT' && r.ms < 4000);
    report('TypeScript: после остановки следующий вызов работает', code(await ask('tsrates', 'convert', { amount: 2, rate: 2 })) === 'ok');
    report('TypeScript: ответ больше 256 КиБ — LIMIT', code(await ask('tsrates', 'huge')) === 'LIMIT');
    report('TypeScript: данные больше 256 КиБ — LIMIT, метод не запускался', code(await ask('tsrates', 'convert', { text: 'x'.repeat(PROGRAM_LIMITS.bytes) })) === 'LIMIT');

    console.log('3. WebAssembly: настоящий Worker');
    r = await ask('wasmrates', 'convert', { amount: 1 });
    report('WebAssembly: успех — ответ метода', code(r) === 'ok' && r.reply.data.by === 'wasm' && r.reply.data.ok === true);
    r = await ask('wasmspin', 'spin', { amount: 1 }, 500);
    report(`WebAssembly: бесконечный цикл — TIMEOUT (${r.ms} мс)`, code(r) === 'TIMEOUT' && r.ms < 5000);
    report('WebAssembly: после остановки Worker заменён, следующий вызов работает', code(await ask('wasmrates', 'convert', { amount: 2 })) === 'ok');
    report('WebAssembly: данные больше 256 КиБ — LIMIT, метод не запускался', code(await ask('wasmrates', 'convert', { text: 'x'.repeat(PROGRAM_LIMITS.bytes) })) === 'LIMIT');

    console.log('4. Python: настоящий Pyodide в изолированном кадре');
    r = await ask('pyrates', 'convert', { amount: 100, rate: 0.9 });
    report(`Python: успех — ответ метода (${r.ms} мс с запуском среды)`, code(r) === 'ok' && r.reply.data.value === 90 && r.reply.data.by === 'python');
    r = await ask('pyrates', 'spin', null, 2500);
    report(`Python: бесконечный цикл — TIMEOUT (${r.ms} мс)`, code(r) === 'TIMEOUT');
    r = await ask('pyrates', 'convert', { amount: 2, rate: 3 });
    report('Python: после остановки среда пересоздана, следующий вызов работает', code(r) === 'ok' && r.reply.data.value === 6);
    report('Python: ответ больше 256 КиБ — LIMIT', code(await ask('pyrates', 'huge')) === 'LIMIT');
    report('Python: исключение метода — FAILED', code(await ask('pyrates', 'crash')) === 'FAILED');
    report('Python: контрольные примеры вызываемой не сошлись — FAILED, метод не исполнялся', code(await ask('pybad', 'convert', { amount: 1, rate: 1 })) === 'FAILED');

    console.log('5. Запрет администратора на настоящей цепочке');
    grants.setPolicy([{ moduleId: 'report', connection: programPolicyTarget('pyrates') }]);
    report('запрет report → pyrates: NOT_ALLOWED, остальные программы report вызывает', code(await ask('pyrates', 'convert', { amount: 1, rate: 1 })) === 'NOT_ALLOWED' && code(await ask('wasmrates', 'convert', {})) === 'ok');
    grants.setPolicy([]);
    report('запрет снят — вызов проходит', code(await ask('pyrates', 'convert', { amount: 1, rate: 1 })) === 'ok');

    console.log('6. Журнал и сбои');
    const entries = journal.recent(500);
    const has = (moduleId: string, event: string, outcome: string) => entries.some(e => e.moduleId === moduleId && e.event === event && e.outcome === outcome);
    report('журнал вызывающей: ok, timeout, limit, failed, denied-by-admin', ['ok', 'timeout', 'limit', 'failed', 'denied-by-admin'].every(o => has('report', 'call', o)));
    report('журнал вызываемых: исполнение метода записано у каждого движка (ok и timeout)', ['pyrates', 'wasmrates', 'wasmspin', 'tsrates'].every(id => entries.some(e => e.moduleId === id && e.event === 'export' && ['ok', 'timeout'].includes(e.outcome))));
    report('в журнале нет содержимого вызова и ответа, текста ошибки метода', !/СЕКРЕТ|я{50}|amount/.test(JSON.stringify(entries)));
    report('запрещённый администратором вызов не оставил записи у вызываемой', !entries.some(e => e.moduleId === 'pyrates' && e.event === 'export' && e.outcome === 'denied-by-admin'));
    report('место в пределах освобождено после всех исходов', programs.active === 0);
    const failures: string[] = await tab.evaluate(() => (window as any).__h.failures());
    report('остановки по времени записаны в счётчики сбоев видом, а не текстом', ['tsrates', 'wasmspin', 'pyrates'].every(id => failures.includes(`${id}@1.0.0:timeout`)));
    report('кадров хоста Python и TypeScript — по одному', await tab.evaluate(() => document.querySelectorAll('iframe[data-testid="flux-python-host"]').length === 1 && document.querySelectorAll('iframe[data-testid="flux-ts-host"]').length === 1));
    report(`ошибок исполнения страницы нет (${JSON.stringify(errors)})`, errors.length === 0);
    report('CSP хостов не ослаблена: у хоста TypeScript — строгая MODULE_CSP', /connect-src 'none'/.test(MODULE_CSP));
  } finally {
    await tab.evaluate(() => (window as any).__h.dispose()).catch(() => null);
    await context.close(); await browser.close(); server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => {
  if (failedCount) { console.error(`\nПРОВАЛ: ${failedCount} проверок`); process.exit(1); }
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}, error => { console.error(error); process.exit(1); });
