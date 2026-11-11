/**
 * Рабочий поток одного контрольного расчёта (собирается отдельным файлом: studio/build-assets.cjs).
 *
 * Расчёт идёт в отдельном потоке, чтобы бесконечный цикл или раздутая память разработчика
 * остановил главный процесс, а не зависла Studio. Поток живёт один расчёт.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ComputeError } from '../../modules/engine/types';
import { loadWasm, runWasm } from '../../modules/engine/wasm';

interface Job { kind: 'typescript' | 'wasm'; code?: string; bytes?: Uint8Array; input: string; seed: number }

async function run(job: Job): Promise<string> {
  if (job.kind === 'wasm') {
    const loaded = await loadWasm(job.bytes!, 'controls');
    return runWasm(loaded, job.input, { seed: job.seed });
  }
  // Логика TypeScript приходит уже переведённой в CommonJS (studio/shared/logicSource.ts)
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', job.code!)(module, module.exports);
  const compute = module.exports.compute;
  if (typeof compute !== 'function') throw new ComputeError('ABI', 'в logic/main.ts нет функции compute');
  return JSON.stringify(await (compute as (input: unknown) => unknown)(JSON.parse(job.input)));
}

run(workerData as Job).then(
  output => parentPort!.postMessage({ ok: true, output }),
  error => parentPort!.postMessage({ ok: false, code: error instanceof ComputeError ? error.code : 'CRASH', detail: String(error?.message || error).slice(0, 300) }),
);
