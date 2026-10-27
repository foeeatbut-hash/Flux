/**
 * Подразделения: дерево, имена и правила вложенности — одни на окно и сервер.
 *
 * Чистый модуль (ни React, ни express, ни базы): дерево строится по плоскому
 * списку, а правила «кого куда можно вложить» нужны и серверу (отказать), и
 * экрану (не предлагать невозможное). Две копии разошлись бы молча.
 * Устройство данных — docs/departments.md.
 */

export type DepartmentKind = 'company' | 'branch' | 'division' | 'group';

export interface DepartmentLite {
  id: string;
  name: string;
  shortName?: string | null;
  kind: DepartmentKind | string;
  city?: string | null;
  timezone?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  archivedAt?: string | Date | null;
}

export interface DepartmentNode<T extends DepartmentLite = DepartmentLite> {
  dept: T;
  children: DepartmentNode<T>[];
  depth: number;
}

/** Идентификатор корня «Компания»: фиксированный, чтобы два параллельных запроса не создали два корня. */
export const ROOT_DEPARTMENT_ID = 'dept-root';
export const ROOT_DEPARTMENT_NAME = 'Компания';

export const KIND_LABEL: Record<string, string> = {
  company: 'Компания', branch: 'Город', division: 'Отдел', group: 'Группа',
};

const RANK: Record<string, number> = { company: 0, branch: 1, division: 2, group: 3 };

/**
 * Можно ли вложить подразделение вида `child` в `parent`. Город — только прямо
 * в компанию, группа — только внутрь отдела или другой группы, отдел — куда
 * угодно ниже компании и города; компания одна и в другое не вкладывается.
 */
export function canNest(parentKind: string, childKind: string): boolean {
  if (childKind === 'company') return false;
  if (!(parentKind in RANK) || !(childKind in RANK)) return false;
  if (childKind === 'branch') return parentKind === 'company';
  if (childKind === 'division') return parentKind !== 'group';
  return true; // group: внутри отдела, города, компании и другой группы
}

/** Вид нового подразделения по родителю, если человек его не назвал. */
export function defaultKindFor(parentKind: string): DepartmentKind {
  if (parentKind === 'company') return 'branch';
  if (parentKind === 'branch') return 'division';
  return 'group';
}

/** Название для сравнения: без регистра, лишних пробелов и различия «е/ё». */
export function normalizeDepartmentName(value: unknown): string {
  return String(value ?? '').replace(/[\s ]+/g, ' ').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

/** Разбор записи «Город / Отдел» или «Город > Отдел» на части. Одно слово — одна часть. */
export function splitDepartmentPath(value: unknown): string[] {
  return String(value ?? '').split(/\s*[/>\\]\s*/).map((s) => s.replace(/[\s ]+/g, ' ').trim()).filter(Boolean);
}

const bySort = (a: DepartmentLite, b: DepartmentLite) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name), 'ru');

/** Дерево из плоского списка. Узел с потерянным родителем всплывает наверх, а не пропадает. */
export function buildDepartmentTree<T extends DepartmentLite>(list: T[]): DepartmentNode<T>[] {
  const ids = new Set(list.map((d) => d.id));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const d of list) {
    if (d.parentId && ids.has(d.parentId) && d.parentId !== d.id) {
      const arr = kids.get(d.parentId) || [];
      arr.push(d); kids.set(d.parentId, arr);
    } else roots.push(d);
  }
  const seen = new Set<string>();
  const make = (d: T, depth: number): DepartmentNode<T> => {
    seen.add(d.id);
    return { dept: d, depth, children: (kids.get(d.id) || []).sort(bySort).filter((c) => !seen.has(c.id)).map((c) => make(c, depth + 1)) };
  };
  return roots.sort(bySort).map((r) => make(r, 0));
}

/** Идентификаторы подразделения и всего, что внутри него. */
export function subtreeIds(list: DepartmentLite[], id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const d of list) if (d.parentId) kids.set(d.parentId, [...(kids.get(d.parentId) || []), d.id]);
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) for (const c of kids.get(stack.pop()!) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  return out;
}

/** Перенос `id` под `parentId` замкнул бы дерево в кольцо (в себя или в своего потомка). */
export function wouldCycle(list: DepartmentLite[], id: string, parentId: string | null | undefined): boolean {
  if (!parentId) return false;
  return subtreeIds(list, id).has(parentId);
}

/** Цепочка названий от корня до подразделения, без самого корня «Компания». */
export function departmentPath(list: DepartmentLite[], id: string | null | undefined): DepartmentLite[] {
  const byId = new Map(list.map((d) => [d.id, d]));
  const out: DepartmentLite[] = [];
  const seen = new Set<string>();
  for (let cur = id ? byId.get(id) : undefined; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out.filter((d) => d.kind !== 'company');
}

/** «Новосибирск / ОВиК» — для подписи в списке и выборе. */
export function departmentLabel(list: DepartmentLite[], id: string | null | undefined): string {
  const path = departmentPath(list, id);
  if (path.length) return path.map((d) => d.name).join(' / ');
  const root = id ? list.find((d) => d.id === id) : undefined;
  return root?.name || '';
}

/** Допустимое имя пояса IANA: проверку делает сам движок дат. */
export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('ru', { timeZone: tz.trim() }); return true; } catch { return false; }
}
