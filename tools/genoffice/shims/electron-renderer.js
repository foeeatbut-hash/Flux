/*
 * Модуль «electron» для preload-скриптов GenOffice в браузере (Flux Office).
 *
 * У Таблицы и PDF свой preload: он собирает window.pdfApi / window.desktopApi
 * из вызовов ipcRenderer. Мы собираем этот же preload для страницы, подменив
 * «electron» этим файлом (tools/genoffice/build.mjs): ipcRenderer.invoke
 * уходит окну Flux сообщением, окно — на сервер, а там отвечает родной главный
 * процесс редактора (tools/genoffice/shims/electron-main.ts). Так у редактора
 * тот же API, что в его собственной оболочке, без переписывания руками.
 *
 * Сообщения — тот же конверт, что у flux-bridge.js: {flux:'office', …},
 * только от своего окна и своего адреса (с диска — только от своего окна).
 */
const parentWin = window.parent;
const origin = window.location.origin;
const target = origin === 'null' ? '*' : origin;
const sameOrigin = (o) => (origin === 'null' ? o === 'null' || o === 'file://' : o === origin);

let seq = 0;
const waiting = new Map();
const listeners = new Map();

if (parentWin && parentWin !== window) {
  window.addEventListener('message', (e) => {
    if (e.source !== parentWin || !sameOrigin(e.origin)) return;
    const m = e.data;
    if (!m || m.flux !== 'office') return;
    if (m.reply && waiting.has(m.reply)) {
      const w = waiting.get(m.reply);
      waiting.delete(m.reply);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
      return;
    }
    if (m.event === 'ipc' && m.payload) {
      const set = listeners.get(m.payload.channel);
      if (set) for (const fn of Array.from(set)) { try { fn({ sender: null }, ...(m.payload.args || [])); } catch (_) {} }
    }
  });
}

function post(msg) {
  if (parentWin && parentWin !== window) parentWin.postMessage({ flux: 'office', ...msg }, target);
}

export const ipcRenderer = {
  invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      post({ id, op: 'ipc', payload: { channel, args } });
    });
  },
  send(channel, ...args) { post({ op: 'ipc-send', payload: { channel, args } }); },
  sendSync() { return undefined; },
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return ipcRenderer;
  },
  once(channel, fn) {
    const wrap = (...a) => { ipcRenderer.removeListener(channel, wrap); fn(...a); };
    return ipcRenderer.on(channel, wrap);
  },
  removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return ipcRenderer; },
  off(channel, fn) { return ipcRenderer.removeListener(channel, fn); },
  removeAllListeners(channel) { if (channel) listeners.delete(channel); else listeners.clear(); return ipcRenderer; },
};

export const contextBridge = {
  exposeInMainWorld(name, api) { window[name] = api; },
};

// Файлы Windows во фрейм не бросают: файлы открываются из Проводника Flux
export const webUtils = { getPathForFile: () => '' };
export const webFrame = { setZoomFactor() {}, getZoomFactor: () => 1 };

export default { ipcRenderer, contextBridge, webUtils, webFrame };

// ── Как во всех редакторах Flux Office: без ИИ и без имени Genspark ──
try {
  localStorage.setItem('genoffice-pdf-show-ai', '0');
  localStorage.setItem('genoffice-sheets-show-ai', '0');
} catch (_) {}
const css = document.createElement('style');
css.textContent =
  '.ai-dock{display:none!important}' +
  '.ribbon-group:has(.ai-entry){display:none!important}' +
  '.ribbon-group:has(.ai-entry)+.ribbon-sep{display:none!important}' +
  'button:has(.ai-feature-icon),[role="menuitem"]:has(.ai-feature-icon){display:none!important}';
(document.head || document.documentElement).appendChild(css);

// Окно Flux ждёт этого слова: молчание значит «редактора нет»
post({ op: 'hello' });
