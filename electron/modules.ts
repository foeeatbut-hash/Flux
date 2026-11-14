import { app, BrowserWindow, protocol, session, type WebContents } from 'electron';
import { hardenModuleContents, hardenModuleSession } from '../modules/page/harden';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { bundledModules } from '../modules/bundled';
import { MODULE_COMPUTE_HOST, MODULE_SCHEME, MODULE_SHELL_DIR, TS_HOST_FILE, moduleAssetPath, moduleHeaders, pageNavigationAllowed } from '../modules/protocol';
import { CONTROLS_FILE, LOGIC_BUILD_FILE, LOGIC_FILES } from '../modules/engine/types';
import { RUNTIME_FILE } from '../modules/trust/bundle';
import { DEV_RUN_DIR } from '../modules/trust/devRun';
import { FLUX_ASSET_DIR, FLUX_ASSET_FILE, PAGE_URL_FILE, pageTypeOf } from '../modules/page/model';
import type { RunnableRelease } from '../modules/trust/verify';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { ModuleCache } from './moduleCache';
import { ModuleSelection } from './moduleSelection';
import { registerModuleStoreIpc } from './moduleStoreIpc';
import { ModuleControls, registerModuleControlsIpc } from './moduleControls';
import { ModuleConnections, type VerifiedModule } from './moduleConnections';
import { registerConnectionsIpc } from './moduleConnectionsIpc';
import { ModuleProgramCalls, currentRelease } from './moduleProgramCalls';
import { ModuleGrants } from './moduleGrants';
import { ModuleDevRuns } from './moduleDevRuns';
import { registerModuleDevRunsIpc } from './moduleDevRunsIpc';
import { ModuleJournal } from './moduleJournal';
import { ModuleStorage, storageRoot } from './moduleStorage';
import { registerModuleStorageIpc } from './moduleStorageIpc';
import { defaultComBackend, type ComBackend } from './moduleCom';
import type { Lookup } from './moduleNet';

export function registerModuleScheme() {
  // fetch нужен окну Flux (файлы логики из проверенного выпуска) и хосту Python (файлы Pyodide); программам его закрывает
  // их CSP (`connect-src 'none'`). Не выдаём bypassCSP, service workers и доступ к файловой системе.
  protocol.registerSchemesAsPrivileged([{ scheme: MODULE_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } }]);
  app.on('web-contents-created', (_event, contents) => { guardModuleNavigation(contents); hardenModuleContents(contents); });
}
export function guardModuleNavigation(contents: WebContents) {
  // CSP ограничивает ресурсы, но не самостоятельный переход iframe по внешней ссылке.
  contents.on('will-frame-navigate', event => {
    if (!event.frame?.url.startsWith(`${MODULE_SCHEME}:`)) return;
    if (pageNavigationAllowed(event.frame.url, event.url)) return;
    event.preventDefault();
  });
}
const contentType = (file: string) => file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8'
  : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json'
  : file.endsWith('.zip') || file.endsWith('.whl') ? 'application/zip' : file.endsWith('.py') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';

/** Только для проверок: свой корень доверия, каталог и проверка отправителя IPC. В выпуске не передаётся никогда */
export interface ModuleProtocolOptions {
  rootHex?: string;
  dir?: string;
  trusted?: (event: Electron.IpcMainInvokeEvent) => boolean;
  /** Подключения: поддельный COM и своё разрешение имён для проверок; в выпуске не передаются */
  com?: ComBackend;
  lookup?: Lookup;
  /** Папка обмена с Studio (`<данные Flux>/dev-run`) и часы аренды: для проверок; в выпуске не передаются */
  devDir?: string;
  devNow?: () => number;
  /** Корень хранилища программ (`<данные приложения>/program-data`): для проверок; в выпуске не передаётся */
  storageDir?: string;
}

/**
 * Папка данных Flux (`pdm-app`), в которой Studio оставляет пакет разработки. Вычисляется так же, как в
 * electron/main.ts (APPDATA, иначе ~/Library/Application Support или ~/.config) и как у Studio
 * (studio/shared/fluxAddress.ts): три стороны обязаны назвать одну папку.
 */
export function devRunDirectory(): string {
  const home = os.homedir();
  const base = process.env.APPDATA || (process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config'));
  return path.join(base, 'pdm-app', DEV_RUN_DIR);
}

/**
 * Протокол flux-module:// и программы, установленные из Flux Store.
 *
 * Встроенные примеры отдаются из dist как раньше. Программа из базы
 * отдаётся ТОЛЬКО если человек её установил и она есть в кэше проверенных
 * выпусков (electron/moduleCache.ts): runtime.js — из пакета выпуска с
 * подписью владельца, оболочка (index.html, стили, шрифты) — общая из
 * dist/modules/_shell. Окно приносит то, что скачало с сервера, но решает
 * главный процесс: непроверенное сюда не попадает.
 */
export function setupModuleProtocol(distRoot: string, options: ModuleProtocolOptions = {}) {
  hardenModuleSession(session.defaultSession);
  const bundledIds = bundledModules.map(item => item.id);
  const dir = options.dir ?? path.join(app.getPath('userData'), 'modules');
  const cache = new ModuleCache(dir, options.rootHex ?? UPDATE_PUBLIC_KEY_HEX);
  const selection = new ModuleSelection(path.join(dir, 'selection.json'));
  const controls = new ModuleControls(path.join(dir, 'controls.json'), process.versions.electron);
  // base — проверенные выпуски из кэша; runnable — то, что реально запускается: base, а поверх неё пакеты разработки
  // (только с согласием человека и свежей арендой). Встроенный пример с тем же именем остаётся встроенным.
  let base = new Map<string, RunnableRelease>();
  let runnable = new Map<string, RunnableRelease>();
  const resolved = new Map<string, { value: VerifiedModule; release: RunnableRelease } | null>();
  const grants = new ModuleGrants(path.join(dir, 'grants.json'));
  const rootHex = options.rootHex ?? UPDATE_PUBLIC_KEY_HEX;
  const devRuns = new ModuleDevRuns({
    dir: options.devDir ?? devRunDirectory(), rootHex: () => rootHex, revoked: () => cache.revoked(), userId: () => selection.active, reserved: bundledIds, now: options.devNow,
    changed: () => {
      rebuild();
      // Окно Flux узнаёт об изменении событием, а не опросом: пакет мог истечь, появиться или быть убран
      for (const win of BrowserWindow.getAllWindows()) { try { win.webContents.send('modules:devChanged'); } catch { /* окно закрывается */ } }
    },
  });
  const rebuild = () => {
    resolved.clear();
    runnable = new Map(base);
    for (const id of bundledIds) runnable.delete(id);
    const dev = devRuns.active();
    for (const [id, release] of dev) if (!bundledIds.includes(id)) runnable.set(id, release);
    // Решения о подключениях пакета разработки не переживают его самого
    grants.dropDevExcept(new Set(dev.keys()));
  };
  grants.setDevScope(id => devRuns.isActive(id));
  const refresh = async () => {
    try { base = await cache.resolve(selection.versions(), selection.channels); }
    catch (e: any) { console.error('[Модули] Кэш выпусков не прочитан:', e?.message); }
    await devRuns.scan().catch((e: any) => console.error('[Модули] Папка обмена с Studio не прочитана:', e?.message));
    rebuild();
    return runnable;
  };
  const journal = new ModuleJournal(path.join(dir, 'journal.json'));
  const ready = Promise.all([selection.load(), controls.load(), grants.load(), journal.load()]).then(refresh).then(() => { devRuns.start(); });

  protocol.handle(MODULE_SCHEME, async request => {
    await ready;
    await devRuns.touch();
    const asset = moduleAssetPath(request.url, [...bundledIds, ...runnable.keys(), MODULE_COMPUTE_HOST]);
    if (request.method !== 'GET' || !asset) return new Response(null, { status: 404 });
    try {
      // Клиент flux.* и набор Flux — общие, из сборки Flux; программа получает их по /_flux/…, в пакет они не входят
      if (FLUX_ASSET_FILE.test(asset.file)) {
        const data = await fs.readFile(path.join(distRoot, 'modules', FLUX_ASSET_DIR, asset.file.slice(FLUX_ASSET_DIR.length + 1)));
        return new Response(data, { headers: moduleHeaders(contentType(asset.file), false, true) });
      }
      // Страница программы: только файлы ui/… из проверенного пакета; у встроенных примеров страниц нет
      if (PAGE_URL_FILE.test(asset.file)) {
        const release = runnable.get(asset.id);
        const bytes = release?.manifest.ui === 'page' && !controls.blocked(release) ? release.files[asset.file] : undefined;
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(Buffer.from(bytes), { headers: moduleHeaders(pageTypeOf(asset.file)!, false, true) });
      }
      if (asset.id === MODULE_COMPUTE_HOST) {
        const data = await fs.readFile(path.join(distRoot, 'modules', MODULE_COMPUTE_HOST, asset.file));
        // Хост логики TypeScript — со строгим CSP без сети; хост Python (Pyodide читает свои файлы) — с COMPUTE_CSP
        return new Response(data, { headers: moduleHeaders(contentType(asset.file), !TS_HOST_FILE.test(asset.file)) });
      }
      const release = runnable.get(asset.id);
      // Выпуск, чьи контрольные примеры не сошлись на этом компьютере, не отдаёт ни код, ни файлы логики
      const code = asset.file === 'runtime.js' || asset.file.startsWith('logic.') || asset.file === 'controls.json';
      if (release && code && controls.blocked(release)) return new Response(null, { status: 404 });
      if (release && asset.file === 'runtime.js') {
        return new Response(Buffer.from(release.files[RUNTIME_FILE]), { headers: moduleHeaders(contentType(asset.file)) });
      }
      if (asset.file.startsWith('logic.') || asset.file === 'controls.json') {
        // Файлы логики — только из проверенного пакета; у встроенных примеров их нет
        // logic.js — собранный TypeScript (build/logic.js): он есть только у программы с exports, у остальных 404
        const name = asset.file === 'controls.json' ? CONTROLS_FILE : asset.file === 'logic.js' ? LOGIC_BUILD_FILE : Object.values(LOGIC_FILES).find(f => f.endsWith(asset.file.slice(5)));
        const bytes = release && name ? release.files[name] : undefined;
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(Buffer.from(bytes), { headers: moduleHeaders(contentType(asset.file)) });
      }
      const data = await fs.readFile(path.join(distRoot, 'modules', release ? MODULE_SHELL_DIR : asset.id, asset.file));
      return new Response(data, { headers: moduleHeaders(contentType(asset.file)) });
    } catch (_) { return new Response(null, { status: 404 }); }
  });

  const shown = () => { const m = new Map(base); for (const id of bundledIds) m.delete(id); return m; };
  registerModuleStoreIpc({ cache, selection, bundledIds, ready, refresh, runnable: () => runnable, shown, dev: () => devRuns.list(), trusted: options.trusted });
  registerModuleDevRunsIpc({ devRuns, ready, userId: () => selection.active, trusted: options.trusted });
  registerModuleControlsIpc(controls, () => runnable, ready, options.trusted);

  // Подключения к внешним программам: проверенный выпуск — единственный источник разрешения
  const controlsBlocked = (release: RunnableRelease) => controls.blocked(release);
  const resolve = async (moduleId: string, version: string): Promise<VerifiedModule | null> => {
    await ready;
    await devRuns.touch();
    const bundled = bundledModules.find(m => m.id === moduleId && m.version === version);
    if (bundled) return { manifest: bundled, version, author: bundled.author, verifiedAt: 0 };
    // Пакет разработки запускается без установки, но только та сборка, на разрешения которой человек согласился
    const dev = devRuns.active().get(moduleId);
    if (dev && dev.claim.version === version) return controlsBlocked(dev) ? null : { manifest: dev.manifest, version, author: dev.claim.author, verifiedAt: dev.claim.iat };
    if (!selection.installed[moduleId]) return null;
    // Проверка подписей и чтение кэша дороги (десятки мс): результат держится до следующего обновления проверенных выпусков
    const key = `${moduleId}@${version}`;
    if (resolved.has(key)) { const hit = resolved.get(key)!; return hit && !controlsBlocked(hit.release) ? hit.value : null; }
    const release = runnable.get(moduleId)?.claim.version === version ? runnable.get(moduleId)! : (await cache.available(moduleId, selection.channels)).find(r => r.claim.version === version);
    const value = release ? { manifest: release.manifest, version, author: release.claim.author, verifiedAt: release.claim.iat } : null;
    resolved.set(key, value && release ? { value, release } : null);
    return release && !controls.blocked(release) ? value : null;
  };
  const service = new ModuleConnections({ resolve, userId: () => selection.active, grants, journal, comFor: options.com ? () => options.com! : () => defaultComBackend(), lookup: options.lookup });
  // Вызываемая программа — та версия, что запускается у человека сейчас: выбранная, в открытом ему канале, не отозванная и не заблокированная контрольными примерами
  const current = async (moduleId: string): Promise<VerifiedModule | null> => {
    await ready;
    await devRuns.touch();
    const dev = devRuns.active().get(moduleId);
    if (dev) return controlsBlocked(dev) ? null : { manifest: dev.manifest, version: dev.claim.version, author: dev.claim.author, verifiedAt: dev.claim.iat };
    return currentRelease(runnable, selection.installed, controlsBlocked, moduleId);
  };
  // Хранилище самостоятельной программы: область — `dev`, если запускается сборка из разработки именно этой версии (resolve выше
  // отдаёт её же), иначе `released`; каналы выпуска делят одну область, поэтому смена канала данные не теряет
  const storage = new ModuleStorage({
    root: options.storageDir ?? storageRoot(app.getPath('userData')), userId: () => selection.active, journal, writtenBy: () => app.getVersion(),
    locate: async (moduleId, version) => {
      const verified = await resolve(moduleId, version);
      if (!verified) return null;
      const dev = devRuns.active().get(moduleId);
      return { manifest: verified.manifest, version: verified.version, scope: dev && dev.claim.version === version ? 'dev' : 'released' };
    },
  });
  registerModuleStorageIpc({ storage, ready, trusted: options.trusted });
  const programs = new ModuleProgramCalls({ resolve, current, userId: () => selection.active, journal, deniedByPolicy: (id, target) => grants.isDeniedByPolicy(id, target) });
  registerConnectionsIpc({
    service, programs, grants, journal, resolve, ready, userId: () => selection.active, trusted: options.trusted,
    installed: async () => { await ready; return [...runnable.values()].filter(r => selection.installed[r.manifest.id] || devRuns.isActive(r.manifest.id)).map(r => ({ manifest: r.manifest, version: r.claim.version, author: r.claim.author, verifiedAt: r.claim.iat })); },
  });
  app.on('before-quit', () => { devRuns.stop(); void service.shutdown(); void journal.flush(); });
  return { service, journal, grants, devRuns, storage };
}
