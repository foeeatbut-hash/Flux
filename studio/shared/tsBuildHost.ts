/**
 * Запуск сборки TypeScript в рабочих потоках (см. tsBuildWorker.ts и tsTypeWorker.ts).
 *
 * Две части идут параллельно: esbuild-wasm (синтаксис и подключения; поток на каждую сборку) и сверка типов компилятором
 * TypeScript (постоянный поток: программа и разобранные файлы кэшируются между сборками). Оба потока ограничены по времени
 * и памяти: зависшая или раздутая сборка превращается в понятную проблему в списке, а не в зависшую Studio.
 */
import { Worker } from 'node:worker_threads';
import type { ProjectFiles } from './templates';
import { tsEntries, type TsBuildResult, type TsProblem } from './tsBuild';
import { fluxPageTypes, FLUX_TYPES_FILE } from '../../modules/page/types';

export interface TsBuilder {
  build(files: ProjectFiles): Promise<TsBuildResult>;
  /** Заранее поднять поток сверки типов (разбор стандартной библиотеки занимает секунды): первая «Собрать» идёт быстрее */
  warm?(): void;
  /** Остановить постоянный поток (закрытие программы, конец проверки) */
  close?(): void;
}

/** Описание flux.* для страницы, у которой нет своего types/flux.d.ts: тот же текст, что Studio кладёт в новый проект-страницу */
const ambientTypes = (files: ProjectFiles): Record<string, string> =>
  !(FLUX_TYPES_FILE in files) && Object.keys(files).some(path => path.startsWith('ui/')) ? { [FLUX_TYPES_FILE]: fluxPageTypes() } : {};

const IDLE_MS = 10 * 60_000;

/** Постоянный поток сверки типов: один запрос за раз, по времени и по простою останавливается и поднимается заново */
function createTypeRunner(file: string, limit: number) {
  let worker: Worker | null = null;
  let ready = Promise.resolve();
  let idle: NodeJS.Timeout | undefined;
  let seq = 0;
  const stop = () => { clearTimeout(idle); const w = worker; worker = null; if (w) void w.terminate(); };
  const start = () => {
    if (worker) return worker;
    const w = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    // Поток не должен удерживать программу открытой
    w.unref();
    worker = w;
    return w;
  };
  const run = (files: ProjectFiles): Promise<TsProblem[]> => new Promise<TsProblem[]>((resolve, reject) => {
    const w = start();
    const id = ++seq;
    let done = false;
    const finish = (fn: () => void, kill = false) => {
      if (done) return;
      done = true; clearTimeout(timer); w.off('message', onMessage); w.off('error', onError); w.off('exit', onExit);
      if (kill && worker === w) stop();
      clearTimeout(idle); idle = setTimeout(stop, IDLE_MS); idle.unref();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`Сверка типов не уложилась в ${Math.max(1, Math.round(limit / 1000))} с и остановлена.`)), true), limit);
    const onMessage = (m: { id: number; ok: boolean; problems?: TsProblem[]; detail?: string }) => {
      if (m.id !== id) return;
      finish(() => m.ok ? resolve(m.problems || []) : reject(new Error(`Сверка типов не запустилась: ${m.detail || 'неизвестная причина'}`)));
    };
    const onError = (error: Error) => finish(() => reject(new Error(`Сверка типов прервана: ${String(error?.message || error).slice(0, 200)}`)), true);
    const onExit = (code: number) => finish(() => reject(new Error(`Сверка типов прервана (код ${code}).`)), true);
    w.on('message', onMessage); w.on('error', onError); w.on('exit', onExit);
    w.postMessage({ id, files, ambient: ambientTypes(files) });
  });
  return {
    // Запросы идут по очереди: программа компилятора одна, параллельные сверки одного проекта ей только мешают
    check(files: ProjectFiles) { const next = ready.then(() => run(files)); ready = next.then(() => undefined, () => undefined); return next; },
    warm() { void this.check({}).catch(() => undefined); },
    close: stop,
  };
}

export function createTsBuilder(options: { workerFile: string; wasmFile: string; typesWorkerFile: string; timeoutMs?: number; typeTimeoutMs?: number }): TsBuilder {
  const limit = options.timeoutMs ?? 60_000;
  const types = createTypeRunner(options.typesWorkerFile, options.typeTimeoutMs ?? 45_000);
  const failed = (text: string): TsBuildResult => ({ ok: false, problems: [{ path: '', line: 0, column: 0, text }], outputs: {}, entries: [] });

  const bundle = (files: ProjectFiles) => new Promise<TsBuildResult>(resolve => {
    const worker = new Worker(options.workerFile, { workerData: { files, wasmFile: options.wasmFile }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const timer = setTimeout(() => finish(() => resolve(failed(`Сборка не уложилась в ${Math.round(limit / 1000)} с и остановлена.`))), limit);
    worker.once('message', (m: { ok: boolean; result?: TsBuildResult; detail?: string }) => finish(() => m.ok && m.result ? resolve(m.result) : resolve(failed(`Сборка не запустилась: ${m.detail || 'неизвестная причина'}`))));
    worker.once('error', error => finish(() => resolve(failed(`Сборка прервана: ${String(error?.message || error).slice(0, 200)}`))));
    worker.once('exit', code => finish(() => resolve(failed(`Сборка прервана (код ${code}).`))));
  });

  return {
    async build(files) {
      // Сверка типов стартует вместе со сборкой: время — наибольшее из двух, а не сумма
      const typed = tsEntries(files).length
        ? types.check(files).then(list => ({ list, error: '' }), (error: Error) => ({ list: [] as TsProblem[], error: error.message }))
        : Promise.resolve({ list: [] as TsProblem[], error: '' });
      const built = await bundle(files);
      const { list, error } = await typed;
      // Синтаксическую ошибку уже назвала сборка: ту же строку от компилятора типов второй раз не показываем
      const seen = new Set(built.problems.map(p => `${p.path}\0${p.line}`));
      const problems = [...built.problems, ...list.filter(p => !seen.has(`${p.path}\0${p.line}`))];
      if (error) problems.push({ path: '', line: 0, column: 0, text: error });
      return { ok: problems.length === 0, problems, outputs: problems.length ? {} : built.outputs, entries: built.entries };
    },
    warm: () => types.warm(),
    close: () => types.close(),
  };
}
