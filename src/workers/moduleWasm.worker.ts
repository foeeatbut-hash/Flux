/**
 * Worker исполнения WebAssembly подпрограмм. Живёт в окне Flux (не в iframe
 * подпрограммы). Безопасно это потому, что .wasm по построению не получает
 * ничего, кроме импортов Flux (modules/engine/wasm.ts): ни fetch, ни
 * postMessage, ни IPC ему недоступны. Сам Worker не отдаёт модулю ни одного
 * объекта среды.
 *
 * Компилирует не Worker, а окно (src/services/moduleComputeHost.ts): скомпилированный
 * модуль один на выпуск и передаётся в любой Worker — после остановки по времени
 * или выгрузки по простою повторная компиляция не нужна.
 */
import { runWasm, type LoadedWasm } from '../../modules/engine/wasm';
import { ComputeError } from '../../modules/engine/types';

// В самом Worker помнится несколько последних модулей: повторный расчёт не читает диск
const loaded = new Map<string, LoadedWasm>();

self.onmessage = async ({ data }: MessageEvent) => {
  const reply = (message: Record<string, unknown>) => (self as unknown as Worker).postMessage({ id: data?.id, ...message });
  try {
    if (data?.type !== 'run' || typeof data.fingerprint !== 'string') return;
    let module = loaded.get(data.fingerprint);
    if (!module) {
      if (!data.module) throw new ComputeError('UNAVAILABLE', 'need-module');
      module = { module: data.module, info: data.info, abi: data.abi, from: 'cache' };
      if (loaded.size >= 4) loaded.delete(loaded.keys().next().value as string);
      loaded.set(data.fingerprint, module);
    }
    reply({ type: 'done', output: await runWasm(module, String(data.input), { seed: Number(data.seed) || 0 }) });
  } catch (error) {
    reply({ type: 'failed', code: error instanceof ComputeError ? error.code : 'CRASH', detail: error instanceof Error ? error.message.slice(0, 300) : '' });
  }
};
