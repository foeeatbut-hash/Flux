/**
 * Настоящие Worker'ы и изолированный хост для ModuleCompute (в окне Flux).
 * Логика очереди и пределов — в src/services/moduleCompute.ts, здесь только DOM.
 */
import { ComputeScheduler, slotsFor } from '../../modules/engine/scheduler';
import { COMPUTE_ERROR_CODES, ComputeError, type ComputeErrorCode } from '../../modules/engine/types';
import { MODULE_SANDBOX } from '../../modules/protocol';
import { loadWasm, MemoryCompileCache } from '../../modules/engine/wasm';
import { SerialLane } from '../../modules/engine/serial';
import { ModuleCompute, type PythonRunner, type WasmRunner } from './moduleCompute';
import { recordModuleCrash } from './moduleCrashQueue';

/** Настройка «выгружать Python после N минут без вызовов»; хранится на компьютере человека */
export const PYTHON_IDLE_KEY = 'flux.modules.pythonIdleMinutes';
export const PYTHON_IDLE_DEFAULT = 5;
export function pythonIdleMinutes(): number {
  try {
    const value = Number(localStorage.getItem(PYTHON_IDLE_KEY));
    return Number.isFinite(value) && value >= 1 && value <= 240 ? Math.floor(value) : PYTHON_IDLE_DEFAULT;
  } catch { return PYTHON_IDLE_DEFAULT; }
}

const code = (value: unknown): ComputeErrorCode => COMPUTE_ERROR_CODES.includes(value as ComputeErrorCode) ? value as ComputeErrorCode : 'CRASH';

interface WasmWorker { worker: Worker; busy: boolean; known: Set<string> }

export function createWasmRunner(): WasmRunner {
  const pool: WasmWorker[] = [];
  // Один скомпилированный модуль на выпуск: Worker'ы получают его готовым, поэтому остановка Worker'а компиляции не требует
  const compiled = new MemoryCompileCache(16);
  const stats = { compiled: 0, cached: 0 };
  const spawn = (): WasmWorker => ({ worker: new Worker(new URL('../workers/moduleWasm.worker.ts', import.meta.url), { type: 'module' }), busy: false, known: new Set() });
  let counter = 0;
  return {
    get workers() { return pool.length; },
    stats,
    async run(fingerprint, bytes, input, seed, timeoutMs) {
      // Проверка файла и компиляция идут в окне, вне основного потока (V8 компилирует в фоне); ошибка — до очереди Worker'ов
      const loaded = await loadWasm(bytes, fingerprint, compiled);
      if (loaded.from === 'compiled') stats.compiled++; else stats.cached++;
      let entry = pool.find(item => !item.busy);
      if (!entry) { entry = spawn(); pool.push(entry); }
      const current = entry;
      current.busy = true;
      const id = `w-${++counter}`;
      return new Promise<{ output: string; from: 'cache' | 'compiled' }>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); current.worker.onmessage = null; current.worker.onerror = null; current.busy = false; };
        const kill = (error: ComputeError) => {
          finish(); current.worker.terminate();
          const at = pool.indexOf(current); if (at >= 0) pool.splice(at, 1);
          reject(error);
        };
        // Предел времени: бесконечный цикл в .wasm останавливается вместе с Worker, а не ждёт его
        const timer = setTimeout(() => kill(new ComputeError('TIMEOUT')), timeoutMs);
        current.worker.onerror = () => kill(new ComputeError('CRASH'));
        const send = (withBytes: boolean) => {
          // Готовый модуль уходит только Worker'у, который его ещё не знает
          current.worker.postMessage({ type: 'run', id, fingerprint, input, seed, ...(withBytes ? { module: loaded.module, info: loaded.info, abi: loaded.abi } : {}) });
        };
        current.worker.onmessage = ({ data }) => {
          if (data?.id !== id) return;
          if (data.type === 'done' && typeof data.output === 'string') { current.known.add(fingerprint); finish(); resolve({ output: data.output, from: loaded.from }); }
          else if (data?.detail === 'need-module' && current.known.delete(fingerprint)) send(true); // Worker забыл модуль — шлём заново
          else { finish(); reject(new ComputeError(code(data?.code), String(data?.detail || ''))); }
        };
        send(!current.known.has(fingerprint));
      });
    },
    stopAll() { for (const item of pool.splice(0)) item.worker.terminate(); },
    keepOnly(fingerprints) { void compiled.keepOnly(new Set(fingerprints)); },
  };
}

export function createPythonRunner(): PythonRunner {
  let frame: HTMLIFrameElement | null = null;
  let ready: Promise<HTMLIFrameElement> | null = null;
  // Строго по одному: следующий расчёт уходит в среду, только когда предыдущий закончился (в том числе остановкой по времени)
  const lane = new SerialLane();
  const waiting = new Map<string, { resolve: (value: any) => void; reject: (error: ComputeError) => void; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0;

  function onMessage(event: MessageEvent) {
    // Только наш хост: тот же iframe и непрозрачный источник
    if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.flux !== 'compute-host') return;
    const data = event.data;
    const item = waiting.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); waiting.delete(data.id);
    if (data.ok && typeof data.output === 'string') item.resolve({ output: data.output, bootMs: Number(data.bootMs) || 0 });
    else item.reject(new ComputeError(code(data.code), String(data.detail || '')));
  }
  function unload() {
    window.removeEventListener('message', onMessage);
    frame?.remove(); frame = null; ready = null;
    for (const [id, item] of waiting) { clearTimeout(item.timer); item.reject(new ComputeError('DENIED', 'среда Python выгружена')); waiting.delete(id); }
  }
  function open(): Promise<HTMLIFrameElement> {
    return ready ||= new Promise((resolve, reject) => {
      const created = document.createElement('iframe');
      created.setAttribute('sandbox', MODULE_SANDBOX);
      created.setAttribute('aria-hidden', 'true');
      created.tabIndex = -1;
      created.title = 'Среда Python';
      created.dataset.testid = 'flux-python-host';
      created.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
      const onReady = (event: MessageEvent) => {
        if (event.source !== created.contentWindow || event.origin !== 'null' || event.data?.flux !== 'compute-host' || event.data.ready !== true) return;
        window.removeEventListener('message', onReady); clearTimeout(giveUp);
        frame = created;
        window.addEventListener('message', onMessage);
        resolve(created);
      };
      const giveUp = setTimeout(() => { window.removeEventListener('message', onReady); created.remove(); ready = null; reject(new ComputeError('UNAVAILABLE', 'среда Python не отвечает')); }, 15_000);
      window.addEventListener('message', onReady);
      created.src = 'flux-module://_compute/index.html';
      document.body.append(created);
    });
  }
  return {
    get loaded() { return !!frame; },
    get queued() { return lane.pending; },
    run(key, source, input, seed, timeoutMs) { return lane.run(() => send(key, source, input, seed, timeoutMs)); },
    unload,
  };
  async function send(key: string, source: string, input: string, seed: number, timeoutMs: number): Promise<{ output: string; bootMs: number }> {
      const host = await open();
      const id = `p-${++counter}`;
      return new Promise((resolve, reject) => {
        // Хост сам останавливает Worker по времени; это страховка на случай, если не ответил и он
        const timer = setTimeout(() => { unload(); reject(new ComputeError('TIMEOUT')); }, timeoutMs + 3000);
        waiting.set(id, { resolve, reject, timer });
        host.contentWindow!.postMessage({ flux: 'compute-host', v: 1, op: 'run', id, key, source, input, seed, timeoutMs }, '*');
      });
  }
}

let shared: ModuleCompute | null = null;
/** Одна на окно Flux: очередь и пределы общие для всех программ */
export function moduleCompute(): ModuleCompute {
  return shared ||= new ModuleCompute({
    scheduler: new ComputeScheduler({
      slots: slotsFor(navigator.hardwareConcurrency || 2),
      laneLimits: { python: 1 },
      // Фоновый расчёт ждёт паузы в работе окна, чтобы не отнимать кадры у человека
      waitIdle: () => new Promise<void>(resolve => {
        const idle = (window as any).requestIdleCallback as undefined | ((fn: () => void, options?: { timeout: number }) => void);
        if (idle) idle(() => resolve(), { timeout: 2000 }); else setTimeout(resolve, 0);
      }),
    }),
    wasm: createWasmRunner(),
    python: createPythonRunner(),
    fetchFile: async (moduleId, file) => {
      const response = await fetch(`flux-module://${encodeURIComponent(moduleId)}/${file}`);
      if (!response.ok) throw new Error(String(response.status));
      return new Uint8Array(await response.arrayBuffer());
    },
    sha256: async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''),
    pythonIdleMinutes,
    onFailure: (moduleId, version, kind) => recordModuleCrash(moduleId, version, kind),
  });
}

/** Закрыта программа: очередь не хранит её расчёты. Среду не создаёт, если она ещё не нужна */
export function cancelModuleCompute(moduleId: string) { shared?.cancel(moduleId); }
/** Список выпусков в кэше проверенных изменился: убрать источники и скомпилированные модули ушедших */
export function retainModuleCompute(cached: ReadonlyArray<{ moduleId: string; version: string }>) {
  void shared?.retain(new Set(cached.map(item => `${item.moduleId}@${item.version}`)));
}
