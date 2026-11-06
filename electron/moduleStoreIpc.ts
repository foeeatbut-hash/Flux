/**
 * Каналы IPC Flux Store: проверка выпусков, выбор установленного, возврат версии.
 *
 * Окно приносит скачанное и решение человека («поставить», «вернуть»), но
 * решает главный процесс: в кэш попадает только проверенное по подписи
 * владельца, ставится только то, что в кэше проверено, и разрешения, которые
 * человек видел в окне, сверяются с разрешениями проверенного манифеста.
 */
import { ipcMain } from 'electron';
import { permissionsDigest } from '../modules/store/model';
import type { RunnableRelease } from '../modules/trust/verify';
import { trustedAuthSender } from './authStorage';
import type { ModuleCache, ReleaseRow } from './moduleCache';
import type { ModuleSelection } from './moduleSelection';

/** Сколько и чего окно может прислать на проверку за раз: выпуски небольшие, а память главного процесса общая */
const SYNC_MAX_RELEASES = 200;
const SYNC_MAX_CHUNKS = 200;

export interface ModuleHost {
  cache: ModuleCache;
  selection: ModuleSelection;
  bundledIds: string[];
  ready: Promise<unknown>;
  refresh: () => Promise<Map<string, RunnableRelease>>;
  runnable: () => Map<string, RunnableRelease>;
}

const refuse = { ok: false, error: 'Доступно только окну Flux.' };

export function registerModuleStoreIpc(host: ModuleHost) {
  const { cache, selection } = host;
  const describe = (r: RunnableRelease) => ({ manifest: r.manifest, version: r.claim.version, channel: r.claim.channel, author: r.claim.author });

  /** Всё, что окну нужно знать о этом компьютере: установленное, проверенные версии, что реально запущено */
  const stateOf = async () => {
    const channels = selection.channels;
    const cached = await cache.cached();
    const available = [];
    for (const moduleId of new Set(cached.map(c => c.moduleId))) {
      for (const r of await cache.available(moduleId, channels)) available.push({ moduleId, ...describe(r) });
    }
    const runnable = host.runnable();
    const fallbacks = Object.fromEntries(Object.entries(selection.versions())
      .filter(([id, wanted]) => runnable.get(id)?.claim.version !== wanted).map(([id, wanted]) => [id, { wanted, running: runnable.get(id)?.claim.version || null }]));
    return { ok: true, userId: selection.active, channels, installed: selection.installed, cached, available, fallbacks,
      runnable: [...runnable.values()].map(describe) };
  };

  ipcMain.handle('modules:state', async event => {
    if (!trustedAuthSender(event)) return refuse;
    await host.ready;
    return stateOf();
  });

  /** Вошёл человек: дальше установленное — его (в файле выбора у каждого человека на компьютере своя запись) */
  ipcMain.handle('modules:activate', async (event, data: any) => {
    if (!trustedAuthSender(event)) return refuse;
    await host.ready;
    await selection.activate(String(data?.userId || ''));
    await host.refresh();
    return stateOf();
  });

  ipcMain.handle('modules:sync', async (event, data: any) => {
    if (!trustedAuthSender(event)) return refuse;
    await host.ready;
    const revocations = Array.isArray(data?.revocations) ? data.revocations.filter((s: unknown) => typeof s === 'string').slice(0, 10000) : [];
    const pins = Array.isArray(data?.pins) ? data.pins.filter((s: unknown) => typeof s === 'string').slice(0, 5000) : [];
    const releases = Array.isArray(data?.releases) ? data.releases.slice(0, SYNC_MAX_RELEASES) : [];
    if (Array.isArray(data?.channels) && selection.active) await selection.setChannels(data.channels);
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
    // «Вернуть предыдущую версию» работает без связи, пока версия лежит в кэше: чистка не должна съесть выбранную
    await cache.prune(Object.entries(selection.versions()).map(([id, v]) => `${id}@${v}`)).catch(() => {});
    await host.refresh();
    return { ...(await stateOf()), installedNow: installed, broken };
  });

  /** Поставить: версия уже скачана и проверена; разрешения сверяются с тем, что человек видел в окне */
  ipcMain.handle('modules:install', async (event, data: any) => {
    if (!trustedAuthSender(event)) return refuse;
    await host.ready;
    const moduleId = String(data?.moduleId || ''), version = String(data?.version || '');
    if (host.bundledIds.includes(moduleId)) return { ok: false, error: 'Встроенный пример заменить нельзя.' };
    if (!selection.active) return { ok: false, error: 'Сначала войдите в программу.' };
    const found = (await cache.available(moduleId, selection.channels)).find(r => r.claim.version === version);
    if (!found) return { ok: false, error: 'Эта версия не прошла проверку подписи на этом компьютере: поставить её нельзя.' };
    if (typeof data?.digest === 'string' && data.digest !== permissionsDigest(found.manifest)) {
      return { ok: false, error: 'Разрешения выпуска не совпали с показанными в Store: установка отменена.' };
    }
    await selection.install(moduleId, version, { dirty: true, noAuto: data?.noAuto === true });
    await host.refresh();
    return { ...(await stateOf()), at: selection.installed[moduleId]?.at };
  });

  ipcMain.handle('modules:remove', async (event, data: any) => {
    if (!trustedAuthSender(event)) return refuse;
    await host.ready;
    await selection.remove(String(data?.moduleId || ''));
    await host.refresh();
    return stateOf();
  });

  /** «Вернуть предыдущую версию»: ближайшая старше уже лежащая в кэше — связь не нужна */
  ipcMain.handle('modules:rollback', async (event, data: any) => {
    if (!trustedAuthSender(event)) return refuse;
    await host.ready;
    const moduleId = String(data?.moduleId || ''), current = selection.installed[moduleId];
    if (!current) return { ok: false, error: 'Подпрограмма не установлена.' };
    const target = String(data?.version || '');
    const channels = selection.channels;
    const found = target ? (await cache.available(moduleId, channels)).find(r => r.claim.version === target) : await cache.previous(moduleId, current.version, channels);
    if (!found) return { ok: false, error: 'Прошлой проверенной версии на этом компьютере нет.' };
    // Автообновление после возврата выключается: плохая версия не должна вернуться сама
    await selection.install(moduleId, found.claim.version, { dirty: true, noAuto: true });
    await host.refresh();
    return { ...(await stateOf()), at: selection.installed[moduleId]?.at, version: found.claim.version };
  });

  ipcMain.handle('modules:synced', async (event, data: any) => {
    if (!trustedAuthSender(event)) return refuse;
    await selection.markSynced(String(data?.moduleId || ''), Number(data?.at) || 0).catch(() => {});
    return { ok: true };
  });
}
