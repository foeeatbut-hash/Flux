/**
 * Рабочий поток одного контрольного расчёта (собирается отдельным файлом: studio/build-assets.cjs).
 *
 * Расчёт идёт в отдельном потоке, чтобы бесконечный цикл или раздутая память разработчика
 * остановил главный процесс, а не зависла Studio. Поток живёт один расчёт.
 */
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';
import { ComputeError } from '../../modules/engine/types';
import { loadWasm, runWasm } from '../../modules/engine/wasm';

interface Job { kind: 'typescript' | 'wasm'; code?: string; bytes?: Uint8Array; input: string; seed: number }

async function run(job: Job): Promise<string> {
  if (job.kind === 'wasm') {
    const loaded = await loadWasm(job.bytes!, 'controls');
    return runWasm(loaded, job.input, { seed: job.seed });
  }
  // Логика TypeScript приходит уже переведённой в CommonJS (studio/shared/logicSource.ts). Исполняется в пустом контексте vm:
  // ни process, ни require, ни fetch, ни import() там нет — как у хоста логики во Flux (без сети и без файлов). Контекст создаётся
  // из объекта без прототипа и ничего из этого потока в него не передаётся: любой переданный объект открыл бы путь наружу
  // через `.constructor.constructor`. Вход и выход — строки JSON.
  const context = vm.createContext(Object.create(null));
  const call = vm.runInContext(
    `(function(){var module={exports:{}},exports=module.exports;${job.code!}\n;var c=module.exports.compute;`
    + 'return typeof c==="function"?function(t){return Promise.resolve(c(JSON.parse(t))).then(function(v){return JSON.stringify(v)})}:null})()',
    context,
  ) as ((input: string) => Promise<string>) | null;
  if (!call) throw new ComputeError('ABI', 'в logic/main.ts нет функции compute');
  return call(job.input);
}

run(workerData as Job).then(
  output => parentPort!.postMessage({ ok: true, output }),
  error => parentPort!.postMessage({ ok: false, code: error instanceof ComputeError ? error.code : 'CRASH', detail: String(error?.message || error).slice(0, 300) }),
);
