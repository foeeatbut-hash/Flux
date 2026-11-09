import { contextBridge, ipcRenderer } from 'electron';

/** В окно попадают только перечисленные действия: произвольного IPC у страницы нет */
const ALLOWED = ['state', 'connect', 'login', 'logout', 'disconnect', 'modules', 'openSection', 'cancel'];

function subscribe(channel: string, fn: unknown): () => void {
  if (typeof fn !== 'function') return () => {};
  const listener = (_event: unknown, data: unknown) => fn(data);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

contextBridge.exposeInMainWorld('studio', Object.freeze({
  call: (action: string, args: object = {}) => ALLOWED.includes(action)
    ? ipcRenderer.invoke('studio:call', action, args)
    : Promise.resolve({ ok: false, error: 'Недоступное действие.' }),
  onState: (fn: unknown) => subscribe('studio:state', fn),
  onProgress: (fn: unknown) => subscribe('studio:progress', fn),
}));
