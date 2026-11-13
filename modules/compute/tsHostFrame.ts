/**
 * Хост логики TypeScript: страница `flux-module://_compute/ts.html` в скрытом iframe с `sandbox="allow-scripts"`
 * (непрозрачный источник). Отдельная страница, а не хост Python: CSP у неё строже — `connect-src 'none'`, без
 * `wasm-unsafe-eval` и без доступа к файлам Pyodide, так что у кода метода нет сети, хранилищ и IPC Flux.
 *
 * Единственный, кто с ней говорит, — окно Flux (родитель): оно присылает собранный JS логики из проверенного выпуска и
 * вход. Каждый вызов получает СВОЙ Worker, который завершается после ответа: состояния между вызовами нет. Предел
 * времени останавливает Worker завершением (`terminate`), а не просьбой остановиться.
 */
import { COMPUTE_ERROR_CODES, LIMITS } from '../engine/types';
import { WORKER_PROLOGUE } from '../runtime/prologue';

declare const __TS_WORKER__: string;

/** Одновременно живых Worker'ов; очередь окна Flux (до 4 расчётов) сюда столько и не пускает */
const MAX_WORKERS = 8;
const pending = new Map<string, { worker: Worker; timer: ReturnType<typeof setTimeout> }>();

const reply = (message: Record<string, unknown>) => parent.postMessage({ flux: 'compute-host', v: 1, ...message }, '*');

function settle(id: string, message: Record<string, unknown>) {
  const item = pending.get(id);
  if (!item) return;
  clearTimeout(item.timer); pending.delete(id);
  // Worker умирает вместе с вызовом: переменные логики и всё, что она накопила, не доживают до следующего
  item.worker.terminate();
  reply({ id, ...message });
}

function start(id: string, source: string, input: string, seed: unknown, timeoutMs: number) {
  const blob = URL.createObjectURL(new Blob([WORKER_PROLOGUE, __TS_WORKER__, '\n;', source], { type: 'text/javascript' }));
  const worker = new Worker(blob);
  URL.revokeObjectURL(blob);
  pending.set(id, { worker, timer: setTimeout(() => settle(id, { ok: false, code: 'TIMEOUT' }), timeoutMs) });
  worker.onmessage = ({ data }) => {
    if (data?.id !== id) return;
    if (data.type === 'done' && typeof data.output === 'string') settle(id, { ok: true, output: data.output });
    else settle(id, { ok: false, code: COMPUTE_ERROR_CODES.includes(data?.code) ? data.code : 'CRASH', detail: String(data?.detail || '').slice(0, 300) });
  };
  worker.onerror = () => settle(id, { ok: false, code: 'CRASH' });
  worker.onmessageerror = () => settle(id, { ok: false, code: 'CRASH' });
  worker.postMessage({ type: 'run', id, input, seed });
}

window.addEventListener('message', ({ source, data }) => {
  if (source !== parent || data?.flux !== 'compute-host' || data.v !== 1) return;
  if (data.op === 'stop') {
    for (const id of [...pending.keys()]) settle(id, { ok: false, code: 'DENIED' });
    reply({ id: data.id, ok: true, output: '' });
    return;
  }
  if (data.op !== 'run' || typeof data.id !== 'string' || pending.has(data.id)) return;
  if (typeof data.source !== 'string' || typeof data.input !== 'string' || data.source.length > LIMITS.tsFileBytes || data.input.length > LIMITS.inputBytes) {
    reply({ id: data.id, ok: false, code: 'BAD_INPUT' });
    return;
  }
  if (pending.size >= MAX_WORKERS) { reply({ id: data.id, ok: false, code: 'BUSY' }); return; }
  start(data.id, data.source, data.input, data.seed, Math.min(LIMITS.timeoutMs, Math.max(20, Number(data.timeoutMs) || LIMITS.timeoutMs)));
});

reply({ ready: true });
