/**
 * Flux Store — обращения окна к серверу и к главному процессу.
 *
 * Сервер хранит политику (допуск, установки человека, отзывы, журнал); что
 * проверено и что запускается, знает только главный процесс (`modules:*`).
 * Окно связывает одно с другим и ничего не решает за них.
 */
import type { ModuleManifest } from '../../modules/contract';
import type { StoreListing } from '../../modules/store/model';
import type { DevRunItem } from '../../modules/store/devRun';
import type { ModuleChannel } from '../../modules/trust/claims';
import { bridge, call } from './moduleReleaseService';

export interface LocalAvailable { moduleId: string; version: string; channel: ModuleChannel; author: string; manifest: ModuleManifest }
export interface LocalInstalled { version: string; at: number; dirty?: boolean; noAuto?: boolean }
export interface LocalState {
  ok: boolean; error?: string; userId: string; channels: ModuleChannel[];
  installed: Record<string, LocalInstalled>;
  revoked?: { releases: string[]; keys: string[] };
  channelCaps?: Record<string, string>;
  available: LocalAvailable[];
  /** Выбранная версия больше не проходит проверку (отозвана, откат владельца): запущена более старая */
  fallbacks: Record<string, { wanted: string; running: string | null }>;
  runnable: Array<{ manifest: ModuleManifest; version: string; channel: ModuleChannel; author: string }>;
  /** Программы из разработки (Studio → Flux): проверенные и отказанные с причиной */
  dev?: DevRunItem[];
  broken?: Array<{ moduleId: string; version: string; why: string }>;
  at?: number; version?: string;
}
export interface StoreReview { id: string; userName: string; rating: number; text: string; version: string; hidden: boolean; reports?: number; mine: boolean; updatedAt: string }
export interface StoreLogRow { id: string; userId: string; userName: string; moduleId: string; action: string; fromVersion: string; toVersion: string; detail: string; createdAt: string }
export interface AdminData { listings: StoreListing[]; entries: any[]; spread: Record<string, Record<string, number>>; logs: StoreLogRow[] }
export interface ReleaseRow { id: string; moduleId: string; version: string; signature: string; channel: ModuleChannel }

export const hasLocalHost = () => !!bridge();

/** Главный процесс; без него (веб-окно) устанавливать нечего, а смотреть витрину можно */
export async function local<T = LocalState>(channel: string, payload?: unknown): Promise<T | null> {
  const ipc = bridge();
  if (!ipc) return null;
  const result = await ipc.invoke(channel, payload);
  if (result && result.ok === false) throw new Error(result.error || 'Главный процесс отказал');
  return result as T;
}

export const moduleStoreApi = {
  store: () => call<{ listings: StoreListing[]; autoUpdate: boolean }>('GET', '/store'),
  putInstall: (moduleId: string, body: { version: string; source?: string; auto?: '' | 'on' | 'off' }) =>
    call<{ ok: boolean; action: string }>('PUT', `/installs/${encodeURIComponent(moduleId)}`, body),
  removeInstall: (moduleId: string, keepData: boolean) => call('DELETE', `/installs/${encodeURIComponent(moduleId)}`, { keepData }),
  setAutoAll: (enabled: boolean) => call<{ autoUpdate: boolean }>('PUT', '/installs/auto', { enabled }),
  reviews: (moduleId: string) => call<{ reviews: StoreReview[] }>('GET', `/store/${encodeURIComponent(moduleId)}/reviews`).then((r) => r.reviews),
  review: (moduleId: string, rating: number, text: string) => call('PUT', `/store/${encodeURIComponent(moduleId)}/review`, { rating, text }),
  reportReview: (id: string) => call('POST', `/store/reviews/${encodeURIComponent(id)}/report`, {}),
  hideReview: (id: string, hidden: boolean) => call('POST', `/store/reviews/${encodeURIComponent(id)}/hide`, { hidden }),
  admin: () => call<AdminData>('GET', '/store-admin'),
  roles: () => call<{ roles: Array<{ code: string; name: string }> }>('GET', '/store-roles').then((r) => r.roles),
  admission: (moduleId: string, body: { status: string; deprecated?: boolean; note?: string }) => call('POST', `/store/${encodeURIComponent(moduleId)}/admission`, body),
  pin: (moduleId: string, version: string | null, roles: string[]) => call('POST', `/store/${encodeURIComponent(moduleId)}/pin`, { version, roles }),
  required: (moduleId: string, version: string, roles: string[]) => call('POST', `/store/${encodeURIComponent(moduleId)}/required`, { version, roles }),
  releases: () => call<{ releases: ReleaseRow[] }>('GET', '/releases').then((r) => r.releases),
  chunks: (releaseId: string) => call<{ chunks: string[] }>('GET', `/releases/${encodeURIComponent(releaseId)}/chunks`).then((r) => r.chunks),
  revocations: () => call<{ revocations: string[] }>('GET', '/revocations').then((r) => r.revocations),
  promotions: () => call<{ promotions: string[] }>('GET', '/promotions').then((r) => r.promotions),
  pins: () => call<{ pins: string[] }>('GET', '/pins').then((r) => r.pins),
  me: () => call<{ channels: ModuleChannel[]; owner: boolean; develop: boolean; publish: boolean }>('GET', '/me'),
};
