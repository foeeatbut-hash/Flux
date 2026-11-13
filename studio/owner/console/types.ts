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
/** Полное состояние хранилища для раздела «Лицензии» (действие licensesState): реестры и открытые ключи; закрытых ключей здесь нет */
export interface LicenseRow { id: string; inst: string; org: string; logins: string[]; exp: number; code: string }
export interface FluxUpdateRow { version: string; published: boolean; iat: number; name: string; size: number; signature: string; server: string }
export interface LicensesState {
  version: string; unlocked: boolean; vaultExists: boolean; vaultPath: string; backupSession: boolean; kind: string;
  setupKitPath: string; publicFilePath: string; previousVaultPath: string; setupVerified: boolean;
  publicKeys: Record<string, string>; backupOwnerPublic: string;
  licenses: LicenseRow[]; updates: FluxUpdateRow[]; revocations: Array<{ inst: string; ids: string[] }>;
  server: string; connected: boolean; exe: { name: string; size: number; sha256: string } | null;
}
export type LicenseSection = 'licenses' | 'publish' | 'keys';
/** Три пункта Studio — Владелец; «programs» делится на подразделы */
export type Tab = 'programs' | 'updates' | 'licenses';
export type Section = 'certificates' | 'requests' | 'releases' | 'testers';
export type { ModuleChannel };
