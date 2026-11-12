/**
 * Рабочий поток сборки TypeScript (собирается отдельным файлом: studio/build-assets.cjs).
 *
 * Компилятор esbuild-wasm запускается в отдельном потоке: тяжёлая или зависшая сборка не останавливает окно Studio,
 * а главный процесс может прервать поток по времени. Wasm-файл лежит рядом с приложением и читается с диска,
 * интернет не нужен. Поток живёт одну сборку.
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import * as esbuild from 'esbuild-wasm';
import { runTsBuild } from './tsBuild';

interface Job { files: Record<string, Uint8Array>; wasmFile: string }

async function run(job: Job) {
  // Браузерная сборка esbuild-wasm ищет глобальное self; в потоке Node его нет
  (globalThis as { self?: unknown }).self ??= globalThis;
  await esbuild.initialize({ wasmModule: await WebAssembly.compile(fs.readFileSync(job.wasmFile)), worker: false } as never);
  return runTsBuild(esbuild as never, job.files);
}

run(workerData as Job).then(
  result => parentPort!.postMessage({ ok: true, result }),
  error => parentPort!.postMessage({ ok: false, detail: String(error?.message || error).slice(0, 300) }),
);
