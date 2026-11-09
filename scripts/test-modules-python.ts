/**
 * Python (этап 3а, шаг 3): общая среда Pyodide — контрольные примеры,
 * отдельные пространства имён, запрет часов/сети/файлов, зерно, пределы.
 *
 * Запуск: npx tsx scripts/test-modules-python.ts
 * Pyodide берётся из node_modules/pyodide (тот же пакет попадает в portable).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PythonEnvironment, clampWasmMemory, type PyodideApi } from '../modules/engine/python';
import { parseComputeOutput, parseJson } from '../modules/engine/json';
import { runControls } from '../modules/engine/controls';
import { ComputeError, LIMITS } from '../modules/engine/types';
import { statsControls } from './fixtures/moduleLanguages';
import os from 'node:os';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const codeOf = async (fn: () => Promise<unknown>) => { try { await fn(); return ''; } catch (e) { return e instanceof ComputeError ? `${e.code}|${e.message}` : `other:${(e as Error).message}`; } };
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} мс`;

const pyodideDir = path.dirname(require.resolve('pyodide/package.json'));
async function boot() {
  const { loadPyodide } = require('pyodide');
  const t = performance.now();
  const py = await loadPyodide({ indexURL: pyodideDir + path.sep, stdout: () => {}, stderr: () => {} }) as PyodideApi & { version: string };
  return { py, ms: performance.now() - t };
}
const input = (extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, context: { projectId: 'p', entry: 'equipment', entityId: 'e' }, flux: {}, state: {}, ...extra });
const statsSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'fixtures', 'python', 'logic', 'main.py'), 'utf8');

async function main() {
  const { py, ms: bootMs } = await boot();
  console.log(`Pyodide ${py.version} загружен за ${bootMs.toFixed(0)} мс`);
  const env = new PythonEnvironment(py);

  console.log('Контрольные примеры на Python');
  {
    const controls = statsControls();
    const t = performance.now();
    const report = await runControls(controls, async i => parseComputeOutput(await env.run('stats@1', statsSource, JSON.stringify(i))));
    ok(`все ${controls.cases.length} контрольных примеров сошлись без допуска`, report.ok && report.passed === controls.cases.length);
    console.log(`  набор из ${controls.cases.length} расчётов: ${ms(t)}`);
    ok('подпрограмма загружена в свою область', env.namespaces === 1);
  }

  console.log('Пространства имён подпрограмм');
  {
    const a = 'counter = 41\ndef compute(i):\n    global counter\n    counter += 1\n    return {"state": {}, "calc": {"out": {"n": counter}}}\n';
    const b = 'def compute(i):\n    return {"state": {}, "calc": {"out": {"seen": "counter" in globals()}}}\n';
    ok('первая подпрограмма меняет свои переменные', parseComputeOutput(await env.run('a@1', a, input())).calc.out.n === 42);
    ok('между вызовами ничего не накапливается: расчёт не зависит от прошлых', parseComputeOutput(await env.run('a@1', a, input())).calc.out.n === 42);
    ok('вторая чужих переменных не видит', parseComputeOutput(await env.run('b@1', b, input())).calc.out.seen === false);
    env.drop('a@1');
    ok('выгруженная подпрограмма загружается заново чистой', parseComputeOutput(await env.run('a@1', a, input())).calc.out.n === 42);
    const same = 'def compute(i):\n    return {"state": {}, "calc": {"out": {"v": 2}}}\n';
    ok('новая версия исходника заменяет старую', parseComputeOutput(await env.run('b@1', same, input())).calc.out.v === 2);
  }

  console.log('Нет часов, сети, файлов и процессов');
  {
    const deny = async (statement: string) => {
      const source = `${statement}\ndef compute(i):\n    return {"state": {}, "calc": {"out": {}}}\n`;
      return codeOf(() => env.run(`deny-${statement}`, source, input()));
    };
    for (const statement of ['import os', 'import sys', 'import time', 'import datetime', 'import socket', 'import subprocess', 'import urllib.request',
      'import http.client', 'import js', 'import pyodide', 'from js import fetch', 'import pyodide_js', 'import ctypes', 'import importlib', 'import asyncio', 'import threading']) {
      const result = await deny(statement);
      ok(`«${statement}» недоступен`, result.startsWith('CRASH|') && result.includes('недоступен во Flux'));
    }
    for (const statement of ['import math', 'import json', 'import re', 'import statistics', 'import random', 'from decimal import Decimal', 'import itertools, functools, collections']) {
      ok(`«${statement}» разрешён`, (await deny(statement)) === '');
    }
    const open_ = await codeOf(() => env.run('open@1', 'def compute(i):\n    open("/etc/passwd")\n', input()));
    ok('open() убран', open_.startsWith('CRASH|') && open_.includes('NameError'));
    ok('относительный импорт запрещён', (await deny('from . import x')).startsWith('CRASH|'));
    const noCompute = await codeOf(() => env.run('nocompute@1', 'x = 1\n', input()));
    ok('без compute подпрограмма не загружается', noCompute.includes('compute'));
  }

  console.log('Подпрограммы не влияют друг на друга через стандартную библиотеку');
  {
    const patch = 'import math\nmath.sqrt = lambda x: -1.0\nimport json\njson.dumps = None\ndef compute(i):\n    return {"state": {}, "calc": {"out": {"v": math.sqrt(4.0)}}}\n';
    const victim = 'import math\nimport json\ndef compute(i):\n    return {"state": {}, "calc": {"out": {"v": math.sqrt(4.0), "d": json.dumps is not None}}}\n';
    ok('первая подпрограмма видит свою подмену', parseComputeOutput(await env.run('patch@1', patch, input())).calc.out.v === -1);
    const v = parseComputeOutput(await env.run('victim@1', victim, input())).calc.out;
    ok('подмена math.sqrt и json.dumps другой подпрограмме не видна', v.v === 2 && v.d === true);
    ok('и самой первой в следующем расчёте тоже', parseComputeOutput(await env.run('patch@1', patch, input())).calc.out.v === -1 && parseComputeOutput(await env.run('victim@1', victim, input())).calc.out.v === 2);
    const probe = async (expr: string) => {
      const source = `import random, statistics, json, re, collections, typing, dataclasses, contextlib\ndef compute(i):\n    try:\n        r = repr(${expr})\n    except Exception as e:\n        r = type(e).__name__\n    return {"state": {}, "calc": {"out": {"r": r}}}\n`;
      return parseComputeOutput(await env.run(`probe-${expr}`, source, input())).calc.out.r;
    };
    for (const expr of ['random._os', 'random._os.sys.modules["time"]', 'statistics.sys', 'statistics._random', 'json.codecs', 'json.encoder', 're.enum', 'collections._sys',
      'typing.sys', 'dataclasses.inspect', 'contextlib.os']) {
      ok(`«${expr}» не достижимо`, await probe(expr) === 'AttributeError');
    }
    ok('доступны обычные вещи: json.dumps, re.sub, statistics.stdev', await probe('(json.dumps([1]), re.sub("a", "b", "aa"), statistics.stdev([1.0, 2.0, 3.0]))') === "('[1]', 'bb', 1.0)");
  }

  console.log('Случайность только с зерном');
  {
    const source = 'import random\ndef compute(i):\n    return {"state": {}, "calc": {"out": {"r": random.random(), "k": random.randint(1, 1000000)}}}\n';
    const run = async (seed?: number) => parseComputeOutput(await env.run('rand@1', source, input(), seed)).calc.out;
    const a = await run(5), b = await run(5), c = await run(6), d = await run(), e = await run();
    ok('то же зерно — тот же результат', JSON.stringify(a) === JSON.stringify(b));
    ok('другое зерно — другой', JSON.stringify(a) !== JSON.stringify(c));
    const r = a.r as number, k = a.k as number;
    ok('значения в допустимых границах', r >= 0 && r < 1 && k >= 1 && k <= 1000000);
    ok('без зерна результат всё равно повторяется', JSON.stringify(d) === JSON.stringify(e));
  }

  console.log('Точность чисел');
  {
    const nan = await codeOf(() => env.run('nan@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"x": float("nan")}}}\n', input()));
    ok('NaN в результате — ошибка NUMBER', nan.startsWith('NUMBER|'));
    const inf = await codeOf(() => env.run('inf@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"x": 1e999 * 10}}}\n', input()));
    ok('бесконечность в результате — ошибка NUMBER', inf.startsWith('NUMBER|'));
    const big = await env.run('big@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"x": 2**60}}}\n', input());
    ok('целое 2^60 из Python отклоняется проверкой выхода (нужна строка)', (await codeOf(async () => parseJson(big))).startsWith('NUMBER'));
    const str = await env.run('str@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"x": str(2**60)}}}\n', input());
    ok('то же целое строкой проходит', parseComputeOutput(str).calc.out.x === '1152921504606846976');
    const bigIn = parseComputeOutput(await env.run('echo@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"x": i["state"]["x"]}}}\n', input({ state: { x: '9007199254740993' } })));
    ok('большое целое на входе строкой доходит неизменным', bigIn.calc.out.x === '9007199254740993');
    const unicode = parseComputeOutput(await env.run('u@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"t": "Расход, м³/ч"}}}\n', input()));
    ok('кириллица и индексы не портятся', unicode.calc.out.t === 'Расход, м³/ч');
    const nodict = await codeOf(async () => parseComputeOutput(await env.run('nd@1', 'def compute(i):\n    return [1, 2]\n', input())));
    ok('результат не по схеме договора отклонён', nodict.startsWith('BAD_OUTPUT|'));
  }

  console.log('numpy из колеса в сборке, без сети');
  {
    // Каталог «как в сборке»: файлы Pyodide + колесо из vendor/pyodide (сверка SHA-256 с pyodide-lock.json, как в modules/build.ts)
    const lock = JSON.parse(fs.readFileSync(path.join(pyodideDir, 'pyodide-lock.json'), 'utf8')).packages.numpy;
    const wheel = path.join(__dirname, '..', 'vendor', 'pyodide', lock.file_name);
    ok('колесо numpy из vendor совпадает по SHA-256 с pyodide-lock.json', createHash('sha256').update(fs.readFileSync(wheel)).digest('hex') === lock.sha256);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-pyodide-'));
    for (const f of ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) fs.copyFileSync(path.join(pyodideDir, f), path.join(dir, f));
    fs.copyFileSync(wheel, path.join(dir, lock.file_name));
    const { loadPyodide } = require('pyodide');
    const withNumpy = new PythonEnvironment(await loadPyodide({ indexURL: dir + path.sep, stdout: () => {}, stderr: () => {} }));
    const source = [
      'import numpy as np',
      'def compute(i):',
      '    a = np.array([[3.0, 1.0], [1.0, 2.0]])',
      '    x = np.linalg.solve(a, np.array([9.0, 8.0]))',
      '    rng = np.random.default_rng(7)',
      '    return {"state": {}, "calc": {"out": {"x": [float(v) for v in x], "mean": float(np.mean([1200.0, 3.5, 0.25])), "dot": float(np.dot([1.0, 2.0, 3.0], [4.0, 5.0, 6.0])),',
      '      "rng": float(rng.random()), "legacy": float(np.random.rand()), "ver": np.__version__}}}',
    ].join('\n');
    const t = performance.now();
    const first = parseComputeOutput(await withNumpy.run('np@1', source, input(), 11)).calc.out as any;
    console.log(`  первый расчёт с numpy (загрузка колеса): ${ms(t)}`);
    ok('numpy считает: решение системы, среднее, скалярное произведение', Math.abs(first.x[0] - 2) < 1e-12 && Math.abs(first.x[1] - 3) < 1e-12 && first.mean === 401.25 && first.dot === 32 && first.ver === '2.2.5');
    const again = parseComputeOutput(await withNumpy.run('np@1', source, input(), 11)).calc.out as any;
    ok('генератор с зерном и глобальный numpy.random повторяются от зерна', again.rng === first.rng && again.legacy === first.legacy);
    ok('другое зерно входа меняет глобальный numpy.random', parseComputeOutput(await withNumpy.run('np@1', source, input(), 12)).calc.out.legacy !== first.legacy);
    const bad = await codeOf(() => withNumpy.run('npos@1', 'import numpy as np\nimport os\ndef compute(i):\n    return {}\n', input()));
    ok('рядом с numpy остальные запреты на месте (os по-прежнему недоступен)', bad.startsWith('CRASH|') && bad.includes('недоступен'));
    // Что сети нет, доказывает не этот набор (Pyodide в Node при отсутствии колеса сам идёт в сеть), а test-modules-compute-native:
    // там CSP хоста разрешает только его собственный адрес, и numpy всё равно загружается из колеса в сборке
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('Память: максимум Pyodide сжимается до предела');
  {
    const restore = clampWasmMemory(2048); // 128 МиБ
    const small = await boot();
    restore();
    const clamped = new PythonEnvironment(small.py);
    const hog = 'def compute(i):\n    x = bytearray(400 * 1024 * 1024)\n    return {"state": {}, "calc": {"out": {"n": len(x)}}}\n';
    const result = await codeOf(() => clamped.run('hog@1', hog, input()));
    ok('400 МиБ при пределе 128 МиБ — MemoryError → код MEMORY', result.startsWith('MEMORY|'));
    const after = parseComputeOutput(await clamped.run('after@1', 'def compute(i):\n    return {"state": {}, "calc": {"out": {"ok": True}}}\n', input()));
    ok('после нехватки памяти среда продолжает работать', after.calc.out.ok === true);
    ok('предел Python в настройках — 512 МиБ', LIMITS.pythonMaxPages * 65536 === 512 * 1024 * 1024);
  }

  console.log(`Python, шаг 3: проверок ${passed}`);
}
main().catch(e => { console.error('✗', e); process.exit(1); });
