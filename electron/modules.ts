import { app, protocol, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bundledModules } from '../modules/bundled';
import { MODULE_COMPUTE_HOST, MODULE_SCHEME, MODULE_SHELL_DIR, moduleAssetPath, moduleHeaders } from '../modules/protocol';
import { CONTROLS_FILE, LOGIC_FILES } from '../modules/engine/types';
import { RUNTIME_FILE } from '../modules/trust/bundle';
import type { RunnableRelease } from '../modules/trust/verify';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { ModuleCache } from './moduleCache';
import { ModuleSelection } from './moduleSelection';
import { registerModuleStoreIpc } from './moduleStoreIpc';
import { setupModuleSigning } from './moduleSigning';
import { ModuleControls, registerModuleControlsIpc } from './moduleControls';
import { ModuleConnections, type VerifiedModule } from './moduleConnections';
import { registerConnectionsIpc } from './moduleConnectionsIpc';
import { ModuleGrants } from './moduleGrants';
import { ModuleJournal } from './moduleJournal';
import { defaultComBackend, type ComBackend } from './moduleCom';
import type { Lookup } from './moduleNet';

export function registerModuleScheme() {
  // fetch нужен окну Flux (файлы логики из проверенного выпуска) и хосту Python (файлы Pyodide); подпрограммам его закрывает
  // их CSP (`connect-src 'none'`). Не выдаём bypassCSP, service workers и доступ к файловой системе.
  protocol.registerSchemesAsPrivileged([{ scheme: MODULE_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } }]);
  app.on('web-contents-created', (_event, contents) => guardModuleNavigation(contents));
}
export function guardModuleNavigation(contents: WebContents) {
  // CSP ограничивает ресурсы, но не самостоятельный переход iframe по внешней ссылке.
  contents.on('will-frame-navigate', event => {
    if (event.frame?.url.startsWith(`${MODULE_SCHEME}:`)) event.preventDefault();
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
}

/**
 * Протокол flux-module:// и подпрограммы, установленные из Flux Store.
 *
 * Встроенные примеры отдаются из dist как раньше. Подпрограмма из базы
 * отдаётся ТОЛЬКО если человек её установил и она есть в кэше проверенных
 * выпусков (electron/moduleCache.ts): runtime.js — из пакета выпуска с
 * подписью владельца, оболочка (index.html, стили, шрифты) — общая из
 * dist/modules/_shell. Окно приносит то, что скачало с сервера, но решает
 * главный процесс: непроверенное сюда не попадает.
 */
export function setupModuleProtocol(distRoot: string, options: ModuleProtocolOptions = {}) {
  const bundledIds = bundledModules.map(item => item.id);
  const dir = options.dir ?? path.join(app.getPath('userData'), 'modules');
  const cache = new ModuleCache(dir, options.rootHex ?? UPDATE_PUBLIC_KEY_HEX);
  const selection = new ModuleSelection(path.join(dir, 'selection.json'));
  const controls = new ModuleControls(path.join(dir, 'controls.json'), process.versions.electron);
  let runnable = new Map<string, RunnableRelease>();
  const resolved = new Map<string, { value: VerifiedModule; release: RunnableRelease } | null>();
  const refresh = async () => {
    resolved.clear();
    try { runnable = await cache.resolve(selection.versions(), selection.channels); }
    catch (e: any) { console.error('[Модули] Кэш выпусков не прочитан:', e?.message); }
    // Встроенный пример с тем же именем остаётся встроенным: выпуск его не подменяет
    for (const id of bundledIds) runnable.delete(id);
    return runnable;
  };
  const grants = new ModuleGrants(path.join(dir, 'grants.json'));
  const journal = new ModuleJournal(path.join(dir, 'journal.json'));
  const ready = Promise.all([selection.load(), controls.load(), grants.load(), journal.load()]).then(refresh);

  protocol.handle(MODULE_SCHEME, async request => {
    await ready;
    const asset = moduleAssetPath(request.url, [...bundledIds, ...runnable.keys(), MODULE_COMPUTE_HOST]);
    if (request.method !== 'GET' || !asset) return new Response(null, { status: 404 });
    try {
      if (asset.id === MODULE_COMPUTE_HOST) {
        const data = await fs.readFile(path.join(distRoot, 'modules', MODULE_COMPUTE_HOST, asset.file));
        return new Response(data, { headers: moduleHeaders(contentType(asset.file), true) });
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
        const name = asset.file === 'controls.json' ? CONTROLS_FILE : Object.values(LOGIC_FILES).find(f => f.endsWith(asset.file.slice(5)));
        const bytes = release && name ? release.files[name] : undefined;
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(Buffer.from(bytes), { headers: moduleHeaders(contentType(asset.file)) });
      }
      const data = await fs.readFile(path.join(distRoot, 'modules', release ? MODULE_SHELL_DIR : asset.id, asset.file));
      return new Response(data, { headers: moduleHeaders(contentType(asset.file)) });
    } catch (_) { return new Response(null, { status: 404 }); }
  });

  registerModuleStoreIpc({ cache, selection, bundledIds, ready, refresh, runnable: () => runnable });
  registerModuleControlsIpc(controls, () => runnable, ready, options.trusted);
  setupModuleSigning();

  // Подключения к внешним программам: проверенный выпуск — единственный источник разрешения
  const controlsBlocked = (release: RunnableRelease) => controls.blocked(release);
  const resolve = async (moduleId: string, version: string): Promise<VerifiedModule | null> => {
    await ready;
    const bundled = bundledModules.find(m => m.id === moduleId && m.version === version);
    if (bundled) return { manifest: bundled, version, author: bundled.author, verifiedAt: 0 };
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
  registerConnectionsIpc({
    service, grants, journal, resolve, ready, userId: () => selection.active, trusted: options.trusted,
    installed: async () => { await ready; return [...runnable.values()].filter(r => selection.installed[r.manifest.id]).map(r => ({ manifest: r.manifest, version: r.claim.version, author: r.claim.author, verifiedAt: r.claim.iat })); },
  });
  app.on('before-quit', () => { void service.shutdown(); void journal.flush(); });
  return { service, journal, grants };
}
