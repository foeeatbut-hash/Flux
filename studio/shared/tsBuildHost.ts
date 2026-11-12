/**
 * Запуск сборки TypeScript в рабочем потоке (см. tsBuildWorker.ts).
 *
 * Поток один на сборку и ограничен по времени и памяти: зависшая или раздутая сборка превращается в понятную
 * проблему в списке, а не в зависшую Studio.
 */
import { Worker } from 'node:worker_threads';
import type { ProjectFiles } from './templates';
import type { TsBuildResult } from './tsBuild';

export interface TsBuilder { build(files: ProjectFiles): Promise<TsBuildResult> }

export function createTsBuilder(options: { workerFile: string; wasmFile: string; timeoutMs?: number }): TsBuilder {
  const limit = options.timeoutMs ?? 60_000;
  return {
    build(files) {
      return new Promise<TsBuildResult>(resolve => {
        const fail = (text: string) => resolve({ ok: false, problems: [{ path: '', line: 0, column: 0, text }], outputs: {}, entries: [] });
        const worker = new Worker(options.workerFile, { workerData: { files, wasmFile: options.wasmFile }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
        let done = false;
        const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); fn(); };
        const timer = setTimeout(() => finish(() => fail(`Сборка не уложилась в ${Math.round(limit / 1000)} с и остановлена.`)), limit);
        worker.once('message', (m: { ok: boolean; result?: TsBuildResult; detail?: string }) => finish(() => m.ok && m.result ? resolve(m.result) : fail(`Сборка не запустилась: ${m.detail || 'неизвестная причина'}`)));
        worker.once('error', error => finish(() => fail(`Сборка прервана: ${String(error?.message || error).slice(0, 200)}`)));
        worker.once('exit', code => finish(() => fail(`Сборка прервана (код ${code}).`)));
      });
    },
  };
}
