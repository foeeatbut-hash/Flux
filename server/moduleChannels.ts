/**
 * Каналы выпуска модулей: «рабочий» видят все, «тестовый» — назначенные
 * владельцем люди (решение владельца: сначала тестировщикам, затем всем).
 *
 * Назначение — политика, а не защита: выпуск тестового канала всё равно
 * подписан владельцем, и кто его увидит, решает владелец. Поэтому список
 * лежит обычной настройкой (AppSetting), а не подписанной записью.
 */
import type { ModuleChannel } from '../modules/trust/claims.js';

const KEY = 'modules.testers';

export async function testersOf(db: any): Promise<string[]> {
  const row = await db.appSetting.findFirst({ where: { key: KEY, userId: null } }).catch(() => null);
  try {
    const list = JSON.parse(row?.value || '[]');
    return Array.isArray(list) ? list.filter((v: unknown) => typeof v === 'string').slice(0, 5000) : [];
  } catch { return []; }
}

export async function saveTesters(db: any, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 80))].slice(0, 5000);
  const value = JSON.stringify(unique);
  const row = await db.appSetting.findFirst({ where: { key: KEY, userId: null } });
  if (row) await db.appSetting.update({ where: { id: row.id }, data: { value } });
  else await db.appSetting.create({ data: { key: KEY, userId: null, value } });
  return unique;
}

/** Каналы человека: рабочий — всем, тестовый — владельцу и назначенным */
export async function channelsFor(db: any, user: { id?: string; role?: string } | null | undefined): Promise<ModuleChannel[]> {
  if (!user) return [];
  if (user.role === 'OWNER') return ['production', 'test'];
  return (await testersOf(db)).includes(String(user.id || '')) ? ['production', 'test'] : ['production'];
}

/** Должности человека: основная и дополнительные (для «обязательных для ролей» и «для моей должности») */
export function positionsOf(user: any): string[] {
  const list = [user?.positionCode || user?.role];
  try { const extra = JSON.parse(user?.extraPositions || '[]'); if (Array.isArray(extra)) list.push(...extra); } catch { /* нет дополнительных */ }
  return [...new Set(list.filter((v) => typeof v === 'string' && v))] as string[];
}

export async function promotionsOf(db: any): Promise<string[]> {
  const rows = await db.appSetting.findMany({ where: { key: 'modules.promotions', userId: null }, select: { value: true } }).catch(() => []);
  return rows.map((row: any) => row.value).filter((value: unknown): value is string => typeof value === 'string');
}
