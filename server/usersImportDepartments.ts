/**
 * Подразделения в импорте сотрудников.
 *
 * Колонка «Отдел / Подразделение» сопоставляется со справочником по названию
 * (server/departmentsMatch.ts). Предпросмотр ничего не пишет: он показывает,
 * какие значения совпали, какие неоднозначны, а каких нет — и предлагает
 * создать их галочкой. Применение создаёт отмеченные подразделения в той же
 * транзакции, что и сотрудников, а отмена импорта убирает и их.
 */

import type { DepartmentLite } from '../shared/departments.js';
import { departmentLabel } from '../shared/departments.js';
import { DepartmentError, historyRows, removeCreatedDepartments, type BatchCreated, type BatchUser } from './departments.js';
import { createChain, departmentTextKey, resolveDepartmentText, type TextMatch } from './departmentsMatch.js';
import type { UserImportRow } from './usersImport.js';

export interface RowDepartment {
  status: 'none' | 'match' | 'create' | 'ambiguous';
  departmentId?: string;
  label?: string;
  key?: string;
  candidates?: string[];
}

export interface DepartmentToCreate { key: string; text: string; chain: string[]; parentId: string; parentLabel: string; count: number }

/** Каждой строке — что значит её подразделение. Неоднозначное — ошибка строки: угадывать нельзя. */
export function resolveRowDepartments(rows: UserImportRow[], list: DepartmentLite[], parentId?: string) {
  const perRow = new Map<number, RowDepartment>();
  const toCreate = new Map<string, DepartmentToCreate>();
  for (const row of rows) {
    const text = row.values.department;
    const key = departmentTextKey(text);
    if (!key) { perRow.set(row.row, { status: 'none' }); continue; }
    const match: TextMatch = resolveDepartmentText(text, list, parentId);
    if (match.status === 'match') perRow.set(row.row, { status: 'match', departmentId: match.departmentId, label: departmentLabel(list, match.departmentId), key });
    else if (match.status === 'ambiguous') {
      perRow.set(row.row, { status: 'ambiguous', candidates: match.candidates, key });
      if (!row.error) row.error = `Подразделение «${text}» неоднозначно: ${match.candidates.join('; ')}. Напишите «Город / Отдел»`;
    } else if (match.status === 'create') {
      perRow.set(row.row, { status: 'create', key });
      const known = toCreate.get(key);
      if (known) known.count++;
      else toCreate.set(key, { key, text, chain: match.chain, parentId: match.parentId, parentLabel: departmentLabel(list, match.parentId), count: 1 });
    } else perRow.set(row.row, { status: 'none' });
  }
  return { perRow, toCreate: [...toCreate.values()] };
}

/**
 * В транзакции создаёт отмеченные подразделения и возвращает, какое подразделение получит каждая строка.
 * Строка, чьё подразделение не отмечено к созданию, остаётся без подразделения (текст сохраняется как был).
 */
export async function createImportDepartments(
  tx: any, rows: UserImportRow[], list: DepartmentLite[], createKeys: Set<string>, parentId: string | undefined, actorId: string,
) {
  const resolved = resolveRowDepartments(rows, list, parentId);
  const unclear = rows.find((r) => resolved.perRow.get(r.row)?.status === 'ambiguous');
  if (unclear) throw new DepartmentError(409, `Подразделение «${unclear.values.department}» неоднозначно. Повторите предпросмотр.`);
  const created: BatchCreated[] = [];
  const byKey = new Map<string, string>();
  const target = new Map<number, string | null>();
  for (const row of rows) {
    const info = resolved.perRow.get(row.row);
    if (info?.status === 'match') target.set(row.row, info.departmentId!);
    else if (info?.status === 'create' && info.key && createKeys.has(info.key)) {
      let id = byKey.get(info.key);
      if (!id) {
        const plan = resolved.toCreate.find((c) => c.key === info.key)!;
        id = await createChain(tx, list, plan.parentId, plan.chain, actorId, created);
        byKey.set(info.key, id);
      }
      target.set(row.row, id);
    } else target.set(row.row, null);
  }
  return { target, created };
}

/** История переводов для партии импорта: из прежнего подразделения в новое. */
export const importHistory = (users: BatchUser[], actorId: string, token: string) =>
  historyRows(users, actorId, token, 'Импорт сотрудников');

/**
 * Отмена импорта, часть про подразделения (вызывается внутри транзакции после
 * восстановления самих сотрудников): созданным людям стирается их запись
 * истории этой партии, изменённым — пишется обратный перевод, созданные
 * партией подразделения удаляются, если в них никого и ничего не появилось.
 */
export async function undoImportDepartments(
  tx: any, token: string, actorId: string,
  items: Array<{ kind: 'create' | 'update'; id: string; before?: any; after?: any }>, created: BatchCreated[],
) {
  const reverse: BatchUser[] = [];
  for (const item of items) {
    if (item.kind === 'create') {
      await tx.userDepartmentHistory.deleteMany({ where: { userId: item.id, batchId: token } });
    } else if (item.after && 'departmentId' in item.after && item.before && item.after.departmentId !== item.before.departmentId) {
      reverse.push({ id: item.id, from: item.after.departmentId ?? null, to: item.before.departmentId ?? null });
    }
  }
  if (reverse.length) await tx.userDepartmentHistory.createMany({ data: historyRows(reverse, actorId, token, 'Отмена импорта') });
  if (created.length) await removeCreatedDepartments(tx, created);
}
