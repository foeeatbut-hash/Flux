/**
 * Подразделения: справочник и перевод людей — вся запись в базу здесь.
 *
 * Маршруты (server/routes/departments.ts) только проверяют права и зовут эти
 * функции. Правила записи — flux-data-safety: перед массовым действием есть
 * план (planAssign), применение идёт одной транзакцией вместе с историей, а
 * снимок прежнего состояния сохраняется ДО записи и даёт откат (undoBatch).
 * Фрагмент ничего не удаляет: откат убирает только то, что создала сама
 * партия, и только если в созданном никого и ничего больше не появилось.
 */

import { randomBytes } from 'node:crypto';
import {
  ROOT_DEPARTMENT_ID, ROOT_DEPARTMENT_NAME, canNest, defaultKindFor, isValidTimezone,
  normalizeDepartmentName, subtreeIds, wouldCycle, type DepartmentLite,
} from '../shared/departments.js';

/** Ошибка с кодом ответа: маршрут отдаёт её человеку как есть. */
export class DepartmentError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Сколько живёт возможность отменить партию. Дольше суток — уже не «отмена», а новая правка. */
export const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_PREFIX = 'department_batch:';

export interface BatchUser { id: string; from: string | null; to: string | null }
export interface BatchCreated { id: string; name: string; parentId: string | null }
export interface BatchSnapshot {
  kind: 'assign' | 'archive' | 'legacy';
  actorId: string;
  expiresAt: number;
  undone: boolean;
  users: BatchUser[];
  created: BatchCreated[];
  archived: string[];
  archivedAt?: string;
}

const clean = (v: unknown, max: number): string => String(v ?? '').replace(/[\s ]+/g, ' ').trim().slice(0, max);
const optional = (v: unknown, max: number): string | null => clean(v, max) || null;

/** Корень «Компания» создаётся сам. Зовётся вне транзакции: сбой вставки в PostgreSQL портит всю транзакцию. */
export async function ensureRootDepartment(db: any): Promise<any> {
  const find = () => db.department.findFirst({ where: { kind: 'company', parentId: null } });
  const existing = await find();
  if (existing) return existing;
  try {
    return await db.department.create({ data: { id: ROOT_DEPARTMENT_ID, name: ROOT_DEPARTMENT_NAME, kind: 'company', createdBy: 'system' } });
  } catch (error) {
    const again = await find(); // параллельный запрос успел раньше
    if (again) return again;
    throw error;
  }
}

export async function listDepartments(db: any): Promise<any[]> {
  return db.department.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

/** Людей по подразделениям: прямо в нём и во всём поддереве. Служебные записи — не сотрудники. */
export async function countPeople(db: any, list: DepartmentLite[]) {
  const rows = await db.user.groupBy({ by: ['departmentId'], where: { role: { not: 'SERVICE' } }, _count: { _all: true } });
  const own = new Map<string, number>();
  let unassigned = 0;
  for (const r of rows as any[]) {
    if (r.departmentId) own.set(r.departmentId, (own.get(r.departmentId) || 0) + r._count._all);
    else unassigned += r._count._all;
  }
  const kids = new Map<string, string[]>();
  for (const d of list) if (d.parentId) kids.set(d.parentId, [...(kids.get(d.parentId) || []), d.id]);
  const total = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    if (total.has(id)) return total.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const sum = (own.get(id) || 0) + (kids.get(id) || []).reduce((s, c) => s + walk(c, seen), 0);
    total.set(id, sum);
    return sum;
  };
  for (const d of list) walk(d.id, new Set());
  return { own, total, unassigned };
}

function ensureUniqueName(list: DepartmentLite[], parentId: string, name: string, exceptId?: string): void {
  const n = normalizeDepartmentName(name);
  const dup = list.find((d) => d.id !== exceptId && !d.archivedAt && d.parentId === parentId && normalizeDepartmentName(d.name) === n);
  if (dup) throw new DepartmentError(409, `Внутри этого подразделения уже есть «${dup.name}»`);
}

function timezoneOf(v: unknown): string | null {
  const tz = optional(v, 64);
  if (tz && !isValidTimezone(tz)) throw new DepartmentError(400, `Неизвестный часовой пояс: ${tz}. Пример: Asia/Novosibirsk`);
  return tz;
}

export interface DepartmentInput {
  name?: unknown; parentId?: unknown; kind?: unknown; shortName?: unknown; city?: unknown; timezone?: unknown; sortOrder?: unknown;
}

export async function createDepartment(prisma: any, actorId: string, input: DepartmentInput) {
  const root = await ensureRootDepartment(prisma);
  const name = clean(input.name, 120);
  if (!name) throw new DepartmentError(400, 'Укажите название подразделения');
  const parentId = clean(input.parentId, 64) || root.id;
  const timezone = timezoneOf(input.timezone);
  return prisma.$transaction(async (tx: any) => {
    const list = await listDepartments(tx);
    const parent = list.find((d: any) => d.id === parentId);
    if (!parent) throw new DepartmentError(404, 'Родительское подразделение не найдено');
    if (parent.archivedAt) throw new DepartmentError(409, 'Родительское подразделение в архиве');
    const kind = clean(input.kind, 16) || defaultKindFor(parent.kind);
    if (!canNest(parent.kind, kind)) throw new DepartmentError(400, 'Так вкладывать нельзя: город — прямо в компанию, группа — в отдел');
    ensureUniqueName(list, parent.id, name);
    const siblings = list.filter((d: any) => d.parentId === parent.id && !d.archivedAt);
    const sortOrder = Number.isFinite(Number(input.sortOrder)) && input.sortOrder !== undefined
      ? Math.trunc(Number(input.sortOrder))
      : siblings.reduce((m: number, d: any) => Math.max(m, d.sortOrder ?? 0), 0) + 1;
    return tx.department.create({ data: {
      name, kind, parentId: parent.id, shortName: optional(input.shortName, 40),
      city: optional(input.city, 80) ?? (kind === 'branch' ? name : null), timezone, sortOrder, createdBy: actorId,
    } });
  });
}

export async function updateDepartment(prisma: any, id: string, input: DepartmentInput) {
  return prisma.$transaction(async (tx: any) => {
    const list = await listDepartments(tx);
    const dept = list.find((d: any) => d.id === id);
    if (!dept) throw new DepartmentError(404, 'Подразделение не найдено');
    const data: any = {};
    if (input.name !== undefined) {
      const name = clean(input.name, 120);
      if (!name) throw new DepartmentError(400, 'Название не может быть пустым');
      if (dept.parentId) ensureUniqueName(list, dept.parentId, name, id);
      data.name = name;
    }
    if (input.kind !== undefined && input.kind !== dept.kind) {
      const kind = clean(input.kind, 16);
      const parent = list.find((d: any) => d.id === dept.parentId);
      if (dept.kind === 'company' || kind === 'company') throw new DepartmentError(400, 'Вид компании менять нельзя');
      if (!parent || !canNest(parent.kind, kind) || list.some((d: any) => d.parentId === id && !canNest(kind, d.kind))) {
        throw new DepartmentError(400, 'Такой вид не подходит к месту в дереве');
      }
      data.kind = kind;
    }
    if (input.shortName !== undefined) data.shortName = optional(input.shortName, 40);
    if (input.city !== undefined) data.city = optional(input.city, 80);
    if (input.timezone !== undefined) data.timezone = timezoneOf(input.timezone);
    if (input.sortOrder !== undefined) {
      const order = Number(input.sortOrder);
      if (!Number.isFinite(order)) throw new DepartmentError(400, 'Порядок должен быть числом');
      data.sortOrder = Math.trunc(order);
    }
    if (!Object.keys(data).length) return dept;
    return tx.department.update({ where: { id }, data });
  });
}

/** Перенос под другого родителя. Корень не переносится; в потомка и в себя — нельзя (кольцо). */
export async function moveDepartment(prisma: any, id: string, parentId: unknown, sortOrder?: unknown) {
  return prisma.$transaction(async (tx: any) => {
    const list = await listDepartments(tx);
    const dept = list.find((d: any) => d.id === id);
    if (!dept) throw new DepartmentError(404, 'Подразделение не найдено');
    if (dept.kind === 'company') throw new DepartmentError(400, 'Компанию переносить нельзя');
    if (dept.archivedAt) throw new DepartmentError(409, 'Подразделение в архиве; сначала верните его');
    const target = list.find((d: any) => d.id === String(parentId || ''));
    if (!target) throw new DepartmentError(404, 'Новое родительское подразделение не найдено');
    if (target.archivedAt) throw new DepartmentError(409, 'Нельзя переносить в архивное подразделение');
    if (wouldCycle(list, id, target.id)) throw new DepartmentError(400, 'Нельзя перенести подразделение внутрь самого себя или своего вложенного');
    if (!canNest(target.kind, dept.kind)) throw new DepartmentError(400, 'Так вкладывать нельзя: город — прямо в компанию, группа — в отдел');
    ensureUniqueName(list, target.id, dept.name, id);
    const siblings = list.filter((d: any) => d.parentId === target.id && !d.archivedAt && d.id !== id);
    const order = sortOrder !== undefined && Number.isFinite(Number(sortOrder))
      ? Math.trunc(Number(sortOrder))
      : siblings.reduce((m: number, d: any) => Math.max(m, d.sortOrder ?? 0), 0) + 1;
    return tx.department.update({ where: { id }, data: { parentId: target.id, sortOrder: order } });
  });
}

// ── Партии: снимок до записи и откат ────────────────────────────────────────

export function newUndoToken(): string { return randomBytes(24).toString('base64url'); }

/** Записывает снимок партии в той же транзакции, что и сама правка; заодно убирает просроченные. */
export async function saveBatch(tx: any, token: string, snapshot: Omit<BatchSnapshot, 'expiresAt' | 'undone'>): Promise<void> {
  const old = await tx.appSetting.findMany({ where: { key: { startsWith: BATCH_PREFIX } }, select: { id: true, value: true } });
  for (const row of old) {
    let expired = true;
    try { expired = JSON.parse(row.value)?.expiresAt < Date.now(); } catch { /* повреждённый снимок можно выбросить */ }
    if (expired) await tx.appSetting.delete({ where: { id: row.id } });
  }
  const full: BatchSnapshot = { ...snapshot, expiresAt: Date.now() + BATCH_TTL_MS, undone: false };
  await tx.appSetting.create({ data: { key: `${BATCH_PREFIX}${token}`, userId: snapshot.actorId, value: JSON.stringify(full) } });
}

export const historyRows = (users: BatchUser[], by: string, batchId: string, reason: string | null) =>
  users.map((u) => ({ userId: u.id, fromId: u.from, toId: u.to, by, reason, batchId }));

/**
 * Убирает подразделения, созданные партией: по точному номеру и только пустые —
 * без людей, без вложенных чужих и без переименований после создания. Любое
 * расхождение — отказ (вызывающий откатывает всю транзакцию).
 */
export async function removeCreatedDepartments(tx: any, created: BatchCreated[]): Promise<number> {
  const createdIds = new Set(created.map((c) => c.id));
  let removed = 0;
  for (const c of [...created].reverse()) {
    const dept = await tx.department.findUnique({ where: { id: c.id } });
    if (!dept) continue;
    if (dept.name !== c.name || dept.parentId !== c.parentId) throw new DepartmentError(409, `Подразделение «${dept.name}» изменили после создания; отмена не выполнена`);
    const [people, kids] = await Promise.all([
      tx.user.count({ where: { departmentId: c.id } }),
      tx.department.count({ where: { parentId: c.id, id: { notIn: [...createdIds] } } }),
    ]);
    if (people || kids) throw new DepartmentError(409, `В подразделении «${dept.name}» после создания появились люди или вложенные подразделения; отмена не выполнена`);
    await tx.department.delete({ where: { id: c.id } });
    removed++;
  }
  return removed;
}

/** Отмена партии: всё или ничего. Любое расхождение с тем, что записала партия, — отказ без единой правки. */
export async function undoBatch(prisma: any, actorId: string, token: string): Promise<{ restored: number; removed: number }> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new DepartmentError(404, 'Партия отмены не найдена');
  const row = await prisma.appSetting.findFirst({ where: { key: `${BATCH_PREFIX}${token}`, userId: actorId } });
  if (!row) throw new DepartmentError(404, 'Партия отмены не найдена');
  let batch: BatchSnapshot;
  try { batch = JSON.parse(row.value); } catch { throw new DepartmentError(404, 'Снимок партии повреждён'); }
  if (batch.undone || batch.expiresAt < Date.now()) throw new DepartmentError(404, 'Срок отмены истёк или партия уже отменена');
  return prisma.$transaction(async (tx: any) => {
    const claim = await tx.appSetting.updateMany({ where: { id: row.id, value: row.value }, data: { value: JSON.stringify({ ...batch, undone: true }) } });
    if (claim.count !== 1) throw new DepartmentError(409, 'Партию уже отменяют');
    const reverse: BatchUser[] = [];
    for (const u of batch.users) {
      const done = await tx.user.updateMany({ where: { id: u.id, departmentId: u.to }, data: { departmentId: u.from } });
      if (done.count !== 1) throw new DepartmentError(409, 'Подразделение сотрудника уже изменили после перевода; отмена не выполнена');
      reverse.push({ id: u.id, from: u.to, to: u.from });
    }
    if (reverse.length) await tx.userDepartmentHistory.createMany({ data: historyRows(reverse, actorId, token, 'Отмена перевода') });
    const removed = await removeCreatedDepartments(tx, batch.created);
    for (const id of batch.archived) {
      await tx.department.updateMany({ where: { id, archivedAt: batch.archivedAt ? new Date(batch.archivedAt) : undefined }, data: { archivedAt: null } });
    }
    return { restored: reverse.length, removed };
  }, { maxWait: 10000, timeout: 60000 });
}

// ── Перевод людей: план → применение ───────────────────────────────────────

export interface AssignPlanItem {
  userId: string; symbol: string; name: string; role: string;
  fromId: string | null; toId: string;
  status: 'move' | 'same' | 'skip';
  note?: string;
}

/** Кого нельзя переводить этому исполнителю: служебные записи, владельца и администраторов (как при импорте). */
function skipReason(user: any, actorRole: string): string | null {
  if (user.role === 'SERVICE') return 'Служебная запись, не сотрудник';
  if ((user.role === 'OWNER' || user.role === 'ADMIN') && actorRole !== 'OWNER') return 'Владельца и администратора переводит только владелец';
  return null;
}

export async function planAssign(db: any, userIds: string[], departmentId: string, actorRole: string): Promise<{ department: any; items: AssignPlanItem[] }> {
  const department = await db.department.findUnique({ where: { id: departmentId } });
  if (!department) throw new DepartmentError(404, 'Подразделение не найдено');
  if (department.archivedAt) throw new DepartmentError(409, 'Подразделение в архиве; переводить в него нельзя');
  const ids = [...new Set(userIds.map(String))];
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, symbol: true, name: true, role: true, departmentId: true } });
  const byId = new Map<string, any>(users.map((u: any) => [u.id, u]));
  const items: AssignPlanItem[] = ids.map((id) => {
    const u = byId.get(id);
    if (!u) return { userId: id, symbol: '', name: id, role: '', fromId: null, toId: departmentId, status: 'skip' as const, note: 'Сотрудник не найден' };
    const base = { userId: u.id, symbol: u.symbol, name: u.name, role: u.role, fromId: u.departmentId ?? null, toId: departmentId };
    const skip = skipReason(u, actorRole);
    if (skip) return { ...base, status: 'skip' as const, note: skip };
    return { ...base, status: u.departmentId === departmentId ? 'same' as const : 'move' as const };
  });
  return { department, items };
}

export async function applyAssign(prisma: any, actor: { id: string; role: string }, userIds: string[], departmentId: string, reason: unknown) {
  await ensureRootDepartment(prisma);
  const note = optional(reason, 300);
  const token = newUndoToken();
  const result = await prisma.$transaction(async (tx: any) => {
    const { items } = await planAssign(tx, userIds, departmentId, actor.role);
    const moves = items.filter((i) => i.status === 'move');
    const users: BatchUser[] = [];
    for (const m of moves) {
      // Условие «был здесь» ловит гонку: если человека успели перевести, не перезаписываем молча
      const done = await tx.user.updateMany({ where: { id: m.userId, departmentId: m.fromId }, data: { departmentId } });
      if (done.count !== 1) throw new DepartmentError(409, `«${m.name}» уже переведён другим администратором. Повторите предпросмотр.`);
      users.push({ id: m.userId, from: m.fromId, to: departmentId });
    }
    if (users.length) {
      await tx.userDepartmentHistory.createMany({ data: historyRows(users, actor.id, token, note) });
      await saveBatch(tx, token, { kind: 'assign', actorId: actor.id, users, created: [], archived: [] });
    }
    return { moved: users.length, same: items.filter((i) => i.status === 'same').length, skipped: items.filter((i) => i.status === 'skip'), users };
  }, { maxWait: 10000, timeout: 60000 });
  return { moved: result.moved, same: result.same, skipped: result.skipped, undoToken: result.moved ? token : null };
}

// ── Архив ──────────────────────────────────────────────────────────────────

/**
 * Архивация подразделения вместе с вложенными. Пока в них есть люди,
 * нужно сказать, куда их перевести: «пусто или с переводом» (docs/departments.md §3).
 */
export async function archiveDepartment(prisma: any, actor: { id: string; role: string }, id: string, moveTo?: unknown) {
  const token = newUndoToken();
  return prisma.$transaction(async (tx: any) => {
    const list = await listDepartments(tx);
    const dept = list.find((d: any) => d.id === id);
    if (!dept) throw new DepartmentError(404, 'Подразделение не найдено');
    if (dept.kind === 'company') throw new DepartmentError(400, 'Компанию в архив отправить нельзя');
    if (dept.archivedAt) throw new DepartmentError(409, 'Подразделение уже в архиве');
    const inside = subtreeIds(list, id);
    const live = [...inside].filter((x) => !list.find((d: any) => d.id === x)?.archivedAt);
    const people = await tx.user.findMany({ where: { departmentId: { in: [...inside] } }, select: { id: true, name: true, role: true, departmentId: true } });
    let target: any = null;
    if (people.length) {
      if (!moveTo) throw new DepartmentError(409, `В подразделении ${people.length} чел. Укажите, куда их перевести`, { needMoveTo: true, people: people.length });
      target = list.find((d: any) => d.id === String(moveTo));
      if (!target) throw new DepartmentError(404, 'Подразделение для перевода не найдено');
      if (target.archivedAt || inside.has(target.id)) throw new DepartmentError(409, 'Переводить можно только в действующее подразделение вне архивируемого');
      const blocked = people.find((p: any) => skipReason(p, actor.role));
      if (blocked) throw new DepartmentError(403, `${blocked.name}: ${skipReason(blocked, actor.role)}`);
    }
    const stamp = new Date();
    await tx.department.updateMany({ where: { id: { in: live }, archivedAt: null }, data: { archivedAt: stamp } });
    const users: BatchUser[] = [];
    for (const p of people) {
      const done = await tx.user.updateMany({ where: { id: p.id, departmentId: p.departmentId }, data: { departmentId: target.id } });
      if (done.count !== 1) throw new DepartmentError(409, 'Состав подразделения изменился. Повторите действие.');
      users.push({ id: p.id, from: p.departmentId, to: target.id });
    }
    if (users.length) await tx.userDepartmentHistory.createMany({ data: historyRows(users, actor.id, token, `Архив подразделения «${dept.name}»`) });
    await saveBatch(tx, token, { kind: 'archive', actorId: actor.id, users, created: [], archived: live, archivedAt: stamp.toISOString() });
    return { archived: live.length, moved: users.length, undoToken: token };
  }, { maxWait: 10000, timeout: 60000 });
}

/** Возврат из архива: само подразделение и вложенные, которые ушли в архив вместе с ним. Люди назад не переводятся. */
export async function restoreDepartment(prisma: any, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const list = await listDepartments(tx);
    const dept = list.find((d: any) => d.id === id);
    if (!dept) throw new DepartmentError(404, 'Подразделение не найдено');
    if (!dept.archivedAt) throw new DepartmentError(409, 'Подразделение не в архиве');
    const parent = list.find((d: any) => d.id === dept.parentId);
    if (!parent || parent.archivedAt) throw new DepartmentError(409, 'Родительское подразделение в архиве; сначала верните его');
    ensureUniqueName(list, parent.id, dept.name, id);
    const stamp = new Date(dept.archivedAt).getTime();
    const ids = [...subtreeIds(list, id)].filter((x) => {
      const d = list.find((e: any) => e.id === x);
      return d?.archivedAt && new Date(d.archivedAt).getTime() === stamp;
    });
    await tx.department.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null } });
    return { restored: ids.length };
  });
}

/** Для записи в карточке сотрудника и импорте: можно ли ставить это подразделение человеку. */
export async function assertAssignable(db: any, departmentId: string): Promise<any> {
  const dept = await db.department.findUnique({ where: { id: departmentId } });
  if (!dept) throw new DepartmentError(400, 'Выберите существующее подразделение');
  if (dept.archivedAt) throw new DepartmentError(409, 'Подразделение в архиве; выберите действующее');
  return dept;
}
