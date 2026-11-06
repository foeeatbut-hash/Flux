/**
 * Запросы на публикацию и выпуски модулей — со стороны окна.
 *
 * Окно ничего не подписывает и не решает, что запускать: подпись владельца
 * ставит главный процесс (`modules:sign`), проверку и кэш выпусков ведёт тоже
 * он (`modules:sync`). Окно приносит с сервера данные и показывает результат.
 * Пакет для показа берётся теми же байтами, что потом уходят на подпись.
 */
import type { RequestMeta, ModuleChannel } from '../../modules/trust/claims';
import type { FileDiff, PermissionDiff } from '../../modules/trust/diff';
import type { ModuleManifest } from '../../modules/contract';

export interface PublishRequest {
  id: string; moduleId: string; version: string;
  state: 'pending' | 'returned' | 'rejected' | 'edited' | 'superseded' | 'released';
  byOwner: boolean; authorKey: string; authorId: string; parentId: string | null; baseRelease: string | null;
  size: number; createdAt: string; decidedBy: string; decidedAt: string | null;
  review: { note: string; comments: Array<{ path: string; line: number | null; text: string }> } | null;
  meta: RequestMeta | null;
}
export interface ModuleReleaseRow { id: string; moduleId: string; version: string; channel: ModuleChannel; state: string; signature: string; size: number; chunkCount: number; createdAt: string }
export interface ModuleMe { owner: boolean; channels: ModuleChannel[]; develop: boolean; publish: boolean }
export interface RequestDiff { against: { release?: string; request?: string } | null; files: FileDiff[]; permissions: PermissionDiff }
export interface LocalModules {
  runnable: Array<{ manifest: ModuleManifest; version: string; channel: ModuleChannel; author: string }>;
  broken?: Array<{ moduleId: string; version: string; why: string }>;
  installed?: string[];
}

export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/modules${url}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Запрос не выполнен (${res.status})`);
  return data as T;
}

export const bridge = () => (window as any).electron?.ipcRenderer as { invoke: (channel: string, ...args: unknown[]) => Promise<any> } | undefined;
const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** Что подписать — главный процесс сам соберёт описание из байт пакета */
export type SignRequest =
  | { kind: 'release'; requestId: string; requestSignature: string; bundle: Uint8Array; channel: ModuleChannel; notBefore: number }
  | { kind: 'owner-edit'; parentRequestId: string; parentSignature: string; bundle: Uint8Array; comment: string }
  | { kind: 'revocation'; target: 'release' | 'key'; value: string; reason: string }
  | { kind: 'certificate'; key: string; userId: string; name: string }
  | { kind: 'pin'; moduleId: string; channel: ModuleChannel; version: string | null; reason: string };

export async function signAsOwner(request: SignRequest, password: string): Promise<string | null> {
  const ipc = bridge();
  if (!ipc) throw new Error('Подпись владельца ставится только в программе Flux на компьютере владельца');
  const payload = 'bundle' in request ? { ...request, bundle: toBase64(request.bundle) } : request;
  const result = await ipc.invoke('modules:sign', { ...payload, password });
  if (result?.canceled) return null;
  if (!result?.ok) throw new Error(result?.error || 'Не удалось подписать');
  return result.signature as string;
}

export const moduleReleaseService = {
  requests: () => call<{ requests: PublishRequest[] }>('GET', '/requests').then((r) => r.requests),
  request: (id: string) => call<{ request: PublishRequest; signature: string }>('GET', `/requests/${encodeURIComponent(id)}`),
  diff: (id: string) => call<RequestDiff>('GET', `/requests/${encodeURIComponent(id)}/diff`),
  async bundle(id: string): Promise<Uint8Array> {
    const res = await fetch(`/api/modules/requests/${encodeURIComponent(id)}/bundle`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Пакет не получен');
    return new Uint8Array(await res.arrayBuffer());
  },
  returnForRework: (id: string, note: string, comments: Array<{ path: string; line: number | null; text: string }>) =>
    call('POST', `/requests/${encodeURIComponent(id)}/return`, { note, comments }),
  reject: (id: string, reason: string) => call('POST', `/requests/${encodeURIComponent(id)}/reject`, { reason }),
  release: (id: string, signature: string) => call<{ release: ModuleReleaseRow; duplicate?: boolean }>('POST', `/requests/${encodeURIComponent(id)}/release`, { signature }),
  submit: (signature: string, bundle: Uint8Array) => call<{ id: string; duplicate?: boolean }>('POST', '/requests', { signature, bundle: toBase64(bundle) }),
  releases: () => call<{ releases: ModuleReleaseRow[] }>('GET', '/releases').then((r) => r.releases),
  me: () => call<ModuleMe>('GET', '/me'),
  testers: () => call<{ testers: string[]; users: Array<{ id: string; name: string; role: string }> }>('GET', '/testers'),
  saveTesters: (testers: string[]) => call<{ testers: string[] }>('PUT', '/testers', { testers }),
  pin: (signature: string) => call('POST', '/pins', { signature }),
  revoke: (signature: string) => call('POST', '/revocations', { signature }),
  certificates: () => call<{ certificates: Array<{ keyHex: string; userId: string; name: string; createdAt: string }> }>('GET', '/certificates').then((r) => r.certificates),
  certify: (signature: string) => call('POST', '/certificates', { signature }),

  /** Что этот Flux может запускать: проверенные выпуски из кэша главного процесса */
  async local(): Promise<LocalModules | null> {
    const ipc = bridge();
    if (!ipc) return null;
    const state = await ipc.invoke('modules:state');
    return state?.ok ? { runnable: state.runnable } : null;
  },

  /**
   * Скачать новые выпуски и отзывы и отдать главному процессу на проверку.
   * Куски качаются только для выпусков, которых ещё нет в кэше.
   */
  async sync(): Promise<LocalModules | null> {
    const ipc = bridge();
    if (!ipc) return null;
    const state = await ipc.invoke('modules:state');
    const cached = new Set<string>((state?.cached || []).map((c: any) => `${c.moduleId}@${c.version}`));
    const [{ revocations }, { pins }, me, releases] = await Promise.all([call<{ revocations: string[] }>('GET', '/revocations'),
      call<{ pins: string[] }>('GET', '/pins'), moduleReleaseService.me(), moduleReleaseService.releases()]);
    const fresh = [];
    for (const r of releases.filter((x) => !cached.has(`${x.moduleId}@${x.version}`))) {
      const { chunks } = await call<{ chunks: string[] }>('GET', `/releases/${encodeURIComponent(r.id)}/chunks`);
      fresh.push({ id: r.id, moduleId: r.moduleId, version: r.version, signature: r.signature, chunks });
    }
    const result = await ipc.invoke('modules:sync', { revocations, pins, channels: me.channels, releases: fresh });
    if (!result?.ok) throw new Error(result?.error || 'Выпуски не проверены');
    return result;
  },
};
