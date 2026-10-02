import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { SHELL_DESKTOP_SNAPSHOT, SHELL_DESKTOP_OPEN, SHELL_DESKTOP_CHANGED } from '../filesystem/shellDesktop';
import { NATIVE_APP_OPEN, NATIVE_APP_LIST, NATIVE_APP_ACTION, NATIVE_APP_CHANGED, NATIVE_APP_CLOSE_REQUEST, NATIVE_APP_CLOSE_REPLY, NATIVE_APP_LOCATION } from '../workspace/nativeApps';
import { WINDOWS_NOTIFICATIONS_SNAPSHOT, WINDOWS_NOTIFICATIONS_CONSENT, WINDOWS_NOTIFICATIONS_CHANGED } from '../filesystem/windowsNotifications';
import { INVOKE_CHANNELS, SEND_CHANNELS, LISTEN_CHANNELS, refused } from './ipcAllow';

// ── Сколько окно ждало ответа от главного процесса ──────────────────────────
//
// Замер внутри обработчика — не то, что чувствует человек: между нажатием и
// началом работы лежит ещё очередь. Здесь берётся вторая половина: полное
// время от вызова до ответа. Разница с временем обработчика и есть очередь.
//
// Подмена стоит на самом `ipcRenderer`, а не на каждом методе моста: иначе
// достаточно завести новый метод и забыть его обернуть. Аргументы не
// сериализуются никогда — в них ездят содержимое документа и снимки.
const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer);
const rawSend = ipcRenderer.send.bind(ipcRenderer);
const spans: Array<{ channel: string; waitMs: number; ok: boolean; error?: string; code?: string }> = [];
let waiting: ReturnType<typeof setTimeout> | null = null;

function noteIpc(channel: string, start: number, ok: boolean, error?: string, code?: string): void {
  try {
    if (channel.startsWith('diagnostics:')) return; // запись о записи не нужна
    if (spans.length < 200) spans.push({ channel, waitMs: performance.now() - start, ok, ...(error ? { error } : {}), ...(code ? { code } : {}) });
    if (waiting) return;
    waiting = setTimeout(() => {
      waiting = null;
      const batch = spans.splice(0, 200);
      if (batch.length) { try { rawSend('diagnostics:ipc', batch); } catch (_) { /* мост закрыт */ } }
    }, 1000);
  } catch (_) { /* замер не имеет права сломать вызов */ }
}

(ipcRenderer as any).invoke = (channel: string, ...args: any[]) => {
  const start = performance.now();
  return rawInvoke(channel, ...args).then(
    (result: any) => {
      // These APIs resolve business failures as values, so Promise rejection
      // alone misses them. Inspect only the boolean contract and typed code.
      const value = result?.data && typeof result.data === 'object' ? result.data : result;
      const failed = (channel === 'windows-files:invoke' || channel === 'windows-office:invoke') && (value?.ok === false || value?.success === false);
      const rawCode = value?.code ?? value?.error?.code;
      const code = typeof rawCode === 'string' && /^(?:P\d{4}|ERR_[A-Z0-9_]{2,32}|E[A-Z]{2,16})$/.test(rawCode) ? rawCode : undefined;
      noteIpc(channel, start, !failed, failed ? 'OperationFailed' : undefined, code);
      return result;
    },
    (error: any) => { noteIpc(channel, start, false, error?.name); throw error; },
  );
};

contextBridge.exposeInMainWorld('electron', {
  windowsNotifications: {
    snapshot: () => ipcRenderer.invoke(WINDOWS_NOTIFICATIONS_SNAPSHOT),
    requestConsent: () => ipcRenderer.invoke(WINDOWS_NOTIFICATIONS_CONSENT),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(WINDOWS_NOTIFICATIONS_CHANGED, listener);
      return () => ipcRenderer.removeListener(WINDOWS_NOTIFICATIONS_CHANGED, listener);
    },
  },
  windowsFiles: {
    invoke: (request: unknown) => ipcRenderer.invoke('windows-files:invoke', request),
    onChanged: (callback: (change: unknown) => void) => {
      const listener = (_event: unknown, change: unknown) => callback(change);
      ipcRenderer.on('windows-files:changed', listener);
      return () => ipcRenderer.removeListener('windows-files:changed', listener);
    },
  },
  localOffice: {
    invoke: (request: unknown) => ipcRenderer.invoke('windows-office:invoke', request),
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: unknown, event: unknown) => callback(event);
      ipcRenderer.on('windows-office:event', listener);
      return () => ipcRenderer.removeListener('windows-office:event', listener);
    },
  },
  desktopShell: {
    snapshot: () => ipcRenderer.invoke(SHELL_DESKTOP_SNAPSHOT),
    open: (id: string) => ipcRenderer.invoke(SHELL_DESKTOP_OPEN, id),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(SHELL_DESKTOP_CHANGED, listener);
      return () => ipcRenderer.removeListener(SHELL_DESKTOP_CHANGED, listener);
    },
  },
  nativeApps: {
    open: (href: string) => ipcRenderer.invoke(NATIVE_APP_OPEN, href),
    list: () => ipcRenderer.invoke(NATIVE_APP_LIST),
    location: (id: string, href: string) => ipcRenderer.invoke(NATIVE_APP_LOCATION, id, href),
    action: (id: string, action: 'focus' | 'minimize' | 'close') => ipcRenderer.invoke(NATIVE_APP_ACTION, id, action),
    closeReply: (id: string, accepted: boolean) => ipcRenderer.invoke(NATIVE_APP_CLOSE_REPLY, id, accepted),
    onChanged: (callback: (windows: unknown[]) => void) => {
      const listener = (_event: unknown, value: unknown[]) => callback(value);
      ipcRenderer.on(NATIVE_APP_CHANGED, listener);
      return () => ipcRenderer.removeListener(NATIVE_APP_CHANGED, listener);
    },
    onCloseRequest: (callback: (id: string) => void) => {
      const listener = (_event: unknown, id: string) => callback(id);
      ipcRenderer.on(NATIVE_APP_CLOSE_REQUEST, listener);
      return () => ipcRenderer.removeListener(NATIVE_APP_CLOSE_REQUEST, listener);
    },
  },
  displays: {
    get: () => ipcRenderer.invoke('workspace:displays-get'),
    set: (enabled: boolean) => ipcRenderer.invoke('workspace:displays-set', enabled),
    preferences: (value: { showWindowsTaskbar: boolean }) => ipcRenderer.invoke('workspace:displays-preferences', value),
    onChanged: (callback: (event: unknown) => void) => {
      const listener = (_event: unknown, value: unknown) => callback(value);
      ipcRenderer.on('workspace:displays-changed', listener);
      return () => ipcRenderer.removeListener('workspace:displays-changed', listener);
    },
  },
  /** Подробная запись работы программы: состояние, папка, режим */
  diagnostics: {
    append: (batch: unknown[]) => ipcRenderer.invoke('diagnostics:append', batch),
    folder: () => ipcRenderer.invoke('diagnostics:folder'),
    status: () => ipcRenderer.invoke('diagnostics:status'),
    // Свои записи обратно — для пакета к обращению. Интервал и предел объёма
    // оболочка ограничивает сама: окно не должно уметь попросить весь журнал
    read: (request: { from: number; to: number; maxBytes?: number }) =>
      ipcRenderer.invoke('diagnostics:read', request),
    detailed: (seconds: number) => ipcRenderer.invoke('diagnostics:detailed', seconds),
  },
  /**
   * Полный путь файла, принесённого из Windows.
   *
   * Раньше путь лежал прямо на объекте файла (`file.path`), но в новых версиях
   * оболочки его там больше нет — остался только этот способ. Нужен он ровно
   * для одного: чтобы выгрузка предложила ту же папку, из которой файл принесли.
   */
  pathOfFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
  /** Сохранить файл на диск Windows обычным окном сохранения */
  saveFileAs: (p: { name: string; base64: string; dir?: string }) =>
    ipcRenderer.invoke('files:save-as', p),
  /** Открыть файл программой Windows — для того, чему своей программы нет */
  openFileExternally: (p: { name: string; base64: string }) =>
    ipcRenderer.invoke('files:open-external', p),
  // Общий мост — только по списку (electron/ipcAllow.ts): «любой канал»
  // означал, что любая ошибка в окне получает всё, что умеет оболочка
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      if (!SEND_CHANNELS.has(channel)) throw refused(channel);
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      if (!LISTEN_CHANNELS.has(channel)) throw refused(channel);
      const subscription = (event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, subscription);
      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    invoke: (channel: string, ...args: any[]) => {
      if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(refused(channel));
      return ipcRenderer.invoke(channel, ...args);
    },
  },
  saveLog: (text: string) => ipcRenderer.invoke('log:save-dialog', text),
  emergencySave: (text: string) => ipcRenderer.send('log:emergency-save', text),
  
  // Автообновления: проверка и публикация идут через HTTP API сервера
  // (см. UpdaterWidget); главный процесс скачивает exe и подменяет приложение
  startDownload: (data: { url: string; version: string; token?: string; server?: string; signature?: string }) =>
    ipcRenderer.invoke('updater:start-download', data),
  quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
  getAppVersion: () => ipcRenderer.invoke('updater:version'),
  isPackaged: () => ipcRenderer.invoke('updater:is-packaged'),
  // Портативный ли это файл: от этого зависит, что обещать человеку про
  // подмену программы на месте
  isPortable: () => ipcRenderer.invoke('updater:is-portable'),

  // Listener registrations
  onUpdaterStatus: (callback: (state: string, data?: any) => void) => {
    const subscription = (event: any, state: string, data: any) => callback(state, data);
    ipcRenderer.on('updater:status', subscription);
    return () => {
      ipcRenderer.removeListener('updater:status', subscription);
    };
  },
  onUpdaterError: (callback: (errMsg: string) => void) => {
    const subscription = (event: any, errMsg: string) => callback(errMsg);
    ipcRenderer.on('updater:error', subscription);
    return () => {
      ipcRenderer.removeListener('updater:error', subscription);
    };
  },

  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  // Захват с экрана: пульт живёт в отдельном окне, разбор — в главном
  capture: {
    start: () => ipcRenderer.send('capture:start'),
    cancel: () => ipcRenderer.send('capture:cancel'),
    confirm: () => ipcRenderer.send('capture:confirm'),
    toBasket: () => ipcRenderer.send('capture:to-basket'),
    clearBasket: () => ipcRenderer.send('capture:clear-basket'),
    sync: () => ipcRenderer.invoke('capture:sync'),
    move: (dx: number, dy: number) => ipcRenderer.send('capture:move', dx, dy),
    onState: (callback: (data: any) => void) => {
      const subscription = (_event: any, data: any) => callback(data);
      ipcRenderer.on('capture:state', subscription);
      return () => ipcRenderer.removeListener('capture:state', subscription);
    },
    // Захват не присылается, а забирается: рендерер мог ещё не подняться
    takePending: () => ipcRenderer.invoke('capture:take-pending'),
    onReady: (callback: () => void) => {
      const subscription = () => callback();
      ipcRenderer.on('capture:ready', subscription);
      return () => ipcRenderer.removeListener('capture:ready', subscription);
    },
  },

  // Браузер внутри программы: страницы живут отдельными процессами, окно
  // рисует React, а границы страницы приезжают отсюда числами
  browser: {
    newTab: (url: string) => ipcRenderer.invoke('browser:new-tab', url),
    show: (id: string) => ipcRenderer.invoke('browser:show', id),
    hide: () => ipcRenderer.invoke('browser:hide'),
    closeTab: (id: string) => ipcRenderer.invoke('browser:close-tab', id),
    setBounds: (b: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:bounds', b),
    go: (id: string, url: string) => ipcRenderer.invoke('browser:go', { id, url }),
    action: (id: string, action: string) => ipcRenderer.invoke('browser:action', { id, action }),
    state: (id: string) => ipcRenderer.invoke('browser:state', id),
    selection: (id: string) => ipcRenderer.invoke('browser:selection', id),
    onState: (callback: (s: any) => void) => {
      const sub = (_e: any, s: any) => callback(s);
      ipcRenderer.on('browser:state', sub);
      return () => ipcRenderer.removeListener('browser:state', sub);
    },
    onOpened: (callback: (p: { id: string; url: string }) => void) => {
      const sub = (_e: any, p: any) => callback(p);
      ipcRenderer.on('browser:opened', sub);
      return () => ipcRenderer.removeListener('browser:opened', sub);
    },
    onFailed: (callback: (p: { id: string; code: number; desc: string; url: string }) => void) => {
      const sub = (_e: any, p: any) => callback(p);
      ipcRenderer.on('browser:failed', sub);
      return () => ipcRenderer.removeListener('browser:failed', sub);
    },
    onDownload: (callback: (p: any) => void) => {
      const sub = (_e: any, p: any) => callback(p);
      ipcRenderer.on('browser:download', sub);
      return () => ipcRenderer.removeListener('browser:download', sub);
    },
    // Личная папка загрузок называется логином сотрудника: главный процесс о
    // том, кто вошёл, не знает — окно программы говорит ему это само
    setOwner: (symbol: string) => ipcRenderer.invoke('browser:set-owner', symbol),
    downloadsDir: () => ipcRenderer.invoke('browser:downloads-dir'),
    openDownload: (path: string, reveal = false) =>
      ipcRenderer.invoke('browser:open-download', path, reveal),
  },

  // Уведомления системы: показываются, когда окно свёрнуто или не в фокусе
  notify: {
    system: (payload: { title: string; body: string; route?: string }) =>
      ipcRenderer.invoke('notify:system', payload),
    badge: (count: number) => ipcRenderer.invoke('notify:badge', count),
    windowState: () => ipcRenderer.invoke('notify:window-state'),
    onOpen: (callback: (route: string) => void) => {
      const subscription = (_event: any, route: string) => callback(route);
      ipcRenderer.on('notify:open', subscription);
      return () => ipcRenderer.removeListener('notify:open', subscription);
    },
  },

  /**
   * Локальный менеджер игр Flux Play.
   *
   * Каналы перечислены поимённо — это не украшение. Рядом висит общий мост
   * (`ipcRenderer.invoke` выше), которым можно позвать любой канал оболочки; для
   * менеджера так делать нельзя: он пишет файлы на диск по присланной описи, и
   * «любой канал» здесь означает «любую запись куда угодно». Поэтому у игр свой
   * узкий список, и ничего кроме перечисленного окно позвать не может.
   */
  games: {
    state: (p: { gameId: string; published?: string }) => ipcRenderer.invoke('games:state', p),
    install: (p: {
      gameId: string; manifest: unknown; base: string; server: string; token?: string; publisherKey: string;
    }) => ipcRenderer.invoke('games:install', p),
    pause: (p: { gameId: string }) => ipcRenderer.invoke('games:pause', p),
    resume: (p: { gameId: string }) => ipcRenderer.invoke('games:resume', p),
    cancel: (p: { gameId: string }) => ipcRenderer.invoke('games:cancel', p),
    verify: (p: { gameId: string; published?: string }) => ipcRenderer.invoke('games:verify', p),
    launch: (p: { gameId: string; address: string; ticket: string; sessionId: string }) =>
      ipcRenderer.invoke('games:launch', p),
    remove: (p: { gameId: string }) => ipcRenderer.invoke('games:remove', p),
    onProgress: (callback: (p: any) => void) => {
      const subscription = (_event: any, p: any) => callback(p);
      ipcRenderer.on('games:progress', subscription);
      return () => ipcRenderer.removeListener('games:progress', subscription);
    },
  },

  // Журналы: папка на рабочем столе, файл на день
  logs: {
    append: (p: { level?: string; where?: string; text?: string }) => ipcRenderer.invoke('logs:append', p),
    today: () => ipcRenderer.invoke('logs:today'),
    folder: () => ipcRenderer.invoke('logs:folder'),
    openFolder: () => ipcRenderer.invoke('logs:open-folder'),
  },

  // Автозапуск вместе с Windows: состояние читаем у системы, а не помним своё
  startup: {
    get: () => ipcRenderer.invoke('startup:get'),
    set: (opts: { enabled: boolean; minimized?: boolean }) => ipcRenderer.invoke('startup:set', opts),
  },

  // Управление окном (кастомный заголовок)
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    // Вынести раздел в отдельное окно ОС (мультимонитор)
    openWindow: (route: string) => ipcRenderer.invoke(NATIVE_APP_OPEN, route),
    closeConfirm: (token: string, allowed: boolean) => ipcRenderer.invoke('window:close-confirm', token, allowed),
    onCloseRequest: (callback: (token: string) => void) => {
      const listener = (_event: unknown, token: string) => callback(token);
      ipcRenderer.on('window:close-request', listener);
      return () => ipcRenderer.removeListener('window:close-request', listener);
    },
    onMaximizedChange: (callback: (val: boolean) => void) => {
      const subscription = (_event: any, val: boolean) => callback(val);
      ipcRenderer.on('window:maximized-changed', subscription);
      return () => ipcRenderer.removeListener('window:maximized-changed', subscription);
    },
  },
});
