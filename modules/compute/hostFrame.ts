/**
 * Хост общей среды Python: страница `flux-module://_compute/` в скрытом iframe
 * с `sandbox="allow-scripts"` (непрозрачный источник), без сети и хранилищ.
 *
 * Единственный, кто с ней говорит, — окно Flux (родитель): оно присылает
 * исходник программы, взятый из проверенного выпуска, и вход расчёта.
 * Программы напрямую сюда не пишут: у них свой iframe и своя связь с окном.
 *
 * Время и перезапуск: на каждый расчёт ставится предел; по его истечении
 * Worker с Pyodide останавливается целиком и пересоздаётся при следующем
 * вызове (сбой одной программы не мешает другим — они подгружаются заново).
 */
import { COMPUTE_ERROR_CODES, LIMITS, type ComputeErrorCode } from '../engine/types';

declare const __PYTHON_WORKER__: string;
const PYODIDE_BASE = new URL('./pyodide/', location.href).href;

let worker: Worker | null = null;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

const reply = (message: Record<string, unknown>) => parent.postMessage({ flux: 'compute-host', v: 1, ...message }, '*');

function stop(reason: ComputeErrorCode) {
  worker?.terminate(); worker = null;
  // Все, кто ждал убитую среду, получают причину; повторять или нет — решает окно Flux
  for (const [id, item] of pending) { clearTimeout(item.timer); reply({ id, ok: false, code: reason }); }
  pending.clear();
}

function spawn(): Worker {
  const blob = URL.createObjectURL(new Blob([__PYTHON_WORKER__], { type: 'text/javascript' }));
  const created = new Worker(blob);
  URL.revokeObjectURL(blob);
  created.onmessage = ({ data }) => {
    const item = pending.get(data?.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.type === 'done' && typeof data.output === 'string') reply({ id: data.id, ok: true, output: data.output, bootMs: Number(data.bootMs) || 0 });
    else reply({ id: data.id, ok: false, code: COMPUTE_ERROR_CODES.includes(data.code) ? data.code : 'CRASH', detail: String(data.detail || '').slice(0, 300) });
  };
  created.onerror = () => { if (worker === created) stop('CRASH'); };
  return created;
}

window.addEventListener('message', ({ source, data }) => {
  if (source !== parent || data?.flux !== 'compute-host' || data.v !== 1) return;
  if (data.op === 'stop') { stop('CRASH'); reply({ id: data.id, ok: true, output: '' }); return; }
  if (data.op !== 'run' || typeof data.id !== 'string' || pending.has(data.id) || pending.size >= 4) return;
  if (typeof data.source !== 'string' || typeof data.input !== 'string' || typeof data.key !== 'string'
    || data.source.length > LIMITS.pythonFileBytes || data.input.length > LIMITS.inputBytes) {
    reply({ id: data.id, ok: false, code: 'BAD_INPUT' });
    return;
  }
  const timeout = Math.min(LIMITS.timeoutMs, Math.max(50, Number(data.timeoutMs) || LIMITS.timeoutMs));
  const id = data.id as string;
  worker ||= spawn();
  pending.set(id, { timer: setTimeout(() => stop('TIMEOUT'), timeout) });
  worker.postMessage({ type: 'run', id, key: data.key, source: data.source, input: data.input, seed: data.seed, base: PYODIDE_BASE });
});

reply({ ready: true });
