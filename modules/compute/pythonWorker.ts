/**
 * Worker общей среды Python. Запускается ВНУТРИ изолированного хоста
 * (modules/compute/hostFrame.ts): iframe с непрозрачным источником, CSP без
 * сети. Здесь нет ни cookie, ни localStorage, ни IPC Flux; файлы Pyodide
 * загружаются со своего же адреса `flux-module://_compute/pyodide/`.
 *
 * Это классический скрипт (importScripts), собираемый esbuild в одну строку.
 */
import { PythonEnvironment, clampWasmMemory, type PyodideApi } from '../engine/python';
import { ComputeError, LIMITS } from '../engine/types';
import { lockNestedWorkers } from '../runtime/prologue';

// До загрузки Pyodide и кода подпрограммы: `js.Worker` из Python не должен создавать Worker'ы вне очереди
lockNestedWorkers();

declare function importScripts(...urls: string[]): void;
declare const loadPyodide: (options: Record<string, unknown>) => Promise<PyodideApi>;

let booting: Promise<PythonEnvironment> | null = null;

function boot(base: string): Promise<PythonEnvironment> {
  return booting ||= (async () => {
    // Максимум памяти Pyodide подменяется до загрузки и возвращается после: чужой WebAssembly в этом Worker не создаётся
    const restore = clampWasmMemory(LIMITS.pythonMaxPages);
    try {
      importScripts(`${base}pyodide.js`);
      const py = await loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
      return new PythonEnvironment(py);
    } finally { restore(); }
  })().catch(error => { booting = null; throw error; });
}

(self as unknown as Worker).onmessage = async ({ data }: MessageEvent) => {
  if (data?.type !== 'run' || typeof data.id !== 'string') return;
  const post = (message: Record<string, unknown>) => (self as unknown as Worker).postMessage({ id: data.id, ...message });
  try {
    const started = performance.now();
    const fresh = !booting;
    const env = await boot(String(data.base));
    const bootMs = fresh ? Math.round(performance.now() - started) : 0;
    const output = await env.run(String(data.key), String(data.source), String(data.input), Number(data.seed) || 0);
    post({ type: 'done', output, bootMs });
  } catch (error) {
    post({ type: 'failed', code: error instanceof ComputeError ? error.code : 'CRASH', detail: error instanceof Error ? error.message.slice(0, 300) : '' });
  }
};
