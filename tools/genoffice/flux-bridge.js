/*
 * Мост Flux Office: редактор GenOffice внутри окна Flux.
 *
 * Редактор ждёт от своей оболочки Electron объект window.desktop — открыть,
 * сохранить, недавние, печать, ИИ. Во Flux оболочки GenOffice нет: редактор
 * живёт во фрейме окна Flux. Этот файл подставляет window.desktop сам и
 * переводит нужные вызовы в сообщения окну Flux (postMessage). Окно Flux
 * (src/screens/OfficeHost.tsx) открывает и сохраняет файл через свой сервер —
 * со сверкой версии и откатом.
 *
 * Чего здесь нет намеренно:
 *   - ИИ, вход через Genspark, веб-поиск. Flux работает без интернета, данные
 *     наружу не уходят; такие вызовы отвечают «недоступно»;
 *   - доступа к диску. Файлы видит только окно Flux.
 *
 * Стоит в index.html ДО скриптов редактора (tools/genoffice/build.mjs).
 */
(function () {
  'use strict';
  var parentWin = window.parent;
  var origin = window.location.origin;
  if (!parentWin || parentWin === window) return;
  // Портативная сборка открывает Flux с диска (file://): у такой страницы
  // адреса нет, origin — строка 'null', и отправить «только своему адресу»
  // нельзя. Тогда адресат задаётся самим окном (parentWin), а ответы
  // принимаются только от него
  var target = origin === 'null' ? '*' : origin;
  var sameOrigin = function (o) { return origin === 'null' ? o === 'null' || o === 'file://' : o === origin; };

  var seq = 0;
  var waiting = {};
  var listeners = {};
  /** Последнее значение события: подписавшийся позже узнаёт его сразу */
  var last = {};

  /** Запрос окну Flux; ответ приходит сообщением с тем же номером */
  function ask(op, payload, transfer) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      parentWin.postMessage({ flux: 'office', id: id, op: op, payload: payload || null }, target, transfer || []);
    });
  }

  window.addEventListener('message', function (e) {
    // Только своё окно и свой адрес: чужая страница не должна подсунуть файл
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

  /** Сообщение без ответа: окну Flux достаточно узнать */
  function tell(op, payload) {
    parentWin.postMessage({ flux: 'office', op: op, payload: payload }, target);
  }

  /**
   * Подписка на событие окна Flux. sticky — состояние, а не происшествие:
   * «только просмотр» окно могло сказать до того, как редактор подписался,
   * и такой подписчик получает последнее значение сразу
   */
  function on(event, sticky, map) {
    return function (fn) {
      var call = map ? function (p) { map(p).then(fn); } : fn;
      (listeners[event] = listeners[event] || []).push(call);
      if (sticky && Object.prototype.hasOwnProperty.call(last, event)) { try { call(last[event]); } catch (_) {} }
      return function () { listeners[event] = (listeners[event] || []).filter(function (x) { return x !== call; }); };
    };
  }

  var OFF = { ok: false, error: 'Во Flux Office это отключено: программа работает без внешних сервисов' };

  /** Файл для редактора: байты — одноразовой ссылкой, как в его оболочке */
  function asOpened(r) {
    if (!r) return Promise.resolve(null);
    var url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    return Promise.resolve({ path: 'flux://file/' + r.fileId, name: r.name, dataUrl: url, hash: r.sha256, encrypted: false });
  }
  function openFile() { return ask('open').then(asOpened); }

  function save(path, data, auto) {
    // Путь нужен: после «Сохранить как» редактор пишет уже в копию, а не в
    // исходный файл. Буфер — копией, а не переносом: после сохранения редактор
    // снова читает тот же буфер, а перенесённый обнуляется
    return ask('save', { path: path, bytes: data, auto: auto === true });
  }

  var known = {
    // Открытие и создание
    consumePendingOpenDocx: openFile,
    consumeNewBlankDoc: function () { return ask('isBlank').then(Boolean); },
    consumeAiDocContent: function () { return Promise.resolve(null); },
    consumeHeadlessExport: function () { return Promise.resolve(null); },
    openDocx: function () { return Promise.resolve(null); },
    openDocxPath: function () { return Promise.resolve(null); },
    getRecentFiles: function () { return Promise.resolve([]); },

    // Сохранение: всегда в тот же файл Flux; «Сохранить как» — копией рядом
    saveDocx: function (path, data, auto) { return save(path, data, auto); },
    saveDocxAs: function (name, data) { return ask('saveCopy', { name: name, bytes: data }); },
    saveDocxNew: function (name, data) { return ask('saveCopy', { name: name, bytes: data }); },
    saveDocxTo: function (path, data) { return save(path, data, false); },
    writeRecoveryCopy: function () { return Promise.resolve({ ok: true }); },

    // Язык и вид — как во Flux
    getLanguage: function () { return Promise.resolve('ru'); },
    getTheme: function () { return ask('theme'); },
    onThemeChanged: on('theme'),
    onLanguageChanged: on('language'),
    getAutoSaveDefault: function () { return Promise.resolve(false); },
    // Закрытие окна Flux: окно спрашивает, есть ли несохранённое, редактор
    // отвечает; при «да» окно просит сохранить и ждёт итога
    onCloseCheck: on('closeCheck'),
    reportCloseCheck: function (state) { tell('closeCheck', { dirty: !!(state && state.dirty) }); },
    reportCloseSaveResult: function (ok) { tell('closeSaveResult', ok === true); },
    onCloseSaveRequest: on('closeSave'),
    onTeardown: on('teardown'),
    // Свежая версия, пока окно только смотрит: редактор открывает её на месте
    onOpenDocx: on('open', false, asOpened),
    // Файл правит другой — только просмотр (правка GenOffice, patches.mjs)
    onFluxReadOnly: on('readOnly', true),
  };

  function stub(name) {
    return new Proxy({}, {
      get: function (_, key) {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        if (name === 'desktop' && Object.prototype.hasOwnProperty.call(known, key)) return known[key];
        var k = String(key);
        // ИИ и всё, что ходит наружу, — «недоступно»
        if (/^(ai|gsk|webSearch|imageSearch|fetchImage)/i.test(k)) return function () { return Promise.resolve(OFF); };
        // Подписки: вернуть отписку, событий не будет
        if (/^on[A-Z]/.test(k)) return function () { return function () {}; };
        return function () { return Promise.resolve(null); };
      },
    });
  }

  window.desktop = stub('desktop');
  window.projectApi = stub('projectApi');
  // Окно Flux ждёт этого слова: молчание значит «редактора нет»
  tell('hello', null);

  // Панель ИИ свёрнута с первого запуска, а её кнопки скрыты: во Flux их нет
  try { localStorage.setItem('aidocs.showAi', '0'); } catch (_) {}
  var css = document.createElement('style');
  css.textContent =
    '.ai-dock{display:none!important}' +
    '.ribbon-group:has(.ai-entry){display:none!important}' +
    '.ribbon-group:has(.ai-entry)+.ribbon-sep{display:none!important}';
  (document.head || document.documentElement).appendChild(css);
})();
