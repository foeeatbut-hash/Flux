// Окно-хост для проверки логики TypeScript в настоящем Chromium: настоящий ModuleCompute и настоящий createTsRunner
// вокруг настоящего изолированного кадра ts.html (его отдаёт проверка с теми же заголовками CSP, что electron/modules.ts).
import { ModuleCompute } from '../../src/services/moduleCompute';
import { createTsRunner } from '../../src/services/moduleComputeTsHost';
import { ComputeScheduler } from '../../modules/engine/scheduler';

const sources = new Map<string, string>();
const failures: string[] = [];
const runner = createTsRunner('/_compute/');
const compute = new ModuleCompute({
  scheduler: new ComputeScheduler({ slots: 4, laneLimits: { python: 1 } }),
  wasm: { workers: 0, stopAll() {}, keepOnly() {}, async run() { throw new Error('нет'); } },
  python: { loaded: false, unload() {}, async run() { throw new Error('нет'); } },
  ts: runner,
  fetchFile: async (id, file) => {
    const text = sources.get(id);
    if (text === undefined || file !== 'logic.js') throw new Error('нет файла');
    return new TextEncoder().encode(text);
  },
  sha256: async () => 'f'.repeat(64),
  pythonIdleMinutes: () => 5,
  onFailure: (id, version, kind) => { failures.push(`${id}@${version}:${kind}`); },
});

(window as any).__h = {
  setLogic(id: string, text: string) { sources.set(id, text); },
  async call(id: string, input: unknown, timeoutMs?: number) {
    const started = performance.now();
    try {
      const output = await compute.compute({ moduleId: id, version: '1.0.0', language: 'typescript' }, input, 'active', timeoutMs ? { timeoutMs } : {});
      return { ok: true, output, ms: Math.round(performance.now() - started) };
    } catch (error: any) {
      return { ok: false, code: String(error?.code), message: String(error?.message), ms: Math.round(performance.now() - started) };
    }
  },
  /** Хост напрямую, мимо ModuleCompute: проверка его собственных пределов */
  async direct(source: string, input: string, timeoutMs = 2000) {
    try { return { ok: true, output: (await runner.run(source, input, 0, timeoutMs)).output }; }
    catch (error: any) { return { ok: false, code: String(error?.code) }; }
  },
  frames: () => document.querySelectorAll('iframe[data-testid="flux-ts-host"]').length,
  failures: () => failures.slice(),
  dispose: () => compute.dispose(),
};
