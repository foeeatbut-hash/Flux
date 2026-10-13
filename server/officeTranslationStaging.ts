import { randomUUID } from 'node:crypto';
import type { OfficeTranslationDelta } from './officeBindings.js';

interface StagedTranslation {
  token: string; fileId: string; userId: string; baseSha: string; delta: OfficeTranslationDelta;
  expiresAt: number; state: 'ready' | 'inFlight';
}

const TTL_MS = 5 * 60_000;
const KEY_PREFIX = 'office_translation_stage:';
const rowId = (token: string) => `${KEY_PREFIX}${token}`;

function parse(value: unknown): StagedTranslation | null {
  try {
    const item = JSON.parse(String(value || '')) as StagedTranslation;
    if (!item || typeof item.token !== 'string' || typeof item.fileId !== 'string' || typeof item.userId !== 'string' ||
        typeof item.baseSha !== 'string' || !item.delta || !Number.isFinite(item.expiresAt) ||
        !['ready', 'inFlight'].includes(item.state)) return null;
    return item;
  } catch { return null; }
}

/** Хранит подготовленный перевод в общей базе, чтобы его мог записать любой серверный экземпляр. */
export async function stageOfficeTranslation(db: any, delta: Omit<StagedTranslation, 'token' | 'expiresAt' | 'state'>): Promise<string> {
  const now = Date.now();
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: KEY_PREFIX }, userId: delta.userId }, select: { id: true, value: true }, take: 101 });
  for (const row of rows) {
    const item = parse(row.value);
    if (!item || item.expiresAt <= now) await db.appSetting.deleteMany({ where: { id: row.id, value: row.value } });
  }
  const active = rows.filter((row: any) => { const item = parse(row.value); return item && item.expiresAt > now; }).length;
  if (active >= 100) throw new Error('Для этого пользователя уже подготовлено слишком много сохранений перевода');
  const token = randomUUID();
  const item: StagedTranslation = { ...delta, token, expiresAt: now + TTL_MS, state: 'ready' };
  await db.appSetting.create({ data: { id: rowId(token), key: rowId(token), userId: delta.userId, value: JSON.stringify(item) } });
  return token;
}

/** CAS в AppSetting не даёт параллельным серверным экземплярам использовать токен дважды. */
export async function claimStagedOfficeTranslation(db: any, token: string, fileId: string, userId: string, baseSha: string): Promise<{ delta: OfficeTranslationDelta; finish: (saved: boolean) => Promise<void> } | null> {
  const id = rowId(token);
  const row = await db.appSetting.findUnique({ where: { id } });
  const item = row && parse(row.value);
  if (!item || item.state !== 'ready' || item.expiresAt <= Date.now() || item.fileId !== fileId || item.userId !== userId || item.baseSha !== baseSha) return null;
  const claimed: StagedTranslation = { ...item, state: 'inFlight' };
  const claimedValue = JSON.stringify(claimed);
  const won = await db.appSetting.updateMany({ where: { id, value: row.value }, data: { value: claimedValue } });
  if (won.count !== 1) return null;
  return {
    delta: item.delta,
    finish: async (saved) => {
      try {
        if (saved) await db.appSetting.deleteMany({ where: { id, value: claimedValue } });
        else await db.appSetting.updateMany({ where: { id, value: claimedValue }, data: { value: row.value } });
      } catch {
        // После сохранения токен может остаться занят до TTL, но ошибка очистки не отменяет запись файла.
      }
    },
  };
}
