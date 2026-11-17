/**
 * Кому назначено обычное обновление: сотрудникам и подразделениям.
 *
 * Состав подразделения считается НА МОМЕНТ ПРОВЕРКИ, а не при назначении: человек, которого
 * перевели в подразделение позже, получает обновление, а выведенный из него — перестаёт, если
 * ещё не поставил (решение руководителя, владелец не подтверждал; ответ владельца 15 ноября 2026:
 * «добавленный позже получает» — «Да»). Поэтому в назначении лежат номера подразделений и
 * сотрудников, а не снимок состава.
 *
 * Без базы и сети: правила проверяются скриптом (scripts/test-update-assign-audience.ts).
 */
import { compareVersions } from '../shared/versionCompare.js';

export interface UpdateAssignment {
  v: 1; id: string; version: string; generation: string;
  userIds: string[]; departmentIds: string[];
  createdAt: number; createdBy: string; cancelledAt?: number; cancelledBy?: string;
}
export interface AudienceUser { id: string; departmentId?: string | null; isActive?: boolean }
export interface AudienceDepartment { id: string; parentId?: string | null; archivedAt?: unknown }

/** Не больше, чем разумно показать владельцу и вычислить за один запрос сотрудника */
export const ASSIGN_MAX_USERS = 2000;
export const ASSIGN_MAX_DEPARTMENTS = 500;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Подразделения вместе со всеми вложенными: «Отдел вентиляции» включает его группы */
export function departmentScope(departments: AudienceDepartment[], roots: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const d of departments) if (d.parentId) children.set(d.parentId, [...(children.get(d.parentId) || []), d.id]);
  const scope = new Set<string>(), queue = roots.filter(id => departments.some(d => d.id === id));
  while (queue.length) {
    const id = queue.pop()!;
    if (scope.has(id)) continue; // защита от цикла в дереве
    scope.add(id);
    queue.push(...(children.get(id) || []));
  }
  return scope;
}

/** Назначено ли обновление человеку прямо сейчас */
export function coversUser(a: UpdateAssignment, user: AudienceUser, departments: AudienceDepartment[]): boolean {
  if (a.cancelledAt || user.isActive === false) return false;
  if (a.userIds.includes(user.id)) return true;
  return !!user.departmentId && departmentScope(departments, a.departmentIds).has(user.departmentId);
}

/**
 * Какое назначение предлагать человеку: самое новое по номеру версии среди тех, что его касаются
 * и новее установленной у него версии. Установившему назначение больше ничего не предлагает.
 */
export function pickAssignment(list: UpdateAssignment[], user: AudienceUser, departments: AudienceDepartment[], current: string): UpdateAssignment | null {
  let best: UpdateAssignment | null = null;
  for (const a of list) {
    if (!coversUser(a, user, departments) || compareVersions(a.version, current) <= 0) continue;
    if (!best || compareVersions(a.version, best.version) > 0 || (a.version === best.version && a.createdAt > best.createdAt)) best = a;
  }
  return best;
}

/** Разбор записи из базы: чужая или повреждённая запись назначением не считается */
export function readAssignment(value: unknown): UpdateAssignment | null {
  let a: any = value;
  if (typeof value === 'string') { try { a = JSON.parse(value); } catch { return null; } }
  if (!a || a.v !== 1 || !ID.test(String(a.id)) || typeof a.version !== 'string' || typeof a.generation !== 'string'
    || !Array.isArray(a.userIds) || !Array.isArray(a.departmentIds)
    || !a.userIds.every((x: unknown) => ID.test(String(x))) || !a.departmentIds.every((x: unknown) => ID.test(String(x)))
    || !Number.isSafeInteger(a.createdAt) || typeof a.createdBy !== 'string') return null;
  return a as UpdateAssignment;
}

/** Состав, который владелец собрал в окне: отсекает повторы, пустое и слишком большое */
export function cleanAudience(body: any): { userIds: string[]; departmentIds: string[] } | string {
  const ids = (x: unknown) => Array.isArray(x) ? [...new Set(x.map(String))] : null;
  const userIds = ids(body?.userIds ?? []), departmentIds = ids(body?.departmentIds ?? []);
  if (!userIds || !departmentIds || ![...userIds, ...departmentIds].every(x => ID.test(x))) return 'Состав назначения указан неверно.';
  if (!userIds.length && !departmentIds.length) return 'Выберите подразделение или сотрудника.';
  if (userIds.length > ASSIGN_MAX_USERS || departmentIds.length > ASSIGN_MAX_DEPARTMENTS) return 'Выбрано слишком много: назначьте подразделением.';
  return { userIds, departmentIds };
}
