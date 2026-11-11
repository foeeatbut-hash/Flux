/** Что отвечает главный процесс (studio/owner/src/console.cjs) и сервер Flux разделам владельца */
import type { RequestMeta, ModuleChannel } from '../../../modules/trust/claims';
import type { FileDiff, PermissionDiff } from '../../../modules/trust/diff';

export interface PublishRequest {
  id: string; moduleId: string; version: string;
  state: 'pending' | 'returned' | 'rejected' | 'edited' | 'superseded' | 'released';
  byOwner: boolean; authorKey: string; authorId: string; parentId: string | null; baseRelease: string | null;
  size: number; createdAt: string; decidedBy: string; decidedAt: string | null;
  review: { note: string; comments: Array<{ path: string; line: number | null; text: string }> } | null;
  meta: RequestMeta | null;
}
export interface RequestDiff { against: { release?: string; request?: string } | null; files: FileDiff[]; permissions: PermissionDiff }
export interface ReleaseRow { id: string; moduleId: string; version: string; channel: ModuleChannel; state: string; signature: string; size: number; chunkCount: number; createdAt: string }
export interface CertificateRow { keyHex: string; userId: string; name: string; createdAt: string }
export interface CertificateAsk { key: string; userId: string; name: string; at: number }
export interface UpdateDevice {
  deviceId: string; userId: string; name: string; symbol: string; isActive: boolean;
  version: string; platform: string; arch: string; lastSeen: number; offline: boolean;
  status: string; code: string; commandId: string | null; action: string | null;
  deadline: number | null; targetVersion: string | null;
  commandRelease?: { version: string; generation: string; sha256: string; releaseSignature: string } | null;
}
export interface UpdateRelease { version: string; generation: string; signature: string; sha256: string }
export interface Snapshot {
  version: string; unlocked: boolean; vaultExists: boolean; backupSession: boolean; kind: string;
  connected: boolean; display: string; user: { id: string; name: string } | null;
}
export type Tab = 'requests' | 'releases' | 'certificates' | 'updates';
export type { ModuleChannel };
