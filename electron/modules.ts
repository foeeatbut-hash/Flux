import { app, protocol, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bundledModules } from '../modules/bundled';
import { MODULE_SCHEME, MODULE_SHELL_DIR, moduleAssetPath, moduleHeaders } from '../modules/protocol';
import { RUNTIME_FILE } from '../modules/trust/bundle';
import type { RunnableRelease } from '../modules/trust/verify';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { ModuleCache } from './moduleCache';
import { ModuleSelection } from './moduleSelection';
import { registerModuleStoreIpc } from './moduleStoreIpc';
import { setupModuleSigning } from './moduleSigning';

export function registerModuleScheme() {
  // Не выдаём bypassCSP, fetch, service workers и доступ к файловой системе.
  protocol.registerSchemesAsPrivileged([{ scheme: MODULE_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } }]);
  app.on('web-contents-created', (_event, contents) => guardModuleNavigation(contents));
}
export function guardModuleNavigation(contents: WebContents) {
  // CSP ограничивает ресурсы, но не самостоятельный переход iframe по внешней ссылке.
  contents.on('will-frame-navigate', event => {
    if (event.frame?.url.startsWith(`${MODULE_SCHEME}:`)) event.preventDefault();
  });
}
const contentType = (file: string) => file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8'
  : file.endsWith('.woff2') ? 'font/woff2' : 'text/html; charset=utf-8';

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
export function setupModuleProtocol(distRoot: string) {
  const bundledIds = bundledModules.map(item => item.id);
  const dir = path.join(app.getPath('userData'), 'modules');
  const cache = new ModuleCache(dir, UPDATE_PUBLIC_KEY_HEX);
  const selection = new ModuleSelection(path.join(dir, 'selection.json'));
  let runnable = new Map<string, RunnableRelease>();
  const refresh = async () => {
    try { runnable = await cache.resolve(selection.versions(), selection.channels); }
    catch (e: any) { console.error('[Модули] Кэш выпусков не прочитан:', e?.message); }
    // Встроенный пример с тем же именем остаётся встроенным: выпуск его не подменяет
    for (const id of bundledIds) runnable.delete(id);
    return runnable;
  };
  const ready = selection.load().then(refresh);

  protocol.handle(MODULE_SCHEME, async request => {
    await ready;
    const asset = moduleAssetPath(request.url, [...bundledIds, ...runnable.keys()]);
    if (request.method !== 'GET' || !asset) return new Response(null, { status: 404 });
    try {
      const release = runnable.get(asset.id);
      if (release && asset.file === 'runtime.js') {
        return new Response(Buffer.from(release.files[RUNTIME_FILE]), { headers: moduleHeaders(contentType(asset.file)) });
      }
      const data = await fs.readFile(path.join(distRoot, 'modules', release ? MODULE_SHELL_DIR : asset.id, asset.file));
      return new Response(data, { headers: moduleHeaders(contentType(asset.file)) });
    } catch (_) { return new Response(null, { status: 404 }); }
  });

  registerModuleStoreIpc({ cache, selection, bundledIds, ready, refresh, runnable: () => runnable });
  setupModuleSigning();
}
