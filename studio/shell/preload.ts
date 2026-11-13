import { contextBridge, ipcRenderer } from 'electron';
import { ALL_ACTIONS } from './actions';

/** В окно попадают только перечисленные действия: произвольного IPC у страницы нет */
const ALLOWED = ALL_ACTIONS;

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
  onProject: (fn: unknown) => subscribe('studio:project', fn),
  /** События запуска программы: вопрос человеку о подключении и снятие вопроса (studio/shared/runActions.ts) */
  onRun: (fn: unknown) => subscribe('studio:run', fn),
}));

/** Кнопки окна — тот же мост, что у Flux (window.electron.windowControls), чтобы одна и та же плавающая панелька работала в обеих программах */
contextBridge.exposeInMainWorld('electron', Object.freeze({
  windowControls: Object.freeze({
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (fn: unknown) => subscribe('window:maximized-changed', fn),
  }),
}));
