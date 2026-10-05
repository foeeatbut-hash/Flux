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
// С диска Chromium пишет origin строкой 'null', а Electron — 'file://': оба
// значат «адреса нет». Письма «на адрес file://» браузер не доставляет, и в
// exe окно не слышало редактора вовсе (src/lib/officeBridge.ts, diskOrigin)
const disk = origin === 'null' || origin === 'file://';
const target = disk ? '*' : origin;
const sameOrigin = (o) => (disk ? o === 'null' || o === 'file://' : o === origin);

let seq = 0;
const waiting = new Map();
const listeners = new Map();

// GenOffice's AI/provider APIs are outside Flux Office's feature set. Block
// them at the renderer boundary so a stale or keyboard-triggered control can
// never reach the parent window or a GenOffice main-process handler.
const isAiChannel = (channel) => /(?:^|[:_-])(?:ai|gsk|genspark|copilot|assistant)(?:$|[:_-])|web-search|image-search|fetch-image|generate-image|media-understanding/i.test(String(channel));
const aiDisabled = () => ({ ok: false, error: 'ИИ-функции GenOffice отключены во Flux Office' });
window.__fluxNoGenOfficeAI = true;

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
    if (isAiChannel(channel)) return Promise.resolve(aiDisabled());
    const p = new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      post({ id, op: 'ipc', payload: { channel, args } });
    });
    // Запись Таблицы: после неё книга перестраивается из файла, и модуль
    // совместной правки придерживает чужие правки (inject/sheets-collab.ts)
    if (channel === 'workbook:save') {
      const tell = (detail) => { try { window.dispatchEvent(new CustomEvent('flux-sheets-save', { detail })); } catch (_) {} };
      tell({ phase: 'start' });
      p.then((r) => tell({ phase: 'end', ok: !!r && !r.canceled && r.ok !== false }), () => tell({ phase: 'end', ok: false }));
    }
    return p;
  },
  send(channel, ...args) { if (!isAiChannel(channel)) post({ op: 'ipc-send', payload: { channel, args } }); },
  sendSync() { return undefined; },
  on(channel, fn) {
    if (isAiChannel(channel)) return ipcRenderer;
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return ipcRenderer;
  },
  once(channel, fn) {
    if (isAiChannel(channel)) return ipcRenderer;
    const wrap = (...a) => { ipcRenderer.removeListener(channel, wrap); fn(...a); };
    return ipcRenderer.on(channel, wrap);
  },
  removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return ipcRenderer; },
  off(channel, fn) { return ipcRenderer.removeListener(channel, fn); },
  removeAllListeners(channel) { if (channel) listeners.delete(channel); else listeners.clear(); return ipcRenderer; },
};

// Модули Flux внутри редактора (совместная правка) говорят с окном тем же путём
window.__fluxIpc = ipcRenderer;

export const contextBridge = {
  exposeInMainWorld(name, api) { window[name] = api; },
};

// Файлы Windows во фрейм не бросают: файлы открываются из Проводника Flux
export const webUtils = { getPathForFile: () => '' };
export const webFrame = { setZoomFactor() {}, getZoomFactor: () => 1 };

export default { ipcRenderer, contextBridge, webUtils, webFrame };

// ── ИИ GenOffice отключён на уровне возможностей и элементов управления ──
try {
  localStorage.setItem('genoffice-pdf-show-ai', '0');
  // Таблица читает свой ключ (ExcelShell.tsx), не «genoffice-…», как PDF
  localStorage.setItem('ai-sheets-show-ai', '0');
} catch (_) {}
const css = document.createElement('style');
css.textContent =
  '.ai-dock{display:none!important}' +
  // Свёрнутая панель ИИ Таблицы — полоска со значком Genspark слева от листа
  '.copilot{display:none!important}' +
  '.ribbon-group:has(.ai-entry){display:none!important}' +
  '.ribbon-group:has(.ai-entry)+.ribbon-sep{display:none!important}' +
  'button:has(.ai-feature-icon),[role="menuitem"]:has(.ai-feature-icon){display:none!important}';
(document.head || document.documentElement).appendChild(css);

// Capture controls before React's delegated handlers. This also covers
// selection popovers and context-menu AI entries that do not use .ai-entry.
const aiLabel = /\b(?:ai|gsk|genspark|copilot|ask\s*ai)\b|(?:^|[^\p{L}\p{N}_])ИИ(?:$|[^\p{L}\p{N}_])|искусственн[\p{L}\p{N}_]*\s+интеллект/iu;
const isAiControl = (target) => {
  if (!target?.closest) return false;
  if (target.closest('.ai-entry,.ai-dock,.copilot,.ai-rail,.ai-ask-trigger,.ai-ask-pop,[data-ai],button:has(.ai-feature-icon),[role="menuitem"]:has(.ai-feature-icon),.ctx-item:has(.copilot-badge)')) return true;
  const control = target.closest('button,[role="menuitem"],input,textarea');
  const label = [control?.getAttribute('aria-label'), control?.getAttribute('title'), control?.getAttribute('data-tip')].filter(Boolean).join(' ');
  return aiLabel.test(label);
};
const stopAiControl = (event) => {
  if (!isAiControl(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
document.addEventListener('click', stopAiControl, true);
document.addEventListener('pointerdown', stopAiControl, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'F7') {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && isAiControl(event.target)) stopAiControl(event);
}, true);

// Remove editor controls from the accessibility tree and tab order as well as
// blocking their events. The observer handles menus and popovers created later.
const removeAiControls = (root) => {
  if (!root?.querySelectorAll) return;
  const controls = '.ai-entry,.ai-dock,.copilot,.ai-rail,.ai-ask-trigger,.ai-ask-pop,[data-ai],.ctx-item:has(.copilot-badge),button:has(.ai-feature-icon),[role="menuitem"]:has(.ai-feature-icon),.ribbon-group:has(.ai-entry)';
  if (root.nodeType === Node.ELEMENT_NODE && root.matches(controls)) root.remove();
  for (const element of root.querySelectorAll(controls)) element.remove();
  const labelled = 'button,[role="menuitem"],input,textarea';
  const candidates = [...root.querySelectorAll(labelled)];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches(labelled)) candidates.unshift(root);
  for (const element of candidates) {
    const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-tip')].filter(Boolean).join(' ');
    if (aiLabel.test(label)) element.remove();
  }
};
removeAiControls(document);
new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
  if (node.nodeType === Node.ELEMENT_NODE) removeAiControls(node);
}))).observe(document.documentElement, { childList: true, subtree: true });

// Меню Electron: там Ctrl+S — клавиша меню главного процесса, и окно получает
// команду «menu:action». В браузере меню нет — клавишу ловим здесь и отдаём
// ту же команду тем, кто её слушает (Таблица; у PDF своя клавиша в окне)
const MENU_KEYS = { s: 'save', S: 'save-as' };
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const action = MENU_KEYS[e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()];
  if (action === 'save-as' && window.pdfApi) { e.preventDefault(); e.stopImmediatePropagation(); post({ op: 'flux:save-as' }); return; }
  const set = listeners.get('menu:action');
  if (!action || !set || !set.size) return;
  e.preventDefault();
  e.stopPropagation();
  for (const fn of Array.from(set)) { try { fn({ sender: null }, action); } catch (_) {} }
}, true);

// Окно Flux ждёт этого слова: молчание значит «редактора нет»
post({ op: 'hello' });

document.addEventListener('click', (e) => {
  const b = e.target?.closest?.('.qa-save-as');
  if (window.pdfApi && b && b.getAttribute('aria-label') !== 'Flux') { e.preventDefault(); e.stopImmediatePropagation(); post({ op: 'flux:save-as' }); }
}, true);
