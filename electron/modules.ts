import { app, ipcMain, protocol, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { bundledModules } from '../modules/bundled';
import { MODULE_SCHEME, MODULE_SHELL_DIR, moduleAssetPath, moduleHeaders } from '../modules/protocol';
import { RUNTIME_FILE } from '../modules/trust/bundle';
import type { RunnableRelease } from '../modules/trust/verify';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { ModuleCache, type ReleaseRow } from './moduleCache';
import { MODULE_CHANNELS, type ModuleChannel } from '../modules/trust/claims';
import { trustedAuthSender } from './authStorage';
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

/** Сколько и чего окно может прислать на проверку за раз: выпуски небольшие, а память главного процесса общая */
const SYNC_MAX_RELEASES = 200;
const SYNC_MAX_CHUNKS = 200;

/**
 * Протокол flux-module:// и выпуски модулей из общей базы.
 *
 * Встроенные примеры отдаются из dist как раньше. Модуль из базы отдаётся
 * ТОЛЬКО из кэша проверенных выпусков (electron/moduleCache.ts): runtime.js —
 * из пакета выпуска с подписью владельца, оболочка (index.html, стили,
 * шрифты) — общая из dist/modules/_shell. Окно приносит то, что скачало с
 * сервера, но решает главный процесс: непроверенное сюда не попадает.
 */
export function setupModuleProtocol(distRoot: string) {
  const bundledIds = bundledModules.map(item => item.id);
  const cache = new ModuleCache(path.join(app.getPath('userData'), 'modules'), UPDATE_PUBLIC_KEY_HEX);
  let runnable = new Map<string, RunnableRelease>();
  // Каналы человека назначает владелец (тестовый — назначенным). Хранятся рядом с кэшем,
  // чтобы тестировщик и без связи с базой запускал свой выпуск; по умолчанию — только рабочий
  const channelsFile = path.join(app.getPath('userData'), 'modules', 'channels.json');
  let channels: ModuleChannel[] = ['production'];
  const readChannels = (value: unknown): ModuleChannel[] => {
    const list = (Array.isArray(value) ? value : []).filter((c): c is ModuleChannel => MODULE_CHANNELS.includes(c as ModuleChannel));
    return list.includes('production') ? list : ['production', ...list];
  };
  const loadedChannels = fs.readFile(channelsFile, 'utf8').then(text => { channels = readChannels(JSON.parse(text)); }).catch(() => {});
  const refresh = async () => {
    try { runnable = await cache.runnable(channels); }
    catch (e: any) { console.error('[Модули] Кэш выпусков не прочитан:', e?.message); }
    // Встроенный пример с тем же именем остаётся встроенным: выпуск его не подменяет
    for (const id of bundledIds) runnable.delete(id);
    return runnable;
  };
  const ready = loadedChannels.then(refresh);
  const describe = (list: Map<string, RunnableRelease>) => [...list.values()].map(r => ({
    manifest: r.manifest, version: r.claim.version, channel: r.claim.channel, author: r.claim.author,
  }));

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

  ipcMain.handle('modules:state', async event => {
    if (!trustedAuthSender(event)) return { ok: false, error: 'Доступно только окну Flux.' };
    await ready;
    return { ok: true, cached: await cache.cached(), runnable: describe(runnable) };
  });
  ipcMain.handle('modules:sync', async (event, data: any) => {
    if (!trustedAuthSender(event)) return { ok: false, error: 'Доступно только окну Flux.' };
    const pins = Array.isArray(data?.pins) ? data.pins.filter((s: unknown) => typeof s === 'string').slice(0, 5000) : [];
    if (Array.isArray(data?.channels)) {
      channels = readChannels(data.channels);
      await fs.mkdir(path.dirname(channelsFile), { recursive: true });
      await fs.writeFile(channelsFile, JSON.stringify(channels)).catch(() => {});
    }
    const revocations = Array.isArray(data?.revocations) ? data.revocations.filter((s: unknown) => typeof s === 'string').slice(0, 10000) : [];
    const releases = Array.isArray(data?.releases) ? data.releases.slice(0, SYNC_MAX_RELEASES) : [];
    await cache.addRevocations(revocations);
    await cache.addPins(pins);
    const installed: string[] = [], broken: Array<{ moduleId: string; version: string; why: string }> = [];
    for (const r of releases) {
      if (!r || !Array.isArray(r.chunks) || r.chunks.length > SYNC_MAX_CHUNKS) continue;
      const row: ReleaseRow = { id: String(r.id || ''), moduleId: String(r.moduleId || ''), version: String(r.version || ''), signature: String(r.signature || '') };
      try {
        const result = await cache.install(row, r.chunks.map((c: unknown) => new Uint8Array(Buffer.from(String(c), 'base64'))));
        if (result.ok) installed.push(`${row.moduleId}@${row.version}`);
        else broken.push({ moduleId: row.moduleId, version: row.version, why: result.why || '' });
      } catch (e: any) { broken.push({ moduleId: row.moduleId, version: row.version, why: e?.message || 'Не проверен' }); }
    }
    await cache.prune().catch(() => {});
    return { ok: true, installed, broken, runnable: describe(await refresh()) };
  });
  setupModuleSigning();
}
