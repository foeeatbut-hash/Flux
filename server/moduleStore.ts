/**
 * Хранение модулей Flux Studio в общей базе: куски пакетов, подписанные
 * сертификаты и отзывы.
 *
 * Сервер проверяет подписи при приёме, чтобы мусор не доходил до очереди
 * владельца, но доверие держится не на нём: таблицы может переписать любой,
 * у кого есть реквизиты базы, поэтому каждый Flux проверяет выпуск сам перед
 * запуском (electron/moduleCache.ts).
 */
import crypto from 'node:crypto';
import { joinChunks, splitChunks } from '../modules/trust/bundle.js';
import { readCertificates, readRevocations, type RevokedSet } from '../modules/trust/verify.js';
import type { CertificateClaim } from '../modules/trust/claims.js';
import { UPDATE_PUBLIC_KEY_HEX } from '../electron/updateKey.js';

/**
 * Корень доверия модулей — ключ издателя обновлений (`electron/updateKey.ts`):
 * он уже зашит в exe и лежит в хранилище владельца как `keys.update`.
 * Подпись модуля не спутать с подписью exe — у записей разные префиксы.
 */
export const MODULE_ROOT_KEY_HEX = UPDATE_PUBLIC_KEY_HEX;

export const signatureHash = (signature: string) => crypto.createHash('sha256').update(signature).digest('hex');

/** Куски в порядке; пропуск или пустой кусок — ошибка: собирать пакет из дыр нельзя */
export async function readBlob(db: any, blobId: string, expected: number): Promise<Uint8Array[]> {
  const rows = await db.moduleChunk.findMany({ where: { blobId }, orderBy: { idx: 'asc' }, select: { idx: true, data: true } });
  if (rows.length !== expected) throw new Error('В базе неполный пакет модуля');
  return rows.map((r: any, i: number) => {
    if (r.idx !== i || !r.data?.length) throw new Error('В базе пропущен кусок пакета модуля');
    return new Uint8Array(Buffer.from(r.data));
  });
}

export async function readBundle(db: any, blobId: string, expected: number): Promise<Uint8Array> {
  return joinChunks(await readBlob(db, blobId, expected));
}

/** Куски кладутся до строки запроса: строка без пакета не должна попасть в очередь */
export async function writeBlob(db: any, blobId: string, bytes: Uint8Array): Promise<number> {
  const chunks = splitChunks(bytes);
  await db.moduleChunk.deleteMany({ where: { blobId } });
  for (let idx = 0; idx < chunks.length; idx++) await db.moduleChunk.create({ data: { blobId, idx, data: Buffer.from(chunks[idx]) } });
  return chunks.length;
}

export interface ModuleTrust { revoked: RevokedSet; certificates: Map<string, CertificateClaim> }

/** Действующие сертификаты и отзывы — только записи с подписью владельца */
export async function loadTrust(db: any, rootHex: string): Promise<ModuleTrust> {
  const revocations = await db.moduleRevocation.findMany({ select: { signature: true } });
  const revoked = readRevocations(revocations.map((r: any) => r.signature), rootHex);
  const certs = await db.moduleCertificate.findMany({ select: { signature: true } });
  return { revoked, certificates: readCertificates(certs.map((r: any) => r.signature), rootHex, revoked) };
}
