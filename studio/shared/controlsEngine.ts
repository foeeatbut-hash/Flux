/**
 * Контрольные примеры в Studio: каждый расчёт — в отдельном рабочем потоке с пределами.
 *
 * Время: поток останавливается по таймеру (LIMITS.timeoutMs во Flux; в проверках меньше).
 * Память: у JavaScript — предел кучи потока, у WebAssembly — максимум в самом файле
 * (его проверяет wasmProblem до запуска). Python в Studio не исполняется: общая среда
 * Pyodide лежит во Flux, поэтому Python-пример на этом компьютере проверяет сам Flux
 * при первом запуске выпуска (electron/moduleControls.ts), а Studio честно пишет об этом
 * в отчёте.
 */
import { Worker } from 'node:worker_threads';
import { runControls, parseControls, type ControlsReport } from '../../modules/engine/controls';
import { ComputeError, LIMITS, type ComputeErrorCode, type ModuleLanguage } from '../../modules/engine/types';
import { parseComputeOutput } from '../../modules/engine/json';
import { encodeJson } from '../../modules/engine/json';
import type { ModuleOutput } from '../../modules/contract';
import { compileLogic } from './logicSource';
import type { ProjectFiles } from './templates';

export interface ControlsOutcome { kind: 'done'; report: ControlsReport; cases: number; slowestMs: number }
export interface ControlsUnavailable { kind: 'unavailable'; reason: string }
export interface ControlsEngine {
  /** Один расчёт для запуска подпрограммы на WebAssembly: вход → выход, с теми же пределами */
  compute(language: ModuleLanguage, files: ProjectFiles, logicPath: string, input: unknown): Promise<ModuleOutput>;
  run(language: ModuleLanguage, files: ProjectFiles, logicPath: string, controlsText: string): Promise<ControlsOutcome | ControlsUnavailable | { kind: 'invalid'; reason: string }>;
}

export function createControlsEngine(options: { workerFile: string; timeoutMs?: number; maxHeapMb?: number }): ControlsEngine {
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const runCase = (job: Record<string, unknown>): Promise<string> => new Promise((resolve, reject) => {
    const worker = new Worker(options.workerFile, {
      workerData: job, resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb ?? 256, maxYoungGenerationSizeMb: 32 },
    });
    const fail = (code: ComputeErrorCode, detail = '') => { clearTimeout(timer); void worker.terminate(); reject(new ComputeError(code, detail)); };
    const timer = setTimeout(() => fail('TIMEOUT', `больше ${Math.round(timeoutMs / 1000)} с`), timeoutMs);
    worker.once('message', (m: { ok: boolean; output?: string; code?: ComputeErrorCode; detail?: string }) => {
      clearTimeout(timer); void worker.terminate();
      if (m.ok) resolve(String(m.output)); else reject(new ComputeError(m.code || 'CRASH', m.detail || ''));
    });
    worker.once('error', (error: any) => fail(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'MEMORY' : 'CRASH', String(error?.message || '').slice(0, 200)));
    worker.once('exit', code => { if (code !== 0) fail('CRASH', `поток завершился с кодом ${code}`); });
  });

  /** Задание для рабочего потока: JS переводится в CommonJS, WebAssembly уходит байтами */
  const job = (language: ModuleLanguage, files: ProjectFiles, logicPath: string, input: unknown) => {
    const logic = files[logicPath];
    if (!logic) throw new ComputeError('UNAVAILABLE', `нет файла логики ${logicPath}`);
    if (language === 'python') throw new ComputeError('UNAVAILABLE', 'Python в Studio не исполняется');
    let code = '';
    if (language === 'typescript') {
      const compiled = compileLogic(Buffer.from(logic).toString('utf8'), logicPath);
      if (compiled.problem) throw new ComputeError('ABI', compiled.problem);
      code = compiled.code;
    }
    return { kind: language === 'wasm' ? 'wasm' : 'typescript', code, bytes: language === 'wasm' ? logic : undefined, input: encodeJson(input), seed: 0 };
  };

  return {
    async compute(language, files, logicPath, input) {
      return parseComputeOutput(await runCase(job(language, files, logicPath, input))) as ModuleOutput;
    },
    async run(language, files, logicPath, controlsText) {
      const controls = parseControls(controlsText);
      if (typeof controls === 'string') return { kind: 'invalid', reason: controls };
      if (language === 'python') return { kind: 'unavailable', reason: 'Python исполняет общая среда Flux; Studio её не содержит. Примеры проверит Flux при первом запуске выпуска.' };
      try { job(language, files, logicPath, {}); }
      catch (e: any) { return { kind: 'invalid', reason: String(e?.message || e).replace(/^[A-Z_]+: /, '') }; }
      let slowestMs = 0;
      const report = await runControls(controls, async input => {
        const started = Date.now();
        try {
          return parseComputeOutput(await runCase(job(language, files, logicPath, input)));
        } finally { slowestMs = Math.max(slowestMs, Date.now() - started); }
      });
      return { kind: 'done', report, cases: controls.cases.length, slowestMs };
    },
  };
}
