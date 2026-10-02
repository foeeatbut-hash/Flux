/** Личный оригинал остаётся локальным; общая версия и права живут в базе компании. */
import { createHash, randomUUID } from 'node:crypto';
import { ensureTables, getDialect, type TableSpec } from './ddl.js';
import { oncePerDatabase } from './schemaRuntime.js';

export type ShareAudience = 'NONE' | 'USERS' | 'ALL';
export type SharePermission = 'VIEW' | 'EDIT';
export interface FileShare {
  fileId: string; ownerId: string; sourceKey: string; audience: ShareAudience; permission: SharePermission;
  recipients: string; epoch: number; state: 'PENDING' | 'READY'; expectedSha: string; expectedSize: number; changedAt: number;
}
export const SHARING_TABLES: TableSpec[] = [
  { table: 'FileShare', cols: [
    { name: 'fileId', kind: 'text', pk: true }, { name: 'ownerId', kind: 'text', notNull: true, indexed: true },
    { name: 'sourceKey', kind: 'text', notNull: true, indexed: true },
    { name: 'audience', kind: 'text', notNull: true, def: 'NONE' }, { name: 'permission', kind: 'text', notNull: true, def: 'EDIT' },
    { name: 'recipients', kind: 'longtext', notNull: true }, { name: 'epoch', kind: 'int', notNull: true, def: 0 },
    { name: 'state', kind: 'text', notNull: true, def: 'PENDING' }, { name: 'expectedSha', kind: 'text', notNull: true },
    { name: 'expectedSize', kind: 'int', notNull: true, def: 0 }, { name: 'changedAt', kind: 'time', notNull: true, def: 'now' },
  ], indexes: [{ name: 'FileShare_owner_source_key', cols: ['ownerId', 'sourceKey'], unique: true }] },
  { table: 'FileShareHidden', cols: [
    { name: 'id', kind: 'text', pk: true }, { name: 'fileId', kind: 'text', notNull: true, indexed: true },
    { name: 'userId', kind: 'text', notNull: true, indexed: true },
  ], indexes: [{ name: 'FileShareHidden_user_file', cols: ['userId', 'fileId'], unique: true }] },
  { table: 'FileShareEvent', cols: [
    { name: 'id', kind: 'text', pk: true }, { name: 'fileId', kind: 'text', notNull: true, indexed: true },
    { name: 'epoch', kind: 'int', notNull: true }, { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
  ] },
];
export async function ensureSharing(prisma: any): Promise<void> {
  return oncePerDatabase(prisma, 'file-sharing', async () => {
    const why = await ensureTables(prisma, SHARING_TABLES, undefined, true);
    if (why) throw Error(why);
  });
}
export const qShare = (id: string): string => getDialect() === 'mysql' ? `\`${id}\`` : `"${id}"`;
/** Имена фиксированы в коде, значения всегда отдельные параметры, включая PostgreSQL. */
export function shareSql(sql: string): string {
  let n = 0;
  return getDialect() === 'postgresql' ? sql.replace(/\?/g, () => `$${++n}`) : sql;
}
export async function shareRows(prisma: any, sql: string, ...values: unknown[]): Promise<any[]> {
  return prisma.$queryRawUnsafe(shareSql(sql), ...values);
}
export async function shareExec(prisma: any, sql: string, ...values: unknown[]): Promise<number> {
  return prisma.$executeRawUnsafe(shareSql(sql), ...values);
}
export async function shareOf(prisma: any, fileId: string): Promise<FileShare | null> {
  await ensureSharing(prisma);
  const rows = await shareRows(prisma, `SELECT * FROM ${qShare('FileShare')} WHERE ${qShare('fileId')} = ?`, fileId);
  return rows[0] || null;
}
export function recipientsOf(share: FileShare): string[] {
  try { const ids = JSON.parse(share.recipients); return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []; }
  catch { return []; }
}
export function shareAllows(share: FileShare, userId: string, write = false): boolean {
  if (!userId) return false;
  if (share.ownerId === userId) return true;
  return share.state === 'READY' && share.audience !== 'NONE' && (!write || share.permission === 'EDIT')
    && (share.audience === 'ALL' || recipientsOf(share).includes(userId));
}
/** Локальная блокировка не годится: строка общая для всех встроенных серверов. */
export async function lockShare(tx: any, fileId: string): Promise<FileShare | null> {
  await shareExec(tx, `UPDATE ${qShare('FileShare')} SET ${qShare('epoch')} = ${qShare('epoch')} WHERE ${qShare('fileId')} = ?`, fileId);
  const rows = await shareRows(tx, `SELECT * FROM ${qShare('FileShare')} WHERE ${qShare('fileId')} = ?`, fileId);
  return rows[0] || null;
}
export interface ShareWriteGuard { actorId: string; epoch?: number }
// Символ устанавливает сервер: одноимённое поле JSON нельзя подставить из окна.
export const SHARE_WRITE_GUARD = Symbol('share-write-guard');
export async function checkShareWrite(tx: any, fileId: string, guard: ShareWriteGuard): Promise<void> {
  const share = await lockShare(tx, fileId);
  if (!share && guard.epoch !== undefined) throw new ShareDenied();
  if (share && (share.state !== 'READY' || !shareAllows(share, guard.actorId, true) || guard.epoch !== undefined && Number(share.epoch) !== guard.epoch)) throw new ShareDenied();
}
export async function authorizedShareWrite<T>(prisma: any, fileId: string, actorId: string, write: (tx: any) => Promise<T>, epoch?: number): Promise<T> {
  await ensureSharing(prisma);
  return prisma.$transaction(async (tx: any) => {
    await checkShareWrite(tx, fileId, { actorId, epoch });
    return write(tx);
  }, { timeout: 120_000 });
}
export class ShareDenied extends Error { constructor() { super('Доступ к файлу отозван или разрешён только просмотр'); } }
/** Только явная очистка корзины освобождает привязку исходника для новой публикации. */
export async function forgetFileShare(tx: any, fileId: string): Promise<void> {
  if (!(await lockShare(tx, fileId))) return;
  for (const table of ['FileShareHidden', 'FileShareEvent', 'FileShare']) {
    await shareExec(tx, `DELETE FROM ${qShare(table)} WHERE ${qShare('fileId')} = ?`, fileId);
  }
}
export const shareHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function recordShareEvent(tx: any, fileId: string, epoch: number): Promise<void> {
  await shareExec(tx, `INSERT INTO ${qShare('FileShareEvent')} (${qShare('id')}, ${qShare('fileId')}, ${qShare('epoch')}, ${qShare('createdAt')}) VALUES (?, ?, ?, ?)`, randomUUID(), fileId, epoch, new Date());
}
