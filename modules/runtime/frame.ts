import {
  resources, themeKeys,
  type HostMessage, type ComputeHostMessage, type ConnectHostMessage, type ModuleOutput, type Resource, type ReadData, type ModuleFailureKind,
} from '../contract';
import type { ComputeErrorCode } from '../engine/types';
import type { ConnectCall } from '../connections/model';
import { validMessage } from '../schemas';
import { renderForm, type ModuleForm } from './form';
import { readFormBindings } from './bindings';
import { createModuleWorker } from './runner';

declare const __MODULE_FORM__: ModuleForm;
declare const __MODULE_WORKER__: string;
/** typescript — Worker с логикой внутри этого окна; python и wasm — расчёт делает окно Flux (modules/engine) */
declare const __MODULE_LANGUAGE__: 'typescript' | 'python' | 'wasm';
const session = location.hash.slice(1);
const root = document.getElementById('module-root')!;
const pending = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
const computing = new Map<string, { resolve: (value: ModuleOutput) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
// Вызовы подключений не отменяются сменой контекста и темой: идущий запрос к внешней программе не должен пропадать от «changed»
const connecting = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let nextId = 0;
let epoch = 0;
let contextKey = '';
let client: ReturnType<typeof createModuleWorker> | null = null;
let output: ModuleOutput = { state: {}, calc: { out: {} } };

function cancelReads() {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('CONTEXT_CHANGED'));
  }
  pending.clear();
  for (const item of computing.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('CONTEXT_CHANGED'));
  }
  computing.clear();
}
/** Вход на Python/WebAssembly уходит окну Flux, оно выбирает механизм по подписанному манифесту и отвечает выходом по схеме договора */
function compute(input: Record<string, unknown>): Promise<ModuleOutput> {
  const id = `c-${++nextId}`;
  return new Promise((resolve, reject) => {
    // Окно Flux ограничивает расчёт 30 секундами; запас — на очередь и запуск среды
    const timer = setTimeout(() => { computing.delete(id); reject(new Error('TIMEOUT')); }, 120_000);
    computing.set(id, { resolve, reject, timer });
    parent.postMessage({ flux: 'module', v: 1, session, id, type: 'compute', input }, '*');
  });
}
const COMPUTE_NOTES: Partial<Record<ComputeErrorCode, string>> = {
  TIMEOUT: 'Расчёт остановлен по времени.',
  MEMORY: 'Расчёту не хватило памяти. Он остановлен.',
  NUMBER: 'Расчёт вернул число вне допустимого диапазона (NaN, бесконечность или целое больше 2^53).',
  BUSY: 'Сейчас идёт много расчётов. Повторите чуть позже.',
  UNAVAILABLE: 'Расчёт сейчас недоступен.',
  CONTROLS: 'Подпрограмма не запускается: контрольные примеры на этом компьютере не сошлись.',
  DENIED: 'Расчёт отменён.',
};
/** Сквозной вызов подключения: окно Flux проверяет разрешение по подписанному манифесту и отвечает данными программы как есть */
export function connect(connection: string, call: ConnectCall): Promise<unknown> {
  if (connecting.size >= 8) return Promise.reject(new Error('LIMIT'));
  const id = `n-${++nextId}`;
  return new Promise((resolve, reject) => {
    // Предел одного вызова 15–25 с задаёт главный процесс; запас — на очередь окна
    const timer = setTimeout(() => { connecting.delete(id); reject(new Error('TIMEOUT')); }, 40_000);
    connecting.set(id, { resolve, reject, timer });
    parent.postMessage({ flux: 'module', v: 1, session, id, type: 'connect', connection, call }, '*');
  });
}
function reset() {
  for (const item of connecting.values()) { clearTimeout(item.timer); item.reject(new Error('CONTEXT_CHANGED')); }
  connecting.clear();
  epoch++;
  client?.dispose();
  client = null;
  cancelReads();
}
function read(resource: string, entityId?: string): Promise<unknown> {
  if (!resources.includes(resource as Resource) || pending.size >= 16) {
    return Promise.reject(new Error('DENIED'));
  }
  const id = `r-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('READ_TIMEOUT'));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({
      flux: 'module', v: 1, session, id, type: 'read', resource,
      ...(entityId ? { entityId } : {}),
    }, '*');
  });
}
function reportFailure(reason: string) {
  // В родительское окно не передаются тексты исключений и данные модуля.
  const kind: ModuleFailureKind = reason === 'STATE_LIMIT' ? 'memory'
    : reason === 'TIMEOUT' || reason === 'BACKGROUND_TIMEOUT' ? 'timeout' : 'crash';
  parent.postMessage({ flux: 'module', v: 1, session, type: 'failure', kind }, '*');
}
function note(text: string) {
  const node = document.createElement('p');
  node.className = 'fx-note p-3';
  node.textContent = text;
  root.append(node);
}

window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.session !== session) return;
  const message = event.data as HostMessage | ComputeHostMessage | ConnectHostMessage;
  if (!['result', 'error', 'event', 'compute-result', 'compute-error', 'connect-result', 'connect-error'].includes(message.type) || !validMessage(message.type, message)) return;
  if (message.type === 'connect-result' || message.type === 'connect-error') {
    const item = connecting.get(message.id);
    if (!item) return;
    connecting.delete(message.id);
    clearTimeout(item.timer);
    if (message.type === 'connect-error') item.reject(Object.assign(new Error(message.code), { code: message.code }));
    else item.resolve(message.data);
    return;
  }
  if (message.type === 'compute-result' || message.type === 'compute-error') {
    const item = computing.get(message.id);
    if (!item) return;
    computing.delete(message.id);
    clearTimeout(item.timer);
    if (message.type === 'compute-error') item.reject(Object.assign(new Error(message.code), { code: message.code }));
    else item.resolve(message.output);
    return;
  }
  if (message.type === 'result' || message.type === 'error') {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.type === 'error') item.reject(new Error(message.code));
    else item.resolve(message.data);
    return;
  }

  const nextContext = JSON.stringify(message.context);
  const changedContext = nextContext !== contextKey;
  contextKey = nextContext;
  const generation = ++epoch;
  cancelReads();
  if (changedContext || client?.busy) {
    client?.dispose();
    client = null;
  }
  if (changedContext) output = { state: {}, calc: { out: {} } };
  for (const key of themeKeys) {
    document.documentElement.style.setProperty(key, message.theme[key]);
  }
  if (!message.context.projectId) {
    root.textContent = 'Выберите проект во Flux.';
    return;
  }
  let snapshot: Partial<ReadData>;
  const render = () => {
    // Только оболочка разрешает flux.*. Даже возвращённое логикой поле
    // «flux» не участвует в форме; state/calc принадлежат самому модулю.
    renderForm(root, __MODULE_FORM__, { flux: snapshot, ...output });
    if (message.context.entry === 'start' || !message.context.entityId) {
      note('Откройте модуль из карточки оборудования или тега.');
    }
  };
  try {
    snapshot = await readFormBindings(
      __MODULE_FORM__, resource => read(resource) as Promise<ReadData[Resource]>,
    );
    if (generation !== epoch) return;
    render();
  } catch (error) {
    if (generation === epoch) root.textContent = error instanceof Error && error.message === 'UNKNOWN_BINDING'
      ? 'Ошибка формы модуля: неизвестная привязка Flux.'
      : 'Данные недоступны. Проверьте подключение и права во Flux.';
    return;
  }
  if (__MODULE_LANGUAGE__ !== 'typescript') {
    try {
      // Вход один для всех языков: данные Flux, которые читает форма, и сохранённое состояние окна
      const calculated = await compute({ v: 1, context: message.context, flux: snapshot, state: output.state });
      if (generation !== epoch) return;
      output = { state: calculated.state, calc: calculated.calc };
      render();
    } catch (error) {
      if (generation !== epoch) return;
      render();
      const code = (error as { code?: ComputeErrorCode }).code;
      note((code && COMPUTE_NOTES[code]) || 'Не удалось выполнить расчёт модуля.');
    }
    return;
  }
  try {
    if (!client) {
      const created = createModuleWorker(__MODULE_WORKER__, {
        read, connect, initial: output,
        log: (level, text) => parent.postMessage({ flux: 'module', v: 1, session, type: 'log', level, text }, '*'),
        onRestart: reason => {
          if (client !== created) return;
          if (reason !== 'WORKER_RECYCLED') reportFailure(reason);
          note(reason === 'STATE_LIMIT'
            ? 'Состояние модуля превысило 256 КиБ. Расчёт остановлен.'
            : 'Фоновый расчёт остановлен. Следующее изменение данных перезапустит его из сохранённого состояния.');
        },
      });
      client = created;
    }
    const calculated = await client.run(__MODULE_FORM__.onDataChanged);
    if (generation !== epoch) return;
    output = { state: calculated.state, calc: calculated.calc };
    render();
  } catch (error) {
    if (generation !== epoch) return;
    client?.dispose();
    client = null;
    // Ошибка расчёта не прячет уже прочитанные привязки Flux.
    render();
    const reason = error instanceof Error ? error.message : '';
    if (['STATE_LIMIT', 'TIMEOUT', 'WORKER_FAILED'].includes(reason)) reportFailure(reason);
    note(reason === 'STATE_LIMIT' ? 'Состояние модуля превысило 256 КиБ. Расчёт остановлен.'
      : reason === 'TIMEOUT' ? 'Расчёт остановлен по времени.' : 'Не удалось выполнить расчёт модуля.');
  }
});
window.addEventListener('pagehide', reset);
parent.postMessage({ flux: 'module', v: 1, session, type: 'ready' }, '*');
