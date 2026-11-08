import type {
  BridgeError, ComputeHostMessage, HostMessage, LaunchContext, ModuleManifest, ModuleOutput, ReadData,
  ReadRequest, Resource, ThemeTokens, ModuleFailureKind,
} from './contract';
import { validMessage } from './schemas';
import { ComputeError, codeOf, type ComputeErrorCode } from './engine/types';
import { encodeJson } from './engine/json';

export interface ModuleBridgeOptions {
  frame: () => Window | null;
  session: string;
  manifest: ModuleManifest;
  context: () => LaunchContext;
  theme: () => ThemeTokens;
  read: <R extends Resource>(resource: R, entityId?: string) => Promise<ReadData[R]>;
  beginReadCycle?: () => void;
  onFailure?: (kind: ModuleFailureKind) => void;
  /**
   * Расчёт логики на Python или WebAssembly (src/services/moduleCompute.ts). Язык и файл выбирает
   * не подпрограмма, а подписанный манифест: подпрограмма присылает только вход.
   */
  compute?: (input: Record<string, unknown>) => Promise<ModuleOutput>;
  /** Расчёт закончился ошибкой: окно показывает «подпрограмма остановилась»; счётчик сбоев пишет сам расчёт */
  onComputeError?: (code: ComputeErrorCode) => void;
}

function messageBytes(message: unknown): number {
  // Лимит задан в байтах: строка с кириллицей не должна занимать вдвое
  // больше разрешённого только потому, что JS считает UTF-16 символы.
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}
function writeLike(message: Record<string, unknown>): boolean {
  const verb = /(?:^|[.:_-])(?:set[a-z0-9]*|write|create|update|patch|delete|remove|save|insert|put|upsert|rename|mutate)(?:$|[.:_-])/i;
  return [message.type, message.op].some(value => typeof value === 'string' && verb.test(value.replace(/([a-z0-9])([A-Z])/g, '$1-$2')))
    || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(message.method || '').toUpperCase());
}

export function createModuleBridge(options: ModuleBridgeOptions) {
  let disposed = false;
  let generation = 0;
  let ready = false;
  const pending = new Set<string>();
  let budget = 100;
  let budgetAt = Date.now();
  const computing = new Set<string>();
  function post(message: HostMessage | ComputeHostMessage) {
    if (!disposed && validMessage(message.type, message)) {
      // Получатель — только сохранённое окно iframe. Его opaque origin
      // нельзя указать строкой targetOrigin, поэтому здесь нужен '*'.
      options.frame()?.postMessage(message, '*');
    }
  }
  const error = (id: string, code: BridgeError) => {
    if (code !== 'NO_PROJECT') options.onFailure?.('bridge');
    post({ flux: 'module', v: 1, session: options.session, type: 'error', id, code });
  };
  async function runCompute(message: { id: string; input: Record<string, unknown> }) {
    const fail = (code: ComputeErrorCode) => post({ flux: 'module', v: 1, session: options.session, type: 'compute-error', id: message.id, code });
    if (!options.compute) { fail('UNAVAILABLE'); return; }
    if (computing.size >= 4 || computing.has(message.id)) { fail('BUSY'); return; }
    const epoch = generation;
    computing.add(message.id);
    try {
      // Числа проверяются здесь, а не в подпрограмме: NaN и целое больше 2^53 в обход frame.ts не пройдут
      encodeJson(message.input);
      const output = await options.compute(message.input);
      if (disposed || epoch !== generation) return;
      const result: ComputeHostMessage = { flux: 'module', v: 1, session: options.session, type: 'compute-result', id: message.id, output };
      if (messageBytes(result) > 1024 * 1024 || !validMessage('compute-result', result)) { fail('BAD_OUTPUT'); options.onComputeError?.('BAD_OUTPUT'); }
      else post(result);
    } catch (error) {
      if (disposed || epoch !== generation) return;
      const code = codeOf(error instanceof ComputeError ? error : new ComputeError('CRASH'));
      fail(code);
      options.onComputeError?.(code);
    } finally { computing.delete(message.id); }
  }
  function notify(event: 'opened' | 'project-changed' | 'changed') {
    generation++;
    options.beginReadCycle?.();
    if (ready) post({
      flux: 'module', v: 1, session: options.session, type: 'event', event,
      context: options.context(), theme: options.theme(),
    });
  }
  async function handle(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>) {
    // Одного origin='null' мало: другой sandbox имеет тот же opaque origin.
    if (disposed || !options.frame() || event.source !== options.frame() || event.origin !== 'null') return;
    const message = event.data;
    if (!message || message.session !== options.session) return;
    if (Date.now() - budgetAt >= 1000) {
      budgetAt = Date.now();
      budget = 100;
    }
    if (--budget < 0) return;
    try {
      if (messageBytes(message) > 1024 * 1024) return;
    } catch (_) { return; }
    if (validMessage('ready', message)) {
      ready = true;
      notify('opened');
      return;
    }
    if (!ready) return;
    if (validMessage('failure', message)) {
      options.onFailure?.(message.kind as ModuleFailureKind);
      return;
    }
    // Ошибочная форма записи всё равно не становится неизвестной командой:
    // модуль получает явный запрет, а ни один обработчик чтения не вызывается.
    if (message.flux === 'module' && message.v === 1 && writeLike(message)) {
      const id = typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 160
        ? message.id : 'untracked';
      error(id, 'READ_ONLY');
      return;
    }
    if (validMessage('compute', message)) { void runCompute(message); return; }
    if (!validMessage('read', message)) return;
    const request = message as ReadRequest;
    if (!options.manifest.reads.includes(request.resource)) { error(request.id, 'DENIED'); return; }
    if (!options.context().projectId) { error(request.id, 'NO_PROJECT'); return; }
    if (pending.size >= 16 || pending.has(request.id)) { error(request.id, 'LIMIT'); return; }
    const epoch = generation;
    pending.add(request.id);
    try {
      const data = await options.read(request.resource, request.entityId);
      if (disposed || epoch !== generation) return;
      const result: HostMessage = {
        flux: 'module', v: 1, session: options.session, type: 'result',
        id: request.id, resource: request.resource, data,
      };
      if (messageBytes(result) > 1024 * 1024 || !validMessage('result', result)) error(request.id, 'LIMIT');
      else post(result);
    } catch (_) {
      if (!disposed && epoch === generation) error(request.id, 'FAILED');
    } finally { pending.delete(request.id); }
  }
  return {
    handle, notify,
    dispose: () => { disposed = true; generation++; pending.clear(); computing.clear(); },
  };
}
