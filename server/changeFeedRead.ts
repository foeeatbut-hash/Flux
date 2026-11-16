/**
 * Чтение журнала изменений (server/changeFeed.ts): «кто изменил» в отказе по
 * версии и «кто создал и когда» в карточке записи.
 *
 * Автор и время создания отдельных колонок у записей не имеют (решение владельца,
 * 15.11.2026, п. 8): их даёт строка `create` журнала, а где её нет (запись
 * заведена до журнала) — колонки `createdAt`/`createdById`, если они у модели есть.
 * Любое чтение здесь «мягкое»: нет таблицы или сбой чтения — `null`, потому что
 * отказ по версии и карточка не должны падать из-за вспомогательной подписи.
 */

import { delegateOf, projectIdsOf, scopeField } from './changeFeedScope.js';

/** Кто и когда изменил запись последним */
export interface ChangedBy { userId: string; name: string; at: string }

/** Последняя строка журнала по записи; автора нет («система») — `null` */
export async function lastChange(db: any, model: string, recordId: string): Promise<ChangedBy | null> {
  try {
    const row = await db.changeFeed.findFirst({ where: { model, recordId }, orderBy: { seq: 'desc' } });
    if (!row || !row.userId) return null;
    return { userId: String(row.userId), name: String(row.userName || ''), at: new Date(row.at).toISOString() };
  } catch (_) {
    return null;
  }
}

export interface RecordOrigin {
  createdBy: { userId: string; name: string } | null;
  createdAt: string | null;
  /** Проект записи — для проверки доступа маршрутом; клиенту не отдаётся */
  projectId: string | null;
}

/** Модели с колонкой `createdAt` и с колонкой `createdById` (схема Prisma) */
const HAS_CREATED_AT = new Set(['Project', 'Tag', 'EquipmentSystem', 'Monoblock', 'ComponentElement', 'DocRegister', 'DocRegisterItem', 'ConstructorDoc', 'FileNode']);
const HAS_CREATED_BY = new Set(['ComponentElement', 'DocRegister', 'ConstructorDoc', 'FileNode']);

async function nameOf(db: any, userId: string): Promise<string> {
  try {
    const u = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
    return String(u?.name || '');
  } catch (_) {
    return '';
  }
}

/**
 * Кто создал запись и когда. Запись и строки журнала могут отсутствовать вовсе —
 * тогда всё `null` (клиент не показывает строку «Создал»).
 */
export async function recordOrigin(db: any, model: string, id: string): Promise<RecordOrigin> {
  const delegate = delegateOf(model);
  let projectId: string | null = null;
  let record: any = null;
  try {
    const select: Record<string, boolean> = { id: true };
    const field = scopeField(model);
    if (field) select[field] = true;
    if (HAS_CREATED_AT.has(model)) select.createdAt = true;
    if (HAS_CREATED_BY.has(model)) select.createdById = true;
    record = await db[delegate].findUnique({ where: { id }, select });
    if (record) projectId = (await projectIdsOf(db, model, [record])).get(id) ?? null;
  } catch (_) { /* запись не прочли — остаётся журнал */ }

  let row: any = null;
  try {
    row = await db.changeFeed.findFirst({ where: { model, recordId: id, kind: 'create' }, orderBy: { seq: 'asc' } });
    // Записи нет в базе (удалена), а журнал помнит её проект — доступ проверяется по нему
    if (!projectId && row?.projectId) projectId = String(row.projectId);
  } catch (_) { /* таблицы журнала нет */ }

  if (row) {
    const userId = row.userId ? String(row.userId) : '';
    return {
      createdBy: userId ? { userId, name: String(row.userName || '') || await nameOf(db, userId) } : null,
      createdAt: new Date(row.at).toISOString(),
      projectId,
    };
  }
  const by = record?.createdById ? String(record.createdById) : '';
  return {
    createdBy: by ? { userId: by, name: await nameOf(db, by) } : null,
    createdAt: record?.createdAt ? new Date(record.createdAt).toISOString() : null,
    projectId,
  };
}
