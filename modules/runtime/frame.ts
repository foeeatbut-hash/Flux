import { resources, themeKeys, type HostMessage, type Resource } from '../contract';
import { validMessage } from '../schemas';
import { renderForm, type ModuleForm } from './form';
import { runModuleWorker } from './runner';

declare const __MODULE_FORM__: ModuleForm;
declare const __MODULE_WORKER__: string;
const session = location.hash.slice(1);
const root = document.getElementById('module-root')!;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let nextId = 0;
let epoch = 0;
let run: ReturnType<typeof runModuleWorker> | null = null;
function reset() {
  epoch++;
  run?.cancel(); run = null;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CONTEXT_CHANGED')); }
  pending.clear();
}
function read(resource: string, entityId?: string): Promise<unknown> {
  if (!resources.includes(resource as Resource) || pending.size >= 16) return Promise.reject(new Error('DENIED'));
  const id = `r-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('READ_TIMEOUT')); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ flux: 'module', v: 1, session, id, type: 'read', resource, ...(entityId ? { entityId } : {}) }, '*');
  });
}
window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.session !== session) return;
  const message = event.data as HostMessage;
  if (!['result', 'error', 'event'].includes(message.type) || !validMessage(message.type, message)) return;
  if (message.type === 'result' || message.type === 'error') {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.type === 'error') item.reject(new Error(message.code)); else item.resolve(message.data);
    return;
  }
  reset();
  for (const key of themeKeys) document.documentElement.style.setProperty(key, message.theme[key]);
  if (!message.context.projectId) { root.textContent = 'Выберите проект во Flux.'; return; }
  if (message.context.entry === 'start' || !message.context.entityId) {
    root.textContent = 'Откройте модуль из карточки оборудования или тега.';
    return;
  }
  const generation = epoch;
  run = runModuleWorker(__MODULE_WORKER__, __MODULE_FORM__.onDataChanged, { read });
  try {
    const data = await run.result;
    if (generation === epoch) renderForm(root, __MODULE_FORM__, data);
  } catch (error) {
    if (generation === epoch) root.textContent = error instanceof Error && error.message === 'TIMEOUT'
      ? 'Расчёт остановлен по времени. Откройте модуль заново.' : 'Данные недоступны. Проверьте подключение и права во Flux.';
  }
});
window.addEventListener('pagehide', reset);
parent.postMessage({ flux: 'module', v: 1, session, type: 'ready' }, '*');
