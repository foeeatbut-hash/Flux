/**
 * Flux Store — действия человека и фоновая сверка.
 *
 * Порядок установки: скачать и проверить подпись (главный процесс) → сервер
 * подтверждает политику (допуск, закрепление, зависимости) → главный процесс
 * записывает выбор. Если что-то не сошлось, прежнее состояние не меняется.
 * Без связи работают запуск установленного, возврат к прошлой версии из кэша
 * и удаление; всё остальное ждёт связи.
 */
import { permissionsDigest, addedPermissions, unmetRequirements, updateAvailable, type StoreEnv, type StoreListing } from '../../modules/store/model';
import { compareVersions } from '../../shared/versionCompare';
import { useModuleStore } from '../store/moduleStoreState';
import { useStore } from '../store/store';
import { hasLocalHost, local, moduleStoreApi as api, type LocalState } from './moduleStoreService';

export const storeEnv = (): StoreEnv => ({
  fluxVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
  windows: typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent),
});

const state = () => useModuleStore.getState();
/** Отказ сервера по политике (4xx) отличается от обрыва связи: первый отменяет действие, второй нет */
const isNetwork = (e: any) => typeof e?.status !== 'number';

async function reloadLocal(): Promise<LocalState | null> {
  const next = await local<LocalState>('modules:state').catch(() => null);
  state().setLocal(next);
  return next;
}

/** Скачать выпуск и отдать главному процессу на проверку; готово, когда версия значится проверенной на этом компьютере */
async function ensureVerified(moduleId: string, version: string): Promise<LocalState> {
  const have = await local<LocalState>('modules:state');
  if (!have) throw new Error('Установка работает только в программе Flux на компьютере');
  if (have.available.some((a) => a.moduleId === moduleId && a.version === version)) return have;
  state().setBusy(moduleId, 'Скачивание…');
  const row = (await api.releases()).find((r) => r.moduleId === moduleId && r.version === version);
  if (!row) throw new Error(`Выпуск ${moduleId} ${version} не найден на сервере`);
  const chunks = await api.chunks(row.id);
  state().setBusy(moduleId, 'Проверка подписи владельца…');
  const result = await local<LocalState>('modules:sync', { releases: [{ id: row.id, moduleId, version, signature: row.signature, chunks }] });
  const broken = result?.broken?.find((b) => b.moduleId === moduleId && b.version === version);
  if (broken) throw new Error(`Выпуск не прошёл проверку: ${broken.why}`);
  if (!result?.available.some((a) => a.moduleId === moduleId && a.version === version)) throw new Error('Выпуск проверен, но запустить его на этом компьютере нельзя (канал или откат владельца)');
  return result;
}

interface Plan { listing: StoreListing; version: string; source: 'user' | 'required' | 'dependency' }

/** Что поставится вместе с подпрограммой: недостающие зависимости идут первыми */
export function installPlan(listing: StoreListing, all = state().listings, source: Plan['source'] = 'user'): Plan[] {
  const out: Plan[] = [], seen = new Set<string>();
  const visit = (l: StoreListing, src: Plan['source']) => {
    if (seen.has(l.moduleId)) return;
    seen.add(l.moduleId);
    for (const id of l.dependsOn) { const dep = all.find((x) => x.moduleId === id); if (dep && !dep.mine) visit(dep, 'dependency'); }
    out.push({ listing: l, version: l.version, source: src });
  };
  visit(listing, source);
  return out;
}

/** Почему ставить нельзя (по требованиям и допуску); пусто — можно */
export function blockers(listing: StoreListing, all = state().listings): string[] {
  const why = unmetRequirements(listing.manifest, storeEnv());
  if (!hasLocalHost()) why.push('Установка работает в программе Flux на компьютере, а не в браузере');
  for (const id of listing.dependsOn) { const dep = all.find((x) => x.moduleId === id); if (!dep) why.push(`Нужна подпрограмма ${id}, её нет в Store`); else if (!dep.mine) why.push(...unmetRequirements(dep.manifest, storeEnv()).map((r) => `${dep.name}: ${r}`)); }
  return why;
}

/** Поставить или обновить одну подпрограмму (зависимости — отдельными шагами плана) */
async function applyOne(plan: Plan, digest: boolean): Promise<void> {
  const { listing, version, source } = plan, id = listing.moduleId;
  state().setBusy(id, 'Подготовка…');
  try {
    await ensureVerified(id, version);
    state().setBusy(id, 'Установка…');
    const before = state().local?.installed[id]?.version;
    try { await api.putInstall(id, { version, source }); }
    catch (e: any) { if (!isNetwork(e)) throw e; }
    try { await local('modules:install', { moduleId: id, version, digest: digest ? permissionsDigest(listing.manifest) : undefined }); }
    catch (e) {
      // Главный процесс не согласился: запись на сервере возвращается, иначе у человека «установлено», а запускать нечего
      await (before ? api.putInstall(id, { version: before }) : api.removeInstall(id, true)).catch(() => {});
      throw e;
    }
    const synced = await local<LocalState>('modules:state');
    const at = synced?.installed[id]?.at;
    if (at) await local('modules:synced', { moduleId: id, at }).catch(() => {});
  } finally { state().setBusy(id, null); }
}

export async function installModule(listing: StoreListing): Promise<void> {
  const why = blockers(listing);
  if (why.length) throw new Error(why[0]);
  for (const plan of installPlan(listing)) await applyOne(plan, true);
  await refreshStore();
}

/** Обновить: если разрешений стало больше, окно уже спросило (см. UpdateConsent) */
export async function updateModule(listing: StoreListing): Promise<void> {
  const why = unmetRequirements(listing.manifest, storeEnv());
  if (why.length) throw new Error(why[0]);
  await applyOne({ listing, version: listing.version, source: listing.mine?.source || 'user' }, true);
  await refreshStore();
}

export async function updateAll(): Promise<{ done: number; failed: string[] }> {
  let done = 0; const failed: string[] = [];
  for (const l of state().listings.filter(updateAvailable)) {
    try { await updateModule(l); done++; } catch (e: any) { failed.push(`${l.name}: ${e?.message || 'не обновлена'}`); }
  }
  return { done, failed };
}

/** Новые разрешения версии против установленной: пусто — подтверждать нечего */
export function newPermissions(listing: StoreListing): string[] {
  const current = state().local?.available.find((a) => a.moduleId === listing.moduleId && a.version === listing.mine?.version);
  return addedPermissions(current?.manifest || null, listing.manifest);
}

export async function removeModule(listing: StoreListing, keepData: boolean): Promise<void> {
  state().setBusy(listing.moduleId, 'Удаление…');
  try {
    await api.removeInstall(listing.moduleId, keepData);
    await local('modules:remove', { moduleId: listing.moduleId });
  } finally { state().setBusy(listing.moduleId, null); }
  await refreshStore();
}

/**
 * Вернуть прошлую версию: берётся то, что уже лежит в кэше, поэтому связь не
 * нужна; на сервер уходит при первой возможности. Автообновление этой
 * подпрограммы выключается, чтобы плохая версия не вернулась сама.
 */
export async function rollbackModule(moduleId: string, version?: string): Promise<string> {
  // Более старая версия, которой нет на диске, скачивается и проверяется; лежащая в кэше — без связи
  if (version) await ensureVerified(moduleId, version);
  const result = await local<LocalState>('modules:rollback', { moduleId, version });
  const target = result?.version || '';
  await reloadLocal();
  try {
    await api.putInstall(moduleId, { version: target, auto: 'off' });
    if (result?.at) await local('modules:synced', { moduleId, at: result.at }).catch(() => {});
  } catch (e: any) { if (!isNetwork(e)) throw e; /* уйдёт при следующей сверке: запись помечена «не дошло» */ }
  await refreshStore();
  return target;
}

export const setModuleAuto = (moduleId: string, version: string, auto: '' | 'on' | 'off') =>
  api.putInstall(moduleId, { version, auto }).then(() => refreshStore());

export async function setAutoUpdate(enabled: boolean): Promise<void> {
  await api.setAutoAll(enabled);
  state().set({ autoUpdate: enabled });
}

// ── Фоновая сверка ─────────────────────────────────────────────────────────

let running: Promise<void> | null = null;
let startupDone = false;

/** Эффективное автообновление подпрограммы: общий переключатель, если свой не задан */
export const autoOn = (l: StoreListing, global: boolean) => !!l.mine && (l.mine.auto === 'on' || (global && l.mine.auto !== 'off'));

async function reconcile(): Promise<void> {
  const user = useStore.getState().user as any;
  if (!user?.id) return;
  const host = hasLocalHost();
  if (host) await local('modules:activate', { userId: String(user.id) }).catch(() => {});
  await reloadLocal();
  try {
    const [store, me] = await Promise.all([api.store(), api.me()]);
    state().set({ listings: store.listings, autoUpdate: store.autoUpdate, loaded: true, offline: false, error: '' });
    if (!host) return;
    const [revocations, pins, promotions] = await Promise.all([api.revocations(), api.pins(), api.promotions()]);
    await local('modules:sync', { revocations, pins, promotions, channels: me.channels, releases: [] });
    let now = await reloadLocal();

    // Изменения, сделанные без связи (например, возврат версии), уходят на сервер
    for (const [id, entry] of Object.entries(now?.installed || {})) {
      if (!entry.dirty) continue;
      try { await api.putInstall(id, { version: entry.version, ...(entry.noAuto ? { auto: 'off' as const } : {}) }); await local('modules:synced', { moduleId: id, at: entry.at }); }
      catch (e: any) { if (!isNetwork(e)) await local('modules:synced', { moduleId: id, at: entry.at }).catch(() => {}); }
    }
    // Удалено или запрещено на сервере (другой компьютер, администратор): здесь тоже убираем
    now = await reloadLocal();
    for (const [id, entry] of Object.entries(now?.installed || {})) {
      if (!entry.dirty && !store.listings.some((l) => l.moduleId === id && l.mine)) await local('modules:remove', { moduleId: id }).catch(() => {});
    }
    // Обязательные для должности ставятся сами в версии администратора; расширение разрешений тут не спрашиваем: их выбрал администратор
    for (const l of store.listings) {
      if (!l.required || l.status === 'banned' || (l.mine && compareVersions(l.mine.version, l.required) >= 0)) continue;
      const target = l.versions.find((v) => v.version === l.required && !v.revoked);
      if (!target || unmetRequirements(l.manifest, storeEnv()).length) continue;
      try { for (const p of installPlan(l, store.listings, 'required')) await applyOne({ ...p, version: p.listing.moduleId === l.moduleId ? l.required : p.version }, false); }
      catch (e: any) { state().set({ error: `Обязательная подпрограмма «${l.name}» не поставлена: ${e?.message || ''}` }); }
    }
    // Автообновление: только при запуске Flux, не посреди работы, и только если разрешений не прибавилось
    if (!startupDone) {
      startupDone = true;
      for (const l of store.listings.filter((x) => updateAvailable(x) && autoOn(x, store.autoUpdate))) {
        if (newPermissions(l).length || unmetRequirements(l.manifest, storeEnv()).length) continue;
        await updateModule(l).catch(() => {});
      }
    }
  } catch (e: any) {
    state().set({ offline: true, error: e?.message || '', loaded: true });
  }
  await reloadLocal();
  if (host) {
    const fresh = await api.store().catch(() => null);
    if (fresh) state().set({ listings: fresh.listings, autoUpdate: fresh.autoUpdate });
  }
}

/** Одна сверка за раз: события сокета и окна приходят пачкой */
export function refreshStore(): Promise<void> {
  if (!running) running = reconcile().finally(() => { running = null; });
  return running;
}
