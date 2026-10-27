/**
 * Сопоставление текста с подразделениями: мастер переноса старых значений
 * `User.department` и колонка «Подразделение» при импорте сотрудников.
 *
 * Правило одно и то же в обоих местах (flux-data-safety §5 — не угадывать по
 * мелочи): имя совпадает без учёта регистра, пробелов и «е/ё»; два одинаковых
 * имени в разных городах — не угадываем, а просим уточнить «Город / Отдел».
 */

import {
  canNest, defaultKindFor, normalizeDepartmentName, splitDepartmentPath, type DepartmentLite,
} from '../shared/departments.js';
import {
  DepartmentError, ensureRootDepartment, historyRows, listDepartments, newUndoToken, saveBatch,
  type BatchCreated, type BatchUser,
} from './departments.js';

export type TextMatch =
  | { status: 'none' }
  | { status: 'match'; departmentId: string }
  | { status: 'create'; parentId: string; chain: string[] }
  | { status: 'ambiguous'; candidates: string[] };

const nameMatches = (d: DepartmentLite, n: string) =>
  normalizeDepartmentName(d.name) === n || (!!d.shortName && normalizeDepartmentName(d.shortName) === n);

/** Ключ группировки: тот же текст в любом написании даёт один ключ. */
export function departmentTextKey(text: unknown): string {
  return splitDepartmentPath(text).map(normalizeDepartmentName).join('/');
}

/**
 * Что значит текст для справочника. Одно слово ищется по всему дереву, «Город / Отдел» —
 * по цепочке от корня; чего нет — предлагается создать (под `defaultParentId` для одного слова).
 */
export function resolveDepartmentText(text: unknown, list: DepartmentLite[], defaultParentId?: string): TextMatch {
  const parts = splitDepartmentPath(text);
  if (!parts.length) return { status: 'none' };
  const live = list.filter((d) => !d.archivedAt);
  const root = live.find((d) => d.kind === 'company' && !d.parentId);
  if (!root) return { status: 'none' };
  const labelOf = (d: DepartmentLite): string => {
    const names: string[] = [];
    for (let cur: DepartmentLite | undefined = d, guard = 0; cur && cur.kind !== 'company' && guard < 20; cur = live.find((x) => x.id === cur!.parentId), guard++) names.unshift(cur.name);
    return names.join(' / ') || d.name;
  };
  if (parts.length === 1) {
    const n = normalizeDepartmentName(parts[0]);
    const found = live.filter((d) => nameMatches(d, n));
    if (found.length === 1) return { status: 'match', departmentId: found[0].id };
    if (found.length > 1) return { status: 'ambiguous', candidates: found.map(labelOf) };
    return { status: 'create', parentId: defaultParentId || root.id, chain: parts };
  }
  let cur: DepartmentLite = root;
  for (let i = 0; i < parts.length; i++) {
    const n = normalizeDepartmentName(parts[i]);
    const kids = live.filter((d) => d.parentId === cur.id && nameMatches(d, n));
    if (kids.length === 1) { cur = kids[0]; continue; }
    if (kids.length > 1) return { status: 'ambiguous', candidates: kids.map(labelOf) };
    return { status: 'create', parentId: cur.id, chain: parts.slice(i) };
  }
  return { status: 'match', departmentId: cur.id };
}

/** Создаёт недостающую цепочку под родителем и возвращает последний узел. Созданное дописывает в `list` и `created`. */
export async function createChain(
  tx: any, list: DepartmentLite[], parentId: string, chain: string[], actorId: string, created: BatchCreated[],
): Promise<string> {
  let parent = list.find((d) => d.id === parentId);
  if (!parent) throw new DepartmentError(404, 'Родительское подразделение не найдено');
  for (const [i, name] of chain.entries()) {
    const n = normalizeDepartmentName(name);
    const again = list.find((d) => d.parentId === parent!.id && !d.archivedAt && normalizeDepartmentName(d.name) === n);
    if (again) { parent = again; continue; }
    // Одно слово прямо под компанией чаще отдел, чем город; город — только если за ним идёт отдел («Город / Отдел»)
    const kind = parent.kind === 'company' && i === chain.length - 1 ? 'division' : defaultKindFor(parent.kind);
    if (!canNest(parent.kind, kind)) throw new DepartmentError(400, 'Здесь нельзя создать вложенное подразделение');
    const siblings = list.filter((d) => d.parentId === parent!.id);
    const row = await tx.department.create({ data: {
      name, kind, parentId: parent.id, city: kind === 'branch' ? name : null,
      sortOrder: siblings.reduce((m, d) => Math.max(m, d.sortOrder ?? 0), 0) + 1, createdBy: actorId,
    } });
    list.push(row);
    created.push({ id: row.id, name: row.name, parentId: row.parentId });
    parent = row;
  }
  return parent.id;
}

// ── Мастер «Разложить сотрудников по подразделениям» ───────────────────────

export interface LegacyGroup {
  key: string;
  text: string;
  count: number;
  names: string[];
  match: TextMatch;
}

/** План: по каждому уникальному тексту — сколько людей и что с ним сделать. Ничего не пишет. */
export async function planLegacy(db: any, defaultParentId?: string): Promise<{ groups: LegacyGroup[]; withoutText: number }> {
  const root = await ensureRootDepartment(db);
  const list = await listDepartments(db);
  const users = await db.user.findMany({ where: { departmentId: null, role: { not: 'SERVICE' } }, select: { id: true, name: true, department: true }, orderBy: { name: 'asc' } });
  const groups = new Map<string, LegacyGroup>();
  let withoutText = 0;
  for (const u of users as any[]) {
    const text = String(u.department || '').trim();
    const key = departmentTextKey(text);
    if (!key) { withoutText++; continue; }
    const g = groups.get(key) || { key, text, count: 0, names: [], match: resolveDepartmentText(text, list, defaultParentId || root.id) };
    g.count++;
    if (g.names.length < 5) g.names.push(u.name);
    groups.set(key, g);
  }
  return { groups: [...groups.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ru')), withoutText };
}

export interface LegacyChoice {
  key: string;
  action: 'create' | 'map' | 'skip';
  /** Для «map»: в какое существующее подразделение положить */
  departmentId?: string;
  /** Для «create»: под каким родителем создать (по умолчанию — корень) */
  parentId?: string;
  /** Для «create»: своё название вместо текста */
  name?: string;
}

/**
 * Применение: пересчитывает людей по базе (а не по списку клиента), создаёт
 * недостающие подразделения и раскладывает — одной транзакцией, с историей и снимком для отката.
 */
export async function applyLegacy(prisma: any, actor: { id: string; role: string }, choices: LegacyChoice[]) {
  const root = await ensureRootDepartment(prisma);
  const token = newUndoToken();
  const result = await prisma.$transaction(async (tx: any) => {
    const list: DepartmentLite[] = await listDepartments(tx);
    const created: BatchCreated[] = [];
    const users: BatchUser[] = [];
    const todo = new Map(choices.filter((c) => c.action !== 'skip').map((c) => [c.key, c]));
    const candidates = await tx.user.findMany({ where: { departmentId: null, role: { not: 'SERVICE' } }, select: { id: true, name: true, role: true, department: true } });
    const target = new Map<string, string>();
    for (const u of candidates as any[]) {
      const key = departmentTextKey(u.department);
      const choice = key ? todo.get(key) : undefined;
      if (!choice) continue;
      if ((u.role === 'OWNER' || u.role === 'ADMIN') && actor.role !== 'OWNER') continue; // как при переводе: администраторов раскладывает владелец
      let id = target.get(key);
      if (!id) {
        if (choice.action === 'map') {
          const dept = list.find((d) => d.id === choice.departmentId);
          if (!dept || dept.archivedAt) throw new DepartmentError(400, `Для «${u.department}» выбрано несуществующее или архивное подразделение`);
          id = dept.id;
        } else {
          const text = choice.name ? String(choice.name) : String(u.department);
          const match = resolveDepartmentText(text, list, choice.parentId || root.id);
          if (match.status === 'ambiguous') throw new DepartmentError(409, `«${u.department}» подходит нескольким подразделениям: ${match.candidates.join('; ')}. Выберите нужное.`);
          id = match.status === 'match' ? match.departmentId
            : match.status === 'create' ? await createChain(tx, list, match.parentId, match.chain, actor.id, created)
            : undefined;
        }
        if (id) target.set(key, id);
      }
      if (!id) continue;
      const done = await tx.user.updateMany({ where: { id: u.id, departmentId: null }, data: { departmentId: id } });
      if (done.count !== 1) throw new DepartmentError(409, 'Состав сотрудников изменился. Повторите предпросмотр.');
      users.push({ id: u.id, from: null, to: id });
    }
    if (users.length) {
      await tx.userDepartmentHistory.createMany({ data: historyRows(users, actor.id, token, 'Перенос из текстового поля «Подразделение»') });
    }
    if (users.length || created.length) await saveBatch(tx, token, { kind: 'legacy', actorId: actor.id, users, created, archived: [] });
    return { assigned: users.length, created: created.length };
  }, { maxWait: 10000, timeout: 60000 });
  return { ...result, undoToken: result.assigned || result.created ? token : null };
}
