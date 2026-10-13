import { getAuthSessionKey, SERVER_BASE_URL } from '../config/env';
import { useStore } from '../store/store';

export interface FileMetadataResponse { fileId?: string; projectId?: string | null; name?: string; sha256?: string; [key: string]: unknown }
type Identity = { server: string; actor: string; project: string; session: string };

export function createFileMetadataCache<T>(now: () => number = Date.now, ttlMs = 30_000) {
  const cache = new Map<string, { at: number; promise: Promise<T> }>();
  const key = (fileId: string, actor: Identity) => [actor.server, actor.actor, actor.project, actor.session, fileId].join('\0');
  return {
    get(fileId: string, actor: Identity, load: () => Promise<T>): Promise<T> {
      const id = key(fileId, actor), current = cache.get(id);
      if (current && now() - current.at < ttlMs) return current.promise;
      const promise = load().catch((error) => { cache.delete(id); throw error; });
      cache.set(id, { at: now(), promise });
      if (cache.size > 512) cache.delete(cache.keys().next().value!);
      return promise;
    },
    invalidate(fileId?: string) {
      if (!fileId) { cache.clear(); return; }
      for (const id of cache.keys()) if (id.endsWith(`\0${fileId}`)) cache.delete(id);
    },
    get size() { return cache.size; },
  };
}

const cache = createFileMetadataCache<FileMetadataResponse>();
function identity(): Identity {
  const state = useStore.getState();
  return { server: SERVER_BASE_URL || (typeof location === 'undefined' ? '' : location.origin), actor: state.user?.id || '', project: state.activeProject?.id || '', session: getAuthSessionKey() };
}
export function fetchFileMetadata(fileId: string): Promise<FileMetadataResponse> {
  const id = String(fileId || '');
  if (!id) return Promise.reject(new Error('Файл не выбран.'));
  return cache.get(id, identity(), async () => {
    const response = await fetch(`/api/office/files/${encodeURIComponent(id)}/meta`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data?.error || `сервер ответил ${response.status}`));
    return data as FileMetadataResponse;
  });
}
export function invalidateFileMetadata(fileId?: string) { cache.invalidate(fileId); }
if (typeof window !== 'undefined') window.addEventListener('flux:session-changed', () => cache.invalidate());
