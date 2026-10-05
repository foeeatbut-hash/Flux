/*
 * Мост Блокнота Flux Office: редактор Markdown GenOffice внутри окна Flux.
 *
 * Редактор ждёт от своей оболочки window.markdownApi — открыть, сохранить,
 * картинки, выгрузка в Word, печать, ИИ. Во Flux он живёт во фрейме, и этот
 * файл подставляет markdownApi сам: открытие и запись уходят сообщениями окну
 * Flux (src/screens/NoteEditorHost.tsx), а оно пишет в заметку Блокнота или в
 * файл .md Проводника.
 *
 * Чего здесь нет намеренно:
 *   - ИИ, веб-поиск, поиск и генерация картинок: Flux работает без интернета,
 *     данные наружу не уходят (flux-data-safety, правило 8);
 *   - доступа к диску. Картинка из буфера или перенесённая мышью кладётся в
 *     саму заметку (data:), не больше IMAGE_MAX: у заметки нет папки рядом,
 *     куда редактор клал бы assets/.
 *
 * Протокол — тот же, что у Документа (flux-bridge.js): запрос с номером и
 * ответ с ним же, события окна Flux — без ответа.
 *
 * Стоит в index.html ДО скриптов редактора (tools/genoffice/build.mjs).
 */
(function () {
  'use strict';
  var parentWin = window.parent;
  var origin = window.location.origin;
  if (!parentWin || parentWin === window) return;
  window.__fluxNoGenOfficeAI = true;
  // С диска Chromium пишет origin строкой 'null', а Electron — 'file://':
  // оба значат «адреса нет» (src/lib/officeBridge.ts, diskOrigin)
  var disk = origin === 'null' || origin === 'file://';
  var target = disk ? '*' : origin;
  var sameOrigin = function (o) { return disk ? o === 'null' || o === 'file://' : o === origin; };

  var seq = 0;
  var waiting = {};
  var listeners = {};
  var last = {};

  function ask(op, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      parentWin.postMessage({ flux: 'office', id: id, op: op, payload: payload || null }, target);
    });
  }
  function tell(op, payload) {
    parentWin.postMessage({ flux: 'office', op: op, payload: payload }, target);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin || !sameOrigin(e.origin)) return;
    var m = e.data;
    if (!m || m.flux !== 'office') return;
    if (m.reply && waiting[m.reply]) {
      var w = waiting[m.reply];
      delete waiting[m.reply];
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
      return;
    }
    if (!m.event) return;
    last[m.event] = m.payload;
    (listeners[m.event] || []).forEach(function (fn) { try { fn(m.payload); } catch (_) {} });
  });

  function on(event, sticky) {
    return function (fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      if (sticky && Object.prototype.hasOwnProperty.call(last, event)) { try { fn(last[event]); } catch (_) {} }
      return function () { listeners[event] = (listeners[event] || []).filter(function (x) { return x !== fn; }); };
    };
  }
  var never = function () { return function () {}; };
  var OFF = 'Во Flux Office это отключено: программа работает без внешних сервисов';

  /** Картинка в самой заметке — не больше 2 МБ, иначе заметка тяжелеет у всех, с кем она общая */
  var IMAGE_MAX = 2 * 1024 * 1024;
  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  /** Открытая вещь: путь «flux://note/<id>» или «flux://file/<id>» и её текст */
  var opened = null;

  var api = {
    consumePending: function () {
      return ask('open').then(function (r) {
        if (!r) return null;
        opened = { path: r.path, text: String(r.text || '') };
        return r.path;
      });
    },
    consumeHeadlessExport: function () { return Promise.resolve(null); },
    headlessExportDone: function () {},
    readFile: function (path) {
      if (opened && path === opened.path) return Promise.resolve(opened.text);
      return Promise.reject(new Error('Этот файл не открыт в окне'));
    },
    // Сохранение — всегда в ту же заметку или файл; «Сохранить как» в
    // Блокноте не нужен — копию делает «Выгрузить»
    save: function (req) {
      var path = opened ? opened.path : '';
      return ask('save', { text: String((req && req.text) || '') }).then(function (r) {
        if (r && r.ok) return { ok: true, path: path };
        return { ok: false, error: (r && r.error) || 'Не удалось сохранить' };
      });
    },
    setDirty: function (dirty) { tell('dirty', dirty === true); },
    onSaveRequest: on('saveRequest'),
    sendSaveRequestAck: function (ok) { tell('saveAck', ok === true); },
    onReadTextRequest: on('readText'),
    sendReadTextResult: function (r) { tell('readTextResult', r || null); },
    onCloseSaveRequest: on('closeSave'),
    sendCloseSaveResult: function (ok) { tell('closeSaveResult', ok === true); },
    onFileRenamed: never,

    // Картинки: в заметку, а не в папку рядом
    pickImage: function () { return Promise.resolve(null); },
    saveImage: function (data) {
      var b64 = String((data && data.base64) || '');
      var ext = String((data && data.ext) || 'png').toLowerCase().replace(/^\./, '');
      if (!b64 || b64.length * 0.75 > IMAGE_MAX || !MIME[ext]) {
        tell('notice', 'Картинка больше 2 МБ в заметку не кладётся — положите её файлом в Проводник и дайте ссылку');
        return Promise.resolve(null);
      }
      return Promise.resolve('data:' + MIME[ext] + ';base64,' + b64);
    },
    readImage: function (src) {
      var m = /^data:(image\/(?:png|jpeg|gif));base64,(.+)$/.exec(String(src || ''));
      return Promise.resolve(m ? { mime: m[1], base64: m[2] } : null);
    },
    saveImageAs: function () { return Promise.resolve({ ok: false, error: 'Сохраните картинку через «Выгрузить»' }); },
    onViewImage: never,

    // Выгрузка и печать: окно Flux кладёт файл и открывает его
    onExportRequest: on('export'),
    onPrintRequest: on('print'),
    exportDocx: function (req) {
      return ask('exportDocx', { base64: req && req.base64, name: (req && req.suggestedName) || 'Заметка' })
        .then(function (r) { return r && r.ok ? { ok: true, path: r.path || '' } : { ok: false, error: (r && r.error) || 'Не удалось выгрузить' }; });
    },
    exportPdf: function (req) {
      return ask('print', { html: req && req.html, name: (req && req.suggestedName) || 'Заметка' })
        .then(function (r) { return r && r.ok ? { ok: true, canceled: true } : { ok: false, error: (r && r.error) || 'Не удалось напечатать' }; });
    },
    prepareImageExport: function () { return Promise.resolve({ ok: false, error: 'Картинкой не выгружается — выгрузите в Word или напечатайте в PDF' }); },
    writeExportImage: function () { return Promise.resolve({ ok: false }); },
    finishImageExport: function () { return Promise.resolve({ ok: true, canceled: true }); },

    // Язык и вид — как во Flux
    getLanguage: function () { return Promise.resolve('ru'); },
    onLanguageChanged: never,
    getTheme: function () { return ask('theme'); },
    onThemeChanged: on('theme'),
    // Автосохранение редактора включено; чаще его сохраняет окно Flux (3 с тишины)
    getAutoSaveDefault: function () { return Promise.resolve({ on: true, updatedAt: 1 }); },
    onAutoSaveDefaultChanged: never,
    getAiPanelPrefs: function () { return Promise.resolve({ side: 'right', fontSize: 'medium', customFontSize: 14, spellcheck: false }); },
    setAiPanelPrefs: function () { return Promise.resolve({ side: 'right', fontSize: 'medium', customFontSize: 14, spellcheck: false }); },
    onAiPanelPrefsChanged: never,
    onChromePressed: never,

    // Всё, что ходит наружу, — отказ
    getAiSettings: function () { return Promise.resolve({}); },
    aiGskStatus: function () { return Promise.resolve({ loggedIn: false }); },
    aiStream: function () { return Promise.reject(new Error(OFF)); },
    aiStreamCancel: function () { return Promise.resolve(); },
    onAiStream: never,
    webSearch: function () { return Promise.resolve({ results: [], method: 'error', error: OFF }); },
    imageSearch: function () { return Promise.resolve({ images: [], method: 'error', error: OFF }); },
    fetchImage: function () { return Promise.resolve(null); },
    aiGenerateImage: function () { return Promise.resolve({ error: OFF }); },
  };

  window.markdownApi = api;
  window.projectApi = {
    resolveChat: function () { return Promise.resolve(null); },
    appendChat: function () { return Promise.resolve(null); },
    loadChat: function () { return Promise.resolve([]); },
    rebindChat: function () { return Promise.resolve(null); },
  };
  tell('hello', null);

  // Панель ИИ свёрнута, её кнопки и полоса скрыты: во Flux их нет
  try {
    localStorage.setItem('mdapp.showAi', '0');
    localStorage.setItem('mdapp.autoSave', '1');
  } catch (_) {}
  var css = document.createElement('style');
  css.textContent =
    '.ai-dock,.ai-rail,.ai-ask-trigger{display:none!important}' +
    '.ribbon-group:has(.ai-entry){display:none!important}' +
    '.ribbon-group:has(.ai-entry)+.ribbon-sep{display:none!important}' +
    // «Сохранить как» не нужен: заметка одна, копию делает «Выгрузить»; имя
    // вещи и так в заголовке окна Flux, а в строке состояния был бы её номер
    '.qa-save-as,.status-file{display:none!important}';
  (document.head || document.documentElement).appendChild(css);

  var aiLabel = /\b(?:ai|gsk|genspark|copilot|ask\s*ai)\b|(?:^|[^\p{L}\p{N}_])ИИ(?:$|[^\p{L}\p{N}_])|искусственн[\p{L}\p{N}_]*\s+интеллект/iu;
  var aiControl = function (targetNode) {
    if (!targetNode || !targetNode.closest) return false;
    if (targetNode.closest('.ai-entry,.ai-dock,.copilot,.ai-rail,.ai-ask-trigger,.ai-ask-pop,[data-ai],button:has(.ai-feature-icon),[role="menuitem"]:has(.ai-feature-icon),.ctx-item:has(.copilot-badge)')) return true;
    var control = targetNode.closest('button,[role="menuitem"],input,textarea');
    var labelText = control && [control.getAttribute('aria-label'), control.getAttribute('title'), control.getAttribute('data-tip')].filter(Boolean).join(' ');
    return aiLabel.test(labelText || '');
  };
  var removeAiControls = function (root) {
    if (!root || !root.querySelectorAll) return;
    var controls = '.ai-entry,.ai-dock,.copilot,.ai-rail,.ai-ask-trigger,.ai-ask-pop,[data-ai],.ctx-item:has(.copilot-badge),button:has(.ai-feature-icon),[role="menuitem"]:has(.ai-feature-icon),.ribbon-group:has(.ai-entry)';
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(controls)) root.remove();
    root.querySelectorAll(controls).forEach(function (node) { node.remove(); });
    var labelled = 'button,[role="menuitem"],input,textarea';
    var candidates = Array.prototype.slice.call(root.querySelectorAll(labelled));
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(labelled)) candidates.unshift(root);
    candidates.forEach(function (node) {
      var labelText = [node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('data-tip')].filter(Boolean).join(' ');
      if (aiLabel.test(labelText)) node.remove();
    });
  };
  var stopAiControl = function (event) {
    if (!aiControl(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('click', stopAiControl, true);
  document.addEventListener('pointerdown', stopAiControl, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'F7') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if ((event.key === 'Enter' || event.key === ' ') && aiControl(event.target)) stopAiControl(event);
  }, true);
  removeAiControls(document);
  new MutationObserver(function (records) { records.forEach(function (record) { record.addedNodes.forEach(function (node) { if (node.nodeType === Node.ELEMENT_NODE) removeAiControls(node); }); }); }).observe(document.documentElement, { childList: true, subtree: true });

  // Ссылка на тег проекта в заметке ([П1](flux:tag/<id>)): щелчок открывает
  // тег во Flux, а не пытается уйти по незнакомому адресу
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="flux:"]') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    tell('openLink', a.getAttribute('href'));
  }, true);

  // Стикер: только текст, без ленты — окно в ладонь, лента заняла бы его целиком
  var compact = document.createElement('style');
  compact.textContent = '.ribbon{display:none!important}';
  on('compact', true)(function (flag) {
    if (flag && !compact.isConnected) (document.head || document.documentElement).appendChild(compact);
    if (!flag && compact.isConnected) compact.remove();
  });
  // Только чтение: текст не принимает ни мыши, ни клавиш; запись и так
  // отклоняет окно Flux
  var locked = document.createElement('style');
  locked.textContent = '.ProseMirror{pointer-events:none!important;caret-color:transparent}';
  on('readOnly', true)(function (flag) {
    if (flag && !locked.isConnected) (document.head || document.documentElement).appendChild(locked);
    if (!flag && locked.isConnected) locked.remove();
    var pm = document.querySelector('.ProseMirror');
    if (pm) pm.setAttribute('contenteditable', flag ? 'false' : 'true');
  });
})();
