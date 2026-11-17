/**
 * Хранение назначений обычного обновления: строки AppSetting с ключом `update.assign`.
 * Версионных моделей здесь нет, поэтому записи идут обычным клиентом базы или клиентом
 * транзакции, который передаёт вызывающий.
 */
import { compareVersions } from '../shared/versionCompare.js';
import { readAssignment, type UpdateAssignment } from './updateAudience.js';

export const ASSIGN_KEY = 'update.assign';
export const assignRowId = (id: string) => `${ASSIGN_KEY}:${id}`;
/** Больше строк читать не будем: список требует обслуживания, а не тихо обрезается */
export const ASSIGN_ROWS_MAX = 5000;

export async function listAssignments(db: any): Promise<UpdateAssignment[]> {
  const rows = await db.appSetting.findMany({ where: { key: ASSIGN_KEY, userId: null }, take: ASSIGN_ROWS_MAX + 1 });
  if (rows.length > ASSIGN_ROWS_MAX) throw new Error('Список назначений обновлений требует обслуживания.');
  return rows.map((r: any) => readAssignment(r.value)).filter(Boolean) as UpdateAssignment[];
}

/** Отметить назначение отменённым: сравнение со старым значением, чтобы две отмены не затёрли друг друга */
export async function cancelAssignment(db: any, id: string, by: string, at: number): Promise<'done' | 'already' | 'missing' | 'conflict'> {
  const row = await db.appSetting.findUnique({ where: { id: assignRowId(id) } });
  const a = row ? readAssignment(row.value) : null;
  if (!row || !a) return 'missing';
  if (a.cancelledAt) return 'already';
  const next = { ...a, cancelledAt: at, cancelledBy: by };
  const changed = await db.appSetting.updateMany({ where: { id: row.id, value: row.value }, data: { value: JSON.stringify(next) } });
  return changed.count === 1 ? 'done' : 'conflict';
}

/**
 * Возврат версии отменяет назначения всё, что выше возвращаемой: иначе выпуск, от которого
 * только что откатились, снова предложили бы тем, кого на него назначали по подразделению.
 * Идёт в транзакции возврата, поэтому конфликт отмены роняет и сам возврат.
 */
export async function cancelAssignmentsAbove(tx: any, version: string, by: string, at: number): Promise<number> {
  let n = 0;
  for (const a of await listAssignments(tx)) {
    if (a.cancelledAt || compareVersions(a.version, version) <= 0) continue;
    if (await cancelAssignment(tx, a.id, by, at) === 'conflict') throw new Error('CONFLICT');
    n++;
  }
  return n;
}
