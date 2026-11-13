// Окно-хост для проверки вызова программа → программа на настоящих движках в обычном Chromium: настоящие createProgramCaller и
// ModuleCompute вокруг настоящих хостов Python (Pyodide), WebAssembly (Worker) и TypeScript (изолированный кадр).
// Главный процесс (ModuleProgramCalls) живёт в Node и вызывается через `__invoke` — как IPC окна во Flux; файлы логики отдаёт
// проверка из подписанных выпусков по /files/<программа>/<файл>.
import { ModuleCompute } from '../../src/services/moduleCompute';
import { createPythonRunner, createWasmRunner } from '../../src/services/moduleComputeHost';
import { createTsRunner } from '../../src/services/moduleComputeTsHost';
import { createProgramCaller } from '../../src/services/moduleProgramCall';
import { ComputeScheduler } from '../../modules/engine/scheduler';
import { languageOf } from '../../modules/engine/types';
import type { ModuleManifest } from '../../modules/contract';

const failures: string[] = [];
let timeoutMs: number | undefined;
const compute = new ModuleCompute({
  scheduler: new ComputeScheduler({ slots: 4, laneLimits: { python: 1 } }),
  wasm: createWasmRunner(() => new Worker('/wasm-worker.js')),
  python: createPythonRunner('/_compute/'),
  ts: createTsRunner('/_compute/'),
  fetchFile: async (id, file) => {
    const response = await fetch(`/files/${id}/${file}`);
    if (!response.ok) throw new Error(String(response.status));
    return new Uint8Array(await response.arrayBuffer());
  },
  sha256: async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''),
  pythonIdleMinutes: () => 5,
  onFailure: (id, version, kind) => { failures.push(`${id}@${version}:${kind}`); },
});

const invoke = (channel: string, data: unknown) => (window as any).__invoke(channel, data);

(window as any).__h = {
  /** Одно обращение настоящим createProgramCaller; `limitMs` сужает предел расчёта метода, чтобы остановка по времени не ждала минуту */
  async call(caller: { moduleId: string; version: string }, program: string, method: string, data: unknown, limitMs?: number) {
    timeoutMs = limitMs;
    const started = performance.now();
    const call = createProgramCaller(caller, () => ({
      invoke,
      compute: (target, input) => compute.compute(target, input, 'active', timeoutMs ? { timeoutMs } : {}),
      // Контрольные примеры вызываемой — на настоящем движке, тем же путём, что при первом запуске программы
      controls: async (manifest: ModuleManifest) => {
        try { return (await compute.controls({ moduleId: manifest.id, version: manifest.version, language: languageOf(manifest) })).ok ? 'ok' : 'failed'; }
        catch { return 'retry'; }
      },
    }));
    const reply = await call({ program, method, data } as never);
    return { reply, ms: Math.round(performance.now() - started) };
  },
  failures: () => failures.slice(),
  dispose: () => compute.dispose(),
};
