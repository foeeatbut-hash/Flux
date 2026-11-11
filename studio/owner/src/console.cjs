'use strict';
/**
 * Разделы Studio — Владелец: запросы на публикацию, выпуски и каналы, сертификаты разработчиков,
 * обновления Flux. Раньше всё это жило во Flux (экран «Запросы на публикацию», окно подписи,
 * вкладка «Обновления» в «Сотрудниках»); теперь только здесь, у владельца.
 *
 * Окно разделов ничего не подписывает и не решает: оно называет действие, а главный процесс
 * сам берёт пакет с сервера, строит то, что подписывается (modules/trust/owner.ts), спрашивает
 * подтверждение собственным диалогом и только потом подписывает ключом из открытого хранилища.
 * Фраза-пароль в окне не вводится: хранилище отпирается в общем состоянии с окном лицензий.
 */
const path = require('node:path');
const { consoleRequest, routeAllowed } = require('./consoleApi.cjs');
const { signModule } = require('./moduleSigning.ts');
const { signCampaign, CAMPAIGN_MAX_TARGETS } = require('./campaigns.ts');
const { unpackBundle, packBundle, bundleText, RUNTIME_FILE } = require('../../../modules/trust/bundle.ts');
const { describeBundle } = require('../../../modules/trust/verify.ts');
const { ownerMayEdit, ownerEditViolations, OWNER_EDIT_REFUSAL } = require('../../../modules/trust/ownerEdit.ts');

const b64 = bytes => Buffer.from(bytes).toString('base64');
const text = (value, max = 20000) => { if (typeof value !== 'string' || value.length > max) throw new Error('Некорректные данные формы.'); return value; };
const idOf = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Некорректный номер.'); return value; };
const CHANNEL = { test: 'тестовый', production: 'рабочий' };
const channelOf = value => { if (!CHANNEL[value]) throw new Error('Неизвестный канал выпуска.'); return value; };
const sha256Of = bytes => describeBundle(bytes).sha256;
const when = ms => (ms ? new Date(ms).toLocaleString('ru') : 'сразу');

/**
 * Действия разделов. `ctx` даёт состояние главного процесса (хранилище, токен, подтверждение);
 * `request` подменяется проверками, настоящий — consoleRequest.
 */
function createConsoleActions(ctx, request = consoleRequest) {
  const api = (method, route, body = null, binary = false) => {
    if (!ctx.token()) throw new Error('Подключитесь к общей БД компании.');
    return request(ctx.origin(), method, route, { body, token: ctx.token(), binary });
  };
  const needVault = () => { const vault = ctx.vault(); if (!vault) throw new Error('Сначала разблокируйте хранилище.'); if (vault.kind !== 'main') throw new Error('Запасной ключ не подписывает выпуски: откройте основное хранилище.'); return vault; };
  const need = () => { const vault = needVault(); if (!ctx.token()) throw new Error('Подключитесь к общей БД компании.'); return vault; };
  const confirm = async (message, detail) => { if (!await ctx.confirm(message, detail)) throw Object.assign(new Error('Подпись отменена.'), { canceled: true }); };
  const loadRequest = async id => {
    const [{ request: row, signature }, diff, bundle] = await Promise.all([
      api('GET', `/api/modules/requests/${id}`), api('GET', `/api/modules/requests/${id}/diff`), api('GET', `/api/modules/requests/${id}/bundle`, null, true)]);
    return { request: row, signature, diff, bundle };
  };
  // Окно показывало пакет с этим хешем: если на сервере он стал другим, подписывать нельзя
  const sameBundle = (bundle, expected) => { if (sha256Of(bundle) !== text(expected, 100)) throw new Error('Пакет на сервере изменился после того, как вы его открыли. Откройте запрос заново.'); };

  const actions = {
    ...Object.fromEntries(['state', 'unlock', 'connect', 'disconnect', 'lock', 'cancel'].map(name => [name, async a => ctx.forward[name](a)])),

    // ---- Запросы на публикацию
    requests: async () => ({ requests: (await api('GET', '/api/modules/requests')).requests }),
    request: async a => {
      const id = idOf(a.id), loaded = await loadRequest(id);
      return { request: loaded.request, signature: loaded.signature, diff: loaded.diff, bundle: b64(loaded.bundle), sha256: sha256Of(loaded.bundle) };
    },
    returnRequest: async a => {
      const comments = Array.isArray(a.comments) ? a.comments.slice(0, 200).map(c => ({ path: text(c.path, 300), line: Number.isInteger(c.line) && c.line > 0 ? c.line : null, text: text(c.text, 4000) })) : [];
      await api('POST', `/api/modules/requests/${idOf(a.id)}/return`, { note: text(a.note, 8000), comments });
      return { done: true };
    },
    rejectRequest: async a => {
      if (!text(a.reason, 8000).trim()) throw new Error('Укажите причину отказа.');
      await api('POST', `/api/modules/requests/${idOf(a.id)}/reject`, { reason: a.reason });
      return { done: true };
    },
    release: async a => {
      const vault = need(), id = idOf(a.id), channel = channelOf(a.channel), notBefore = Number(a.notBefore) || 0;
      if (notBefore < 0 || !Number.isSafeInteger(notBefore)) throw new Error('Неверная дата выпуска.');
      const { request: row, signature, bundle } = await loadRequest(id);
      sameBundle(bundle, a.sha256);
      if (row.state !== 'pending') throw new Error('Запрос уже решён.');
      await confirm(`Выпустить ${row.moduleId} ${row.version}?`, `Канал: ${CHANNEL[channel]}\nКогда: ${when(notBefore)}\nПакет: ${sha256Of(bundle).slice(0, 16)}…\n\nВыпуск подписывается вашим ключом из хранилища и сразу уходит в Flux Store.`);
      const signed = signModule(vault, { kind: 'release', requestId: id, requestSignature: signature, bundle: b64(bundle), channel, notBefore });
      const out = await api('POST', `/api/modules/requests/${id}/release`, { signature: signed });
      return { release: out.release, duplicate: !!out.duplicate, sha256: sha256Of(bundle) };
    },
    ownerEdit: async a => {
      const vault = need(), id = idOf(a.id);
      const { request: row, signature, bundle } = await loadRequest(id);
      sameBundle(bundle, a.sha256);
      if (row.state !== 'pending') throw new Error('Запрос уже решён.');
      const files = unpackBundle(bundle), edits = a.texts && typeof a.texts === 'object' ? Object.entries(a.texts) : [];
      if (!edits.length) throw new Error('Нет изменений.');
      const original = { ...files };
      for (const [file, content] of edits) {
        // Код и runtime.js владелец не правит: правка исходника не пересобирает runtime.js (проверяет и сервер)
        if (!ownerMayEdit(text(file, 300))) throw new Error(`${OWNER_EDIT_REFUSAL} Файл: ${file}.`);
        if (bundleText(files, file) === null) throw new Error(`Файл ${text(file, 300)} нельзя править как текст.`);
        files[file] = Buffer.from(text(content, 4 * 1024 * 1024), 'utf8');
      }
      const next = packBundle(files);
      if (ownerEditViolations(original, unpackBundle(next)).length) throw new Error(OWNER_EDIT_REFUSAL);
      const nextSha = sha256Of(next);
      await confirm(`Подписать правку ${row.moduleId} ${row.version}?`, `Изменено файлов: ${edits.length}\nПакет после правки: ${nextSha.slice(0, 16)}… (прежний ${sha256Of(bundle).slice(0, 16)}…)\nПравка уходит отдельным запросом от владельца; разработчик увидит её отдельной разницей.`);
      const signed = signModule(vault, { kind: 'owner-edit', parentRequestId: id, parentSignature: signature, bundle: b64(next), comment: text(a.comment || '', 4000) });
      // Хеш считается заново из байт правки: следующий выпуск сверяется уже с ним, а не с пакетом разработчика
      return { ...(await api('POST', '/api/modules/requests', { signature: signed, bundle: b64(next) })), sha256: nextSha };
    },

    // ---- Выпуски и каналы
    releases: async () => ({ releases: (await api('GET', '/api/modules/releases')).releases }),
    testers: async () => api('GET', '/api/modules/testers'),
    saveTesters: async a => { if (!Array.isArray(a.testers) || a.testers.length > 5000) throw new Error('Некорректный список.'); return api('PUT', '/api/modules/testers', { testers: a.testers.map(x => idOf(x)) }); },
    promote: async a => {
      const vault = need(), release = (await api('GET', '/api/modules/releases')).releases.find(r => r.id === idOf(a.releaseId));
      if (!release) throw new Error('Выпуск не найден.');
      await confirm(`Перевести ${release.moduleId} ${release.version} в рабочий канал?`, 'Выпуск станет доступен всем в рабочем канале.');
      await api('POST', '/api/modules/promotions', { signature: signModule(vault, { kind: 'promotion', releaseSignature: release.signature }) });
      return { done: true };
    },
    pin: async a => {
      const vault = need(), moduleId = text(a.moduleId, 100), channel = channelOf(a.channel), version = a.version ? text(a.version, 40) : null;
      await confirm(version ? `Вернуть канал «${CHANNEL[channel]}» на ${moduleId} ${version}?` : `Снять откат: ${moduleId}, канал «${CHANNEL[channel]}»`,
        version ? 'Выпуски этого канала выше выбранной версии у всех перестанут запускаться.' : 'Выпуски канала снова запускаются по общим правилам.');
      await api('POST', '/api/modules/pins', { signature: signModule(vault, { kind: 'pin', moduleId, channel, version, reason: text(a.reason || '', 2000) }) });
      return { done: true };
    },
    revoke: async a => {
      const vault = need(), target = a.target === 'key' ? 'key' : 'release', value = text(a.value, 200);
      await confirm(target === 'key' ? 'Отозвать ключ разработчика?' : `Отозвать выпуск ${value}?`, 'Отзыв действует сразу у всех: выпуск перестаёт запускаться, работает прошлый проверенный.');
      await api('POST', '/api/modules/revocations', { signature: signModule(vault, { kind: 'revocation', target, value, reason: text(a.reason || '', 2000) }) });
      return { done: true };
    },

    // ---- Сертификаты разработчиков
    certificates: async () => ({ certificates: (await api('GET', '/api/modules/certificates')).certificates, requests: (await api('GET', '/api/modules/certificate-requests')).requests }),
    certify: async a => {
      const vault = need(), key = text(a.key, 64), userId = text(a.userId, 100), name = text(a.name || '', 200);
      await confirm('Выдать сертификат разработчика?', `Профиль: ${userId}\nИмя: ${name || '—'}\nКлюч: ${key.slice(0, 16)}…\n\nС этим сертификатом разработчик сможет присылать программы на проверку.`);
      await api('POST', '/api/modules/certificates', { signature: signModule(vault, { kind: 'certificate', key, userId, name }) });
      return { done: true };
    },
    declineCertificate: async a => { await api('POST', '/api/modules/certificate-requests/decline', { key: text(a.key, 64) }); return { done: true }; },

    // ---- Обновления Flux: назначение компьютерам
    devices: async () => api('GET', '/api/updates/devices'),
    assignUpdate: async a => {
      const vault = need(), action = a.action === 'cancel' ? 'cancel' : 'schedule';
      const state = await api('GET', '/api/updates/devices');
      const chosen = new Set(Array.isArray(a.devices) ? a.devices.map(x => text(x, 200)) : []);
      const pool = state.devices.filter(d => chosen.has(`${d.deviceId}:${d.userId}`));
      if (!pool.length || pool.length !== chosen.size) throw new Error('Устройство или его профиль изменились. Обновите список.');
      if (pool.length > CAMPAIGN_MAX_TARGETS) throw new Error(`За одно назначение — не больше ${CAMPAIGN_MAX_TARGETS} устройств.`);
      const user = ctx.user();
      if (!user?.id) throw new Error('Подключитесь к общей БД компании.');
      let groups;
      if (action === 'schedule') {
        const release = state.releases.find(r => r.version === text(a.version, 40));
        if (!release) throw new Error('Выпуск недоступен или отозван. Обновите список.');
        groups = [{ release, targets: pool }];
      } else {
        // Отмена привязана к тому выпуску, который устройству назначен сейчас
        const by = new Map();
        for (const d of pool) {
          if (d.action !== 'schedule' || !d.commandRelease) throw new Error('У выбранного устройства нет назначения, которое можно отменить.');
          const g = by.get(d.commandId) || { release: { ...d.commandRelease, signature: d.commandRelease.releaseSignature }, targets: [] };
          g.targets.push(d); by.set(d.commandId, g);
        }
        groups = [...by.values()];
      }
      const names = pool.slice(0, 8).map(d => `${d.name} · ${d.deviceId.slice(0, 8)} · ${d.version || '?'}`).join('\n');
      await confirm(action === 'cancel' ? 'Отменить назначение обновления?' : `Назначить обновление ${groups[0].release.version}?`,
        `Устройств: ${pool.length}${action === 'schedule' ? `\nОбновление начнётся через ${Number(a.minutes)} мин.` : ''}\n\n${names}${pool.length > 8 ? '\n…' : ''}`);
      const ids = [];
      for (const g of groups) {
        const signed = signCampaign(vault, { inst: state.inst, actor: user.id, action, minutes: a.minutes, release: g.release,
          targets: g.targets.map(d => ({ deviceId: d.deviceId, userId: d.userId, previous: d.commandId })) });
        ids.push((await api('POST', '/api/updates/campaigns', signed)).id);
      }
      return { ids };
    },

    // ---- Пробный запуск: страница подпрограммы из пакета запроса, который сейчас на экране
    trialLoad: async a => {
      // Берётся тот же пакет, что показан на экране: запуск не может отличаться от просмотра
      const id = idOf(a.id), loaded = await actions.request({ id });
      const files = unpackBundle(Buffer.from(loaded.bundle, 'base64'));
      const runtime = files[RUNTIME_FILE];
      if (!runtime) throw new Error('В пакете нет собранной программы (build/runtime.js).');
      trial = { id, runtime };
      return { manifest: JSON.parse(Buffer.from(files['manifest.json'] || '{}').toString('utf8')) };
    },
  };
  return actions;
}

// ---- Окно
const TRIAL_HTML = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>'
  + 'body{margin:0;font:13px/1.45 system-ui,"Segoe UI",sans-serif;background:var(--flux-surface);color:var(--flux-text)}main{padding:12px}'
  + 'input,select,textarea,button{font:inherit;color:inherit;background:var(--flux-bg);border:1px solid var(--flux-line);border-radius:6px;padding:4px 8px}'
  + 'label{display:block;margin:6px 0}table{border-collapse:collapse}td,th{border-bottom:1px solid var(--flux-line);padding:3px 8px;text-align:left}'
  + '</style></head><body><main id="module-root">Загрузка…</main><script src="./runtime.js"></script></body></html>';
const SCHEME = 'flux-module';
let consoleWindow = null, trial = null, handlerSet = false;
const trialState = () => trial;

/** Пробный запуск: страница и runtime.js берутся из пакета запроса, который сейчас на экране; больше ничего не отдаётся */
function trialHandler({ protocol }, CSP) {
  if (handlerSet || !protocol?.handle) return;
  handlerSet = true;
  const headers = type => ({ 'Content-Type': type, 'Content-Security-Policy': CSP, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  protocol.handle(SCHEME, request => {
    let url; try { url = new URL(request.url); } catch { return new Response(null, { status: 404 }); }
    if (request.method !== 'GET' || url.hostname !== 'trial' || !trial) return new Response(null, { status: 404 });
    if (url.pathname === '/' || url.pathname === '/index.html') return new Response(TRIAL_HTML, { headers: headers('text/html; charset=utf-8') });
    if (url.pathname === '/runtime.js') return new Response(Buffer.from(trial.runtime), { headers: headers('text/javascript; charset=utf-8') });
    return new Response(null, { status: 404 });
  });
}

const FORWARDED = ['state', 'unlock', 'connect', 'disconnect', 'lock', 'cancel'];
const TABS = new Set(['requests', 'releases', 'certificates', 'updates']);
const ALLOWED = ['state', 'unlock', 'connect', 'disconnect', 'lock', 'cancel', 'requests', 'request', 'returnRequest', 'rejectRequest', 'release', 'ownerEdit',
  'releases', 'testers', 'saveTesters', 'promote', 'pin', 'revoke', 'certificates', 'certify', 'declineCertificate', 'devices', 'assignUpdate', 'trialLoad'];

async function openConsole(ctx, tab = 'requests') {
  const electron = require('electron');
  const { BrowserWindow, ipcMain } = electron;
  const startTab = TABS.has(tab) ? tab : 'requests';
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleWindow.isMinimized()) consoleWindow.restore();
    consoleWindow.focus(); consoleWindow.webContents.send('console:tab', startTab); return;
  }
  const { MODULE_CSP } = require('../../../modules/protocol.ts');
  trialHandler(electron, MODULE_CSP);
  await ctx.refreshVault();
  const actions = createConsoleActions(ctx);
  const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 900, minHeight: 600, title: `Flux Studio — Владелец ${ctx.version}`, backgroundColor: '#101722',
    webPreferences: { preload: path.join(__dirname, 'console-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  consoleWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const handler = async (event, action, args = {}) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !ALLOWED.includes(action) || !Object.hasOwn(actions, action)) return { ok: false, error: 'Недоступное действие.' };
    const span = ctx.journal().beginOperation(`console.${action}`);
    try {
      ctx.touch(); ctx.setParent(win);
      const value = await ctx.diagnosticOperation.run(span, () => actions[action](args && typeof args === 'object' ? args : {}));
      span.finish(null, {});
      return { ok: true, value: FORWARDED.includes(action) ? publicState(ctx) : value };
    } catch (error) {
      span.fail(error);
      return { ok: false, canceled: error?.canceled === true, error: ctx.journal().redact(error?.message || 'Операция не выполнена.') };
    } finally { ctx.setParent(null); }
  };
  ipcMain.handle('console:action', handler);
  const send = name => () => { if (!win.isDestroyed()) win.webContents.send(name); };
  const onLocked = send('console:locked'), onDisconnected = send('console:disconnected');
  ctx.listeners.locked.add(onLocked); ctx.listeners.disconnected.add(onDisconnected);
  // Хранилище запирается через 15 минут без действий, как в окне лицензий
  const timer = setInterval(() => ctx.lockIfIdle(15 * 60 * 1000), 30000); timer.unref();
  win.on('closed', () => {
    clearInterval(timer); ipcMain.removeHandler('console:action');
    ctx.listeners.locked.delete(onLocked); ctx.listeners.disconnected.delete(onDisconnected);
    consoleWindow = null; trial = null;
  });
  await win.loadFile(path.join(__dirname, '..', 'ui', 'console', 'index.html'), { query: { tab: startTab } });
}

/** Что окно знает о состоянии: без ключей, лицензий и реестров */
function publicState(ctx) {
  const s = ctx.snapshot();
  return { version: s.version, unlocked: s.unlocked, vaultExists: s.vaultExists, backupSession: s.backupSession, kind: s.kind, connected: !!ctx.token(), display: ctx.display(), user: ctx.user() ? { id: ctx.user().id, name: ctx.user().name } : null };
}

module.exports = { createConsoleActions, openConsole, routeAllowed, publicState, trialState, ALLOWED };
