/**
 * WebAssembly (этап 3а, шаг 2): проверка до компиляции, единый вызов для
 * C, C++, Rust, Go и C#, кэш компиляции, пределы памяти и урезанный WASI.
 *
 * Запуск: npx tsx scripts/test-modules-wasm.ts
 */
import assert from 'node:assert/strict';
import { inspectWasm, wasmAbi, wasmProblem } from '../modules/engine/wasmInspect';
import { loadWasm, MemoryCompileCache, runWasm, WasmInstance } from '../modules/engine/wasm';
import { parseComputeOutput } from '../modules/engine/json';
import { runControls } from '../modules/engine/controls';
import { ComputeError, LIMITS } from '../modules/engine/types';
import { sha256Hex } from '../modules/trust/envelope';
import { buildWasm, fluxModule, WASM_OPS as OP, wasmSleb } from './fixtures/wasmBuilder';
import { fixtureManifest, logicBytes, statsControls, WASM_LANGUAGES } from './fixtures/moduleLanguages';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const codeOf = async (fn: () => Promise<unknown> | unknown) => { try { await fn(); return ''; } catch (e) { return e instanceof ComputeError ? e.code : `other:${(e as Error).message}`; } };
const ms = (t: number) => `${(performance.now() - t).toFixed(1)} мс`;

async function main() {
  console.log('Готовые .wasm примеров: разбор до компиляции');
  for (const lang of WASM_LANGUAGES) {
    const bytes = logicBytes(lang);
    const info = inspectWasm(bytes);
    ok(`${lang}: файл подходит Flux`, wasmProblem(bytes) === '');
    ok(`${lang}: манифест называет исходный язык`, fixtureManifest(lang).sourceLanguage === lang);
    ok(`${lang}: у памяти записан максимум`, (info.memory?.max ?? 0) > 0);
    const abi = wasmAbi(info);
    ok(`${lang}: способ вызова — ${abi}`, abi === (lang === 'csharp' ? 'command' : 'reactor'));
    ok(`${lang}: импорты только из урезанного WASI`, info.imports.every(i => i.module === 'wasi_snapshot_preview1'));
  }
  ok('Rust и Go (TinyGo) не имеют ни одного импорта', inspectWasm(logicBytes('rust')).imports.length === 0 && inspectWasm(logicBytes('go')).imports.length === 0);

  console.log('Один и тот же контрольный набор на каждом языке');
  const controls = statsControls();
  const outputs: Record<string, string[]> = {};
  for (const lang of WASM_LANGUAGES) {
    const cache = new MemoryCompileCache();
    const bytes = logicBytes(lang);
    const fingerprint = sha256Hex(bytes);
    let t = performance.now();
    const first = await loadWasm(bytes, fingerprint, cache);
    const compile = ms(t);
    t = performance.now();
    const second = await loadWasm(bytes, fingerprint, cache);
    const cached = ms(t);
    ok(`${lang}: первый запуск компилирует, повторный берёт из кэша`, first.from === 'compiled' && second.from === 'cache' && second.module === first.module);
    outputs[lang] = [];
    t = performance.now();
    const report = await runControls(controls, async input => {
      const text = await runWasm(second, JSON.stringify(input));
      outputs[lang].push(JSON.stringify(parseComputeOutput(text)));
      return parseComputeOutput(text);
    });
    ok(`${lang}: все ${controls.cases.length} контрольных примеров сошлись (без допуска, бит в бит)`, report.ok && report.passed === controls.cases.length);
    console.log(`  ${lang}: компиляция ${compile}, повторная загрузка ${cached}, набор из ${controls.cases.length} расчётов ${ms(t)}, файл ${bytes.length} байт`);
  }
  for (const lang of WASM_LANGUAGES) ok(`${lang}: выход совпадает с C`, JSON.stringify(outputs[lang]) === JSON.stringify(outputs.c));

  console.log('Кэш компиляции');
  {
    const cache = new MemoryCompileCache(2);
    const a = fluxModule({ output: '{"state":{},"calc":{"out":{"a":1}}}' }), b = fluxModule({ output: '{"state":{},"calc":{"out":{"b":1}}}' }), c = fluxModule();
    await loadWasm(a, 'a', cache); await loadWasm(b, 'b', cache); await loadWasm(c, 'c', cache);
    ok('кэш не растёт сверх предела', cache.size === 2 && !(await cache.get('a')));
    await cache.keepOnly(new Set(['c']));
    ok('keepOnly убирает выпуски, которых больше нет', cache.size === 1 && !!(await cache.get('c')));
    const other = await loadWasm(a, 'c', cache);
    ok('кэш отдаёт то, что лежит под отпечатком (отпечаток обязан быть хешем файла)', other.from === 'cache');
  }

  console.log('Проверка до подписи: чужие импорты и память');
  {
    const forbidden: Array<[string, string]> = [['env', 'fetch'], ['js', 'eval'], ['go', 'syscall/js.valueGet'], ['env', 'emscripten_run_script'], ['wasi_snapshot_preview1', 'sock_open'], ['flux', 'read_file']];
    for (const [module, name] of forbidden) {
      const bytes = fluxModule({ extraImports: [{ module, name, type: 3 }] });
      ok(`импорт ${module}.${name} отклонён`, wasmProblem(bytes).includes(`${module}.${name}`));
      ok(`  и не компилируется в движке`, (await codeOf(() => loadWasm(bytes, 'x'))) === 'ABI');
    }
    ok('импорт flux.log допустим', wasmProblem(fluxModule({ extraImports: [{ module: 'flux', name: 'log', type: 3 }] })) === '');
    ok('flux.log с другой сигнатурой отклонён', wasmProblem(fluxModule({ extraImports: [{ module: 'flux', name: 'log', type: 0 }] })) !== '');
    ok('память без максимума отклонена', wasmProblem(fluxModule({ memory: { min: 1 } })).includes('максимум'));
    ok('максимум памяти больше предела отклонён', wasmProblem(fluxModule({ memory: { min: 1, max: LIMITS.wasmMaxPages + 1 } })).includes('больше предела'));
    ok('начальная память больше предела отклонена', wasmProblem(fluxModule({ memory: { min: LIMITS.wasmMaxPages + 1, max: LIMITS.wasmMaxPages + 1 } })) !== '');
    ok('предел ровно допустим', wasmProblem(fluxModule({ memory: { min: 1, max: LIMITS.wasmMaxPages } })) === '');
    ok('чужая память env.memory допустима, максимум задаёт Flux', wasmProblem(fluxModule({ memory: null, extraImports: [{ module: 'env', name: 'memory', memory: { min: 1 } }] })) === '');
    ok('нет ни flux_run, ни _start', wasmProblem(buildWasm({ types: [{ params: [], results: [] }], funcs: [{ type: 0, code: [] }], memory: { min: 1, max: 1 }, exports: [{ name: 'memory', kind: 'memory', index: 0 }] })).includes('непонятно'));
    ok('не WebAssembly', wasmProblem(new TextEncoder().encode('MZ\x90\x00 это exe')).includes('не WebAssembly'));
    ok('обрезанный файл', wasmProblem(fluxModule().subarray(0, 30)) !== '');
    ok('файл больше 8 МиБ', wasmProblem(new Uint8Array(LIMITS.wasmFileBytes + 1)).includes('8 МиБ'));
  }

  console.log('Пределы памяти и ловушки');
  {
    const grow = fluxModule({
      memory: { min: 1, max: 16 },
      // loop { if memory.grow(1) != -1 { continue } } ; trap — упереться в максимум и упасть
      run: [OP.loop, 0x40, OP.i32const, 1, ...OP.memoryGrow, OP.i32const, ...wasmSleb(-1), 0x47, OP.brIf, 0, OP.end, OP.unreachable],
    });
    const loaded = await loadWasm(grow, 'grow');
    ok('рост памяти упирается в записанный максимум, а Flux называет это MEMORY', (await codeOf(() => runWasm(loaded, '{}'))) === 'MEMORY');
    const trap = await loadWasm(fluxModule({ run: [OP.unreachable] }), 'trap');
    ok('ловушка unreachable — CRASH, а не падение Flux', (await codeOf(() => runWasm(trap, '{}'))) === 'CRASH');
    const negative = await loadWasm(fluxModule({ run: [OP.i32const, ...wasmSleb(-5)] }), 'neg');
    ok('отрицательный код flux_run — CRASH', (await codeOf(() => runWasm(negative, '{}'))) === 'CRASH');
    const huge = await loadWasm(fluxModule({ run: [OP.i32const, ...wasmSleb(300 * 1024)] }), 'huge');
    ok('выход больше 256 КиБ отклонён', (await codeOf(() => runWasm(huge, '{}'))) === 'BAD_OUTPUT');
    const outside = await loadWasm(fluxModule({ run: [OP.i32const, ...wasmSleb(70000)] }), 'out');
    ok('длина выхода за пределами памяти — ABI', (await codeOf(() => runWasm(outside, '{}'))) === 'ABI');
    const text = await runWasm(await loadWasm(fluxModule(), 'ok'), '{}');
    ok('обычный модуль отвечает', parseComputeOutput(text).calc.out.ok === true);
  }

  console.log('Урезанный WASI: часы стоят, случайность только от зерна');
  {
    // random_get(2048, 16), затем каждый байт сводится к букве a..p, чтобы выход был читаемым текстом
    const random = fluxModule({
      extraImports: [{ module: 'wasi_snapshot_preview1', name: 'random_get', type: 1 }],
      runLocals: [[1, 'i32']],
      run: [
        OP.i32const, ...wasmSleb(2048), OP.i32const, 16, 0x10, 0, OP.drop,
        OP.loop, 0x40,
        0x20, 2, OP.i32const, ...wasmSleb(2048), OP.i32add,
        0x20, 2, OP.i32const, ...wasmSleb(2048), OP.i32add, 0x2d, 0, 0, OP.i32const, 15, 0x71, OP.i32const, ...wasmSleb(97), OP.i32add,
        0x3a, 0, 0,
        0x20, 2, OP.i32const, 1, OP.i32add, 0x22, 2, OP.i32const, 16, 0x49, OP.brIf, 0,
        OP.end, OP.i32const, 16,
      ],
    });
    const loaded = await loadWasm(random, 'random');
    const a1 = await runWasm(loaded, '{}', { seed: 7 }), a2 = await runWasm(loaded, '{}', { seed: 7 }), b = await runWasm(loaded, '{}', { seed: 8 });
    ok('то же зерно — те же «случайные» байты', a1 === a2 && /^[a-p]{16}$/.test(a1));
    ok('другое зерно — другие байты', a1 !== b);
    const noSeed = await runWasm(loaded, '{}');
    ok('без зерна результат тоже повторяется (случайности нет)', noSeed === await runWasm(loaded, '{}'));
  }

  console.log('Каждый расчёт — новый экземпляр');
  {
    const loaded = await loadWasm(logicBytes('c'), 'c-fresh');
    const first = await WasmInstance.create(loaded);
    const small = first.run(JSON.stringify({ flux: { equipment: { params: [{ value: '5' }] } } }));
    const again = (await WasmInstance.create(loaded)).run(JSON.stringify({ flux: { equipment: { params: [{ value: '5' }] } } }));
    ok('экземпляры не делят память: результат не зависит от прошлых вызовов', small === again);
  }

  console.log(`WebAssembly, шаг 2: проверок ${passed}`);
}
main().catch(e => { console.error('✗', e); process.exit(1); });
