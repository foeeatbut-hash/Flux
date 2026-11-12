/**
 * Одинаковый результат на всех языках (этап 3а, шаги 1 и 5): TypeScript,
 * Python, C, C++, Rust, Go, C# проходят один и тот же набор контрольных
 * примеров через один и тот же единый вызов «вход JSON → выход JSON»
 * и дают побитово одинаковые числа. Заодно — детерминизм TypeScript
 * (часы стоят, случайность от зерна).
 *
 * Запуск: npx tsx scripts/test-modules-parity.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { loadWasm, runWasm } from '../modules/engine/wasm';
import { PythonEnvironment } from '../modules/engine/python';
import { parseComputeOutput } from '../modules/engine/json';
import { runControls } from '../modules/engine/controls';
import { sha256Hex } from '../modules/trust/envelope';
import { logicBytes, statsControls, WASM_LANGUAGES } from './fixtures/moduleLanguages';

const require = createRequire(import.meta.url);
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };

/** Тот же Worker, что в окне программы (modules/runtime/worker.ts), в потоке Node с минимальной оболочкой */
async function typescriptEngine(logic: string) {
  const bundle = await build({ entryPoints: ['modules/runtime/worker.ts'], bundle: true, write: false, platform: 'browser', format: 'iife',
    alias: { 'module-logic': path.resolve(logic) } });
  const prelude = `const { parentPort } = require('worker_threads'); globalThis.onmessage = null;
    globalThis.postMessage = m => parentPort.postMessage(m); parentPort.on('message', d => globalThis.onmessage && globalThis.onmessage({ data: d }));`;
  const worker = new Worker(prelude + bundle.outputFiles[0].text, { eval: true });
  let n = 0;
  return {
    run: (input: string, seed = 0) => new Promise<string>((resolve, reject) => {
      const id = `t-${++n}`;
      const listen = (m: any) => { if (m.id !== id) return; worker.off('message', listen); m.type === 'computed' ? resolve(m.output) : reject(new Error(m.code)); };
      worker.on('message', listen);
      worker.postMessage({ type: 'compute', id, input, seed });
    }),
    stop: () => worker.terminate(),
  };
}

async function main() {
  const controls = statsControls();
  const results: Record<string, string> = {};
  const record = (lang: string) => { const seen: string[] = []; return { seen, wrap: (fn: (i: string) => Promise<string>) => async (input: unknown) => { const t = await fn(JSON.stringify(input)); const o = parseComputeOutput(t); seen.push(JSON.stringify(o)); return o; }, done: () => { results[lang] = seen.join('|'); } }; };

  const ts = await typescriptEngine('modules/fixtures/typescript/logic/main.ts');
  { const r = record('typescript'); const rep = await runControls(controls, r.wrap(i => ts.run(i))); r.done();
    ok('typescript: контрольные примеры сошлись', rep.ok && rep.passed === controls.cases.length); }

  const { loadPyodide } = require('pyodide');
  const py = await loadPyodide({ indexURL: path.dirname(require.resolve('pyodide/package.json')) + path.sep, stdout: () => {}, stderr: () => {} });
  const env = new PythonEnvironment(py);
  const source = fs.readFileSync('modules/fixtures/python/logic/main.py', 'utf8');
  { const r = record('python'); const rep = await runControls(controls, r.wrap(i => env.run('stats-python@1.0.0', source, i))); r.done();
    ok('python: контрольные примеры сошлись', rep.ok && rep.passed === controls.cases.length); }

  for (const lang of WASM_LANGUAGES) {
    const bytes = logicBytes(lang);
    const loaded = await loadWasm(bytes, sha256Hex(bytes));
    const r = record(lang); const rep = await runControls(controls, r.wrap(i => runWasm(loaded, i))); r.done();
    ok(`${lang}: контрольные примеры сошлись`, rep.ok && rep.passed === controls.cases.length);
  }

  for (const lang of ['python', ...WASM_LANGUAGES]) ok(`${lang} == typescript, число в число`, results[lang] === results.typescript);
  ok('все семь языков дали один и тот же набор результатов', new Set(Object.values(results)).size === 1 && Object.keys(results).length === 7);

  console.log('Детерминизм TypeScript');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flux-ts-'));
  fs.writeFileSync(path.join(tmp, 'main.ts'), 'export function compute() { return { state: {}, calc: { out: { r: Math.random(), t: Date.now(), d: new Date().getTime(), p: performance.now() } } }; }\n');
  const rnd = await typescriptEngine(path.join(tmp, 'main.ts'));
  const a = parseComputeOutput(await rnd.run('{}', 3)).calc.out, b = parseComputeOutput(await rnd.run('{}', 3)).calc.out, c = parseComputeOutput(await rnd.run('{}', 4)).calc.out;
  ok('то же зерно — та же «случайность»', a.r === b.r && a.r !== c.r);
  ok('часы стоят: Date.now, new Date(), performance.now', a.t === 0 && a.d === 0 && a.p === 0);
  rnd.stop(); ts.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Одинаковый результат на семи языках: проверок ${passed}`);
}
main().catch(e => { console.error('✗', e); process.exit(1); });
