import { ENV_CONFIG } from '../config/env';
import { base64ToBytes, bytesToBase64, windowsFilesRequest, type WindowsFileRef, type WindowsFileContent, type WindowsRoot } from '../lib/windowsFiles';
import { openHref } from '../lib/fileTypes';

export interface ShareState { fileId: string; ownerId: string; audience: 'NONE' | 'USERS' | 'ALL'; permission: 'VIEW' | 'EDIT'; recipients: string[]; epoch: number; state: 'PENDING' | 'READY' }
export interface SharedFile { id: string; name: string; size: number; updatedAt: string; ownerId: string; ownerName: string; permission: 'OWNER' | 'VIEW' | 'EDIT'; epoch: number }
export interface SourceBinding { sourceKey: string; fileId: string; ref: WindowsFileRef; name: string; baseSha: string; status?: string; audience?: ShareState['audience'] }
const storageKey = (actorId: string) => `flux.shared-sources:${ENV_CONFIG.apiUrl}:${actorId}`;
const deviceKey = 'flux.shared-device';
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || 'Не удалось изменить общий доступ');
  return data;
};
async function localRead(ref: WindowsFileRef): Promise<WindowsFileContent> {
  const result = await windowsFilesRequest<WindowsFileContent>({ action: 'read', ref });
  if ('error' in result) throw Error(result.error.message);
  return result.data;
}
async function isNetworkSource(ref: WindowsFileRef): Promise<boolean> {
  const roots = await windowsFilesRequest<WindowsRoot[]>({ action: 'roots' });
  if ('error' in roots) throw Error(roots.error.message);
  const root = roots.data.find(root => root.id === ref.rootId);
  if (!root) throw Error('Исходная папка больше не подключена');
  return root.network === true;
}
export function sourceBindings(actorId: string): SourceBinding[] {
  try { const values = JSON.parse(localStorage.getItem(storageKey(actorId)) || '[]'); return Array.isArray(values) ? values.filter((b) => b?.fileId && b?.ref?.rootId && b?.sourceKey && b?.baseSha) : []; }
  catch { return []; }
}
function remember(actorId: string, binding: SourceBinding): void {
  const items = sourceBindings(actorId); const index = items.findIndex((b) => b.sourceKey === binding.sourceKey);
  if (index >= 0) items[index] = binding; else items.push(binding);
  localStorage.setItem(storageKey(actorId), JSON.stringify(items));
}
export async function localSourceKey(actorId: string, ref: WindowsFileRef): Promise<string> {
  let device = localStorage.getItem(deviceKey);
  if (!device) { device = crypto.randomUUID(); localStorage.setItem(deviceKey, device); }
  const bytes = new TextEncoder().encode(JSON.stringify([actorId, device, ref.rootId, ref.relativePath, ref.draftId || '']));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const getSourceShare = (sourceKey: string) => api<ShareState | null>(`/file-sharing/source/${encodeURIComponent(sourceKey)}`);
export const getFileShare = (fileId: string) => api<ShareState>(`/file-sharing/${encodeURIComponent(fileId)}`);
export const receivedFiles = () => api<{ files: SharedFile[] }>('/file-sharing/received');
export const hideSharedFile = (fileId: string) => api(`/file-sharing/${encodeURIComponent(fileId)}/hide`, { method: 'POST', body: '{}' });
export async function setFileSharing(state: ShareState, settings: Pick<ShareState, 'audience' | 'permission' | 'recipients'>): Promise<ShareState> {
  const next = await api<ShareState>(`/file-sharing/${encodeURIComponent(state.fileId)}/access`, { method: 'PUT', body: JSON.stringify({ ...settings, epoch: state.epoch }) });
  const binding = sourceBindings(next.ownerId).find(binding => binding.fileId === next.fileId);
  if (binding) remember(next.ownerId, { ...binding, audience: next.audience });
  return next;
}

/** Владелец открывает тот же объект, что коллеги; исходник продолжает лежать на его диске. */
export async function sharedSourceHref(actorId: string, ref: WindowsFileRef, name: string): Promise<string | null> {
  if (!/\.(docx|xlsx|xlsm|pdf|md|markdown)$/i.test(name)) return null;
  const binding = sourceBindings(actorId).find(item => item.ref.rootId === ref.rootId && item.ref.relativePath === ref.relativePath && item.ref.draftId === ref.draftId);
  if (!binding) return null;
  if (await isNetworkSource(ref)) return null;
  const share = await getFileShare(binding.fileId);
  return share.state === 'READY' && share.audience !== 'NONE' ? openHref({ id: binding.fileId, name }) : null;
}

/** Первое предоставление сначала грузит неизменный снимок, права публикуются следующим запросом. */
export async function stageLocalShare(actorId: string, ref: WindowsFileRef, progress: (value: string) => void): Promise<ShareState> {
  if (await isNetworkSource(ref)) throw Error('Сетевая папка уже общая. Доступ к её файлам определяется правами Windows.');
  progress('Чтение исходника…');
  const sourceKey = await localSourceKey(actorId, ref); const snapshot = await localRead(ref);
  const previous = await getSourceShare(sourceKey);
  const result = await api<ShareState & { chunkBytes: number }>('/file-sharing/publications', { method: 'POST', body: JSON.stringify({ sourceKey, name: snapshot.name, size: snapshot.size, sha256: snapshot.sha256, epoch: previous?.epoch }) });
  if (result.state === 'PENDING') {
    const bytes = base64ToBytes(snapshot.base64);
    for (let offset = 0, idx = 0; offset < bytes.length; offset += result.chunkBytes, idx++) {
      progress(`Загрузка · ${Math.round(offset / bytes.length * 100)} %`);
      await api(`/file-sharing/${encodeURIComponent(result.fileId)}/chunks/${idx}`, { method: 'PUT', body: JSON.stringify({ base64: bytesToBase64(bytes.subarray(offset, offset + result.chunkBytes)), epoch: result.epoch }) });
    }
    remember(actorId, { sourceKey, fileId: result.fileId, ref, name: snapshot.name, baseSha: snapshot.sha256 });
  } else if (!sourceBindings(actorId).some((b) => b.sourceKey === sourceKey)) {
    // Потерянную локальную привязку нельзя считать синхронной по текущему
    // снимку: сервер мог уже принять чужие правки. Хеш сравнивается явно.
    const meta = await api<{ sha256: string }>(`/office/files/${encodeURIComponent(result.fileId)}/meta`);
    remember(actorId, { sourceKey, fileId: result.fileId, ref, name: snapshot.name, baseSha: meta.sha256, ...(meta.sha256 !== snapshot.sha256 ? { status: 'Конфликт: локальный исходник отличается от общей версии' } : {}) });
  }
  progress('Проверка содержимого…');
  return result;
}

/** Обе версии сохраняются при конфликте: запись Windows разрешена лишь по прежнему хешу. */
async function syncSourceOnce(actorId: string, binding: SourceBinding, isCurrent: () => boolean): Promise<string> {
  try {
    if (!isCurrent()) return 'Синхронизация остановлена';
    if (await isNetworkSource(binding.ref)) return 'Сетевая папка: исходник используется напрямую с правами Windows';
    const share = await getFileShare(binding.fileId);
    if (share.ownerId !== actorId || share.state !== 'READY') return 'Загрузка общего файла ещё не завершена';
    binding = { ...binding, audience: share.audience };
    const meta = await api<{ sha256: string; pendingSharedEdits?: boolean }>(`/office/files/${encodeURIComponent(binding.fileId)}/meta`);
    const local = await localRead(binding.ref);
    if (!isCurrent()) return 'Синхронизация остановлена';
    if (local.sha256 === meta.sha256) { remember(actorId, { ...binding, baseSha: meta.sha256, status: '' }); return 'Синхронизировано'; }
    if (binding.status?.startsWith('Конфликт') || local.sha256 !== binding.baseSha && (meta.sha256 !== binding.baseSha || meta.pendingSharedEdits)) {
      const message = 'Конфликт: исходник и общая версия изменились. Обе версии сохранены; исходник не перезаписан.';
      remember(actorId, { ...binding, status: message }); return message;
    }
    if (local.sha256 === binding.baseSha) {
      const response = await fetch(`${ENV_CONFIG.apiUrl}/files/${encodeURIComponent(binding.fileId)}/raw`);
      if (!response.ok) throw Error('Не удалось получить общую версию');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (digest !== meta.sha256) return 'Общая версия изменилась во время загрузки. Повторите синхронизацию.';
      if (!isCurrent()) return 'Синхронизация остановлена';
      const result = await windowsFilesRequest({ action: 'write', ref: binding.ref, baseSha256: local.sha256, base64: bytesToBase64(bytes) });
      if ('error' in result) throw Error(result.error.message);
      remember(actorId, { ...binding, baseSha: digest, status: '' }); return 'Синхронизировано';
    }
    if (!isCurrent()) return 'Синхронизация остановлена';
    const response = await fetch(`${ENV_CONFIG.apiUrl}/office/files/${encodeURIComponent(binding.fileId)}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Base-Sha256': binding.baseSha }, body: base64ToBytes(local.base64) as BodyInit });
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Общая версия не сохранена');
    remember(actorId, { ...binding, baseSha: result.sha256, status: '' }); return 'Синхронизировано';
  } catch (err: any) {
    const message = `Синхронизация приостановлена: ${err?.message || 'исходник недоступен'}. Общая версия сохранена на сервере.`;
    if (isCurrent()) remember(actorId, { ...binding, status: message }); return message;
  }
}
const synchronizing = new Map<string, Promise<string>>();
export function syncSource(actorId: string, binding: SourceBinding, isCurrent: () => boolean = () => true): Promise<string> {
  const key = `${storageKey(actorId)}:${binding.sourceKey}`;
  const current = synchronizing.get(key);
  if (current) return current;
  const pending = syncSourceOnce(actorId, binding, isCurrent).finally(() => { if (synchronizing.get(key) === pending) synchronizing.delete(key); });
  synchronizing.set(key, pending);
  return pending;
}
export async function syncOwnedSources(actorId: string, isCurrent: () => boolean = () => true): Promise<string[]> {
  const statuses: string[] = [];
  for (const binding of sourceBindings(actorId)) {
    if (!isCurrent()) break;
    statuses.push(await syncSource(actorId, binding, isCurrent));
  }
  return statuses;
}
