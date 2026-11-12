/**
 * Окно Flux ↔ изолированный хост логики TypeScript (`flux-module://_compute/ts.html`, modules/compute/tsHostFrame.ts).
 *
 * Логика формы TypeScript живёт в iframe самой программы; сюда попадает только метод для других программ
 * (`flux.programs.call`) и контрольные примеры выпуска: чистая функция «JSON → JSON» из собранного `build/logic.js`.
 * Кадр создаётся при первом вызове и выгружается по простою (ModuleCompute). Очередь и пределы — в ModuleCompute,
 * здесь только DOM и связь с хостом.
 */
import { COMPUTE_ERROR_CODES, ComputeError, type ComputeErrorCode } from '../../modules/engine/types';
import { MODULE_SANDBOX } from '../../modules/protocol';
import type { TsRunner } from './moduleCompute';

const code = (value: unknown): ComputeErrorCode => COMPUTE_ERROR_CODES.includes(value as ComputeErrorCode) ? value as ComputeErrorCode : 'CRASH';

export function createTsRunner(): TsRunner {
  let frame: HTMLIFrameElement | null = null;
  let ready: Promise<HTMLIFrameElement> | null = null;
  const waiting = new Map<string, { resolve: (value: { output: string }) => void; reject: (error: ComputeError) => void; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0;

  function onMessage(event: MessageEvent) {
    // Только наш хост: тот же iframe и непрозрачный источник
    if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.flux !== 'compute-host') return;
    const data = event.data;
    const item = waiting.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); waiting.delete(data.id);
    if (data.ok && typeof data.output === 'string') item.resolve({ output: data.output });
    else item.reject(new ComputeError(code(data.code), String(data.detail || '')));
  }
  function unload() {
    window.removeEventListener('message', onMessage);
    frame?.remove(); frame = null; ready = null;
    for (const [id, item] of waiting) { clearTimeout(item.timer); item.reject(new ComputeError('DENIED', 'среда TypeScript выгружена')); waiting.delete(id); }
  }
  function open(): Promise<HTMLIFrameElement> {
    return ready ||= new Promise((resolve, reject) => {
      const created = document.createElement('iframe');
      created.setAttribute('sandbox', MODULE_SANDBOX);
      created.setAttribute('aria-hidden', 'true');
      created.tabIndex = -1;
      created.title = 'Среда TypeScript';
      created.dataset.testid = 'flux-ts-host';
      created.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
      const onReady = (event: MessageEvent) => {
        if (event.source !== created.contentWindow || event.origin !== 'null' || event.data?.flux !== 'compute-host' || event.data.ready !== true) return;
        window.removeEventListener('message', onReady); clearTimeout(giveUp);
        frame = created;
        window.addEventListener('message', onMessage);
        resolve(created);
      };
      const giveUp = setTimeout(() => { window.removeEventListener('message', onReady); created.remove(); ready = null; reject(new ComputeError('UNAVAILABLE', 'среда TypeScript не отвечает')); }, 15_000);
      window.addEventListener('message', onReady);
      created.src = 'flux-module://_compute/ts.html';
      document.body.append(created);
    });
  }
  return {
    get loaded() { return !!frame; },
    async run(source, input, seed, timeoutMs) {
      const host = await open();
      const id = `t-${++counter}`;
      return new Promise((resolve, reject) => {
        // Хост сам останавливает Worker по времени; это страховка на случай, если не ответил и он
        const timer = setTimeout(() => { unload(); reject(new ComputeError('TIMEOUT')); }, timeoutMs + 3000);
        waiting.set(id, { resolve, reject, timer });
        host.contentWindow!.postMessage({ flux: 'compute-host', v: 1, op: 'run', id, source, input, seed, timeoutMs }, '*');
      });
    },
    unload,
  };
}
