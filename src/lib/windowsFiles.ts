import type { WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse } from '../../filesystem/contracts';

export type { WindowsFileRef, WindowsFileEntry, WindowsFileContent, WindowsFileMetadata, WindowsRoot, WindowsVolume, WindowsKnownFolder, WindowsFilesRequest, WindowsFilesResponse, WindowsFilesChanged, WindowsEquipmentSourcePick, WindowsEquipmentSourceFolderPick, ImportedFileBytes } from '../../filesystem/contracts';
// Команды Проводника Windows 11 (этап A моста): поиск, дерево, миниатюры, меню Windows, корзина, отмена, план публикации.
export type {
  WindowsFileChoice, WindowsPublishChoices, WindowsPublishPlan, WindowsPublishPlanItem,
  WindowsSearchFilters, WindowsSearchLimits, WindowsSearchHit, WindowsSearchEvent, WindowsSearchStop, WindowsFolderNode,
  WindowsQuickAccessItem, WindowsQuickAccessList, WindowsCloudRoot, WindowsCloudRoots, WindowsThumbnail, WindowsOpenWithHandler,
  WindowsShellMenu, WindowsShellMenuItem, WindowsRecycleBin, WindowsRecycleItem, WindowsImportResult, WindowsImportCollision,
  WindowsUndoState, WindowsUndoLabel, WindowsUndoResult, WindowsExplorerRequest, WindowsLocationKeys,
} from '../../filesystem/contracts';

type WindowsFilesBridge = {
  getIcon?: (ref: WindowsFileRef) => Promise<string | null>;
  /** Отмена передаётся данными (cancelId): AbortSignal через contextBridge не проходит. */
  invoke: (request: WindowsFilesRequest, options?: { cancelId?: string }) => Promise<WindowsFilesResponse>;
  cancel?: (cancelId: string) => void;
  onChanged: (callback: (change: import('../../filesystem/contracts').WindowsFilesChanged) => void) => () => void;
  /** Старые сборки моста этих двух методов не имеют: вызов обязан пережить их отсутствие. */
  onSearch?: (callback: (event: import('../../filesystem/contracts').WindowsSearchEvent) => void) => () => void;
  takeDrop?: () => { ticket: string; names: string[] } | null;
};

function bridge(): WindowsFilesBridge | null {
  return typeof window !== 'undefined' ? (window as Window & { electron?: { windowsFiles?: WindowsFilesBridge } }).electron?.windowsFiles || null : null;
}

/** Идентификатор отмены: crypto.randomUUID есть только в защищённом контексте, поэтому запасной путь через getRandomValues. */
function newCancelId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Браузерный запуск не выдаёт фиктивный список: действия требуют нативного Проводника. */
export async function windowsFilesRequest<T = unknown>(request: WindowsFilesRequest, options: { signal?: AbortSignal } = {}): Promise<WindowsFilesResponse<T>> {
  const api = bridge();
  if (!api) return { ok: false, error: { code: 'PORTABLE', message: 'Папки компьютера доступны в установленной версии Flux. В браузере открыт архив документов проекта.' } };
  const signal = options.signal;
  // Через мост едет только cloneable-данные: сам сигнал остаётся в странице и превращается в cancel(id).
  const cancelId = signal && api.cancel ? newCancelId() : undefined;
  const abort = () => { if (cancelId) { try { api.cancel?.(cancelId); } catch { /* отмена не должна ломать вызов */ } } };
  try {
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    return await (cancelId ? api.invoke(request, { cancelId }) : api.invoke(request)) as WindowsFilesResponse<T>;
  }
  catch { return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'Связь с Проводником прервалась. Обновите окно и повторите действие.' } }; }
  finally { signal?.removeEventListener('abort', abort); }
}

export function onWindowsFilesChanged(callback: (change: import('../../filesystem/contracts').WindowsFilesChanged) => void): () => void {
  return bridge()?.onChanged(callback) || (() => undefined);
}

/** Страницы поиска приходят событиями, отдельно от ответа на команду search; без моста — пустая подписка. */
export function onWindowsFilesSearch(callback: (event: import('../../filesystem/contracts').WindowsSearchEvent) => void): () => void {
  return bridge()?.onSearch?.(callback) || (() => undefined);
}

/**
 * Билет последнего настоящего перетаскивания файлов из Проводника Windows.
 * Пути страница не получает: команда importPaths принимает только билет.
 */
export function takeWindowsDrop(): { ticket: string; names: string[] } | null {
  try { return bridge()?.takeDrop?.() ?? null; } catch { return null; }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function fileRefHref(ref: WindowsFileRef, options: { properties?: boolean; folder?: boolean } = {}): string {
  const query = new URLSearchParams({ root: ref.rootId, path: options.properties ? ref.relativePath.split('/').slice(0, -1).join('/') : ref.relativePath });
  if (ref.draftId) query.set(options.properties ? 'targetDraft' : 'draft', ref.draftId);
  if (options.properties) { query.set('properties', '1'); query.set('target', ref.relativePath); }
  return `${options.folder || options.properties ? '/explorer' : '/windows-file'}?${query.toString()}`;
}

export const folderRefHref = (ref: WindowsFileRef) => fileRefHref(ref, { folder: true });
export const windowsPropertiesHref = (ref: WindowsFileRef) => fileRefHref(ref, { properties: true });

export function fileRefFromSearch(search: string): WindowsFileRef | null {
  const query = new URLSearchParams(search);
  const rootId = query.get('root');
  const relativePath = query.get('path');
  if (rootId === null || relativePath === null) return null;
  const draftId = query.get('draft') || undefined;
  return { rootId, relativePath, ...(draftId ? { draftId } : {}) };
}

export const encodeWindowsFileRef = fileRefHref;
export function decodeWindowsFileRef(value: string): WindowsFileRef | null {
  try { return fileRefFromSearch(new URL(value, 'http://flux.invalid').search); } catch { return null; }
}
