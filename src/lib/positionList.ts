/**
 * Позиции списком: строка — позиция, группы — по типу оборудования.
 *
 * Владелец просил: «каждый тег — это отдельная позиция… сделать сортировку по
 * типам оборудования каждой позиции с тегом или без». Дерево отвечает на
 * вопрос «что внутри чего», а список — на «покажи мне все приводы проекта с
 * их тегами». Это разные вопросы, и одним видом на оба не ответить.
 *
 * Правила здесь, а не в компоненте: что считать строкой, как сравнивать теги
 * и что делать с позицией без тега — проверяется скриптом
 * (scripts/test-position-list.ts), а не глазами.
 */

import { compositionOf } from '../../equipment/composition';
import { compareTags } from '../../equipment/notes';
import { classById, classOrder, type ClassId, type Classified } from '../../equipment/classes';

export interface ListComponent {
  id: string; itemCode: string; name: string; equipType?: string;
  tags?: { id?: string; identifier: string }[];
  role?: string; parentElementId?: string | null;
  sourceOrder?: number | null; manual?: boolean; sourceKind?: string | null;
}
export interface ListSystem { id: string; name: string; monoblocks: { name: string; components: ListComponent[] }[] }

export type Origin = 'calc' | 'note' | 'manual';
export const ORIGIN_TITLE: Record<Origin, string> = { calc: 'из расчёта', note: 'по примечанию', manual: 'вручную' };

export interface ListRow {
  id: string;
  tag: string;
  cls: ClassId;
  kind: string;
  label: string;
  parentTag: string;
  unitId: string;
  unitName: string;
  origin: Origin;
  order: number;
}

/** Служебные строки называются словами: код `__unit__` человеку ничего не скажет */
export const rowLabel = (c: { itemCode: string; name: string }): string =>
  c.itemCode === '__unit__' ? 'Параметры установки'
    : c.itemCode.endsWith('_общие') ? 'Общие параметры моноблока' : c.name;

const originOf = (c: ListComponent): Origin => (c.manual ? 'manual' : c.sourceKind === 'note' ? 'note' : 'calc');

/**
 * Строки проекта.
 *
 * Позиция с несколькими тегами — несколько строк: каждый тег адресует свою
 * позицию на объекте, и список, где четыре вентилятора сложены в одну строку,
 * врал бы о количестве. Позиция без тега — одна строка с пустым тегом.
 */
export function positionRows(systems: ListSystem[], types: Map<string, Classified>): ListRow[] {
  const out: ListRow[] = [];
  for (const sys of systems || []) {
    const all = (sys.monoblocks || []).flatMap((m) => m.components || []);
    const { parentTagOf } = compositionOf(all as any, sys.name);
    for (const c of all) {
      const t = types.get(c.id);
      const base = {
        id: c.id, cls: (t?.cls || 'ПРОЧЕЕ') as ClassId, kind: t?.kind || '',
        // Установку в списке называет её имя: две строки «Параметры установки» не различить
        label: c.itemCode === '__unit__' ? sys.name : rowLabel(c),
        parentTag: parentTagOf(c as any), unitId: sys.id, unitName: sys.name, origin: originOf(c),
        order: Number(c.sourceOrder) || 0,
      };
      const tags = (c.tags || []).map((x) => x.identifier).filter(Boolean);
      if (!tags.length) out.push({ ...base, tag: '' });
      for (const tag of tags) out.push({ ...base, tag });
    }
  }
  return out;
}

/** Тегированные по алфавиту тега, безтеговые после — в порядке файла */
export function byTag(a: ListRow, b: ListRow): number {
  if (a.tag && b.tag) return compareTags(a.tag, b.tag);
  if (a.tag) return -1;
  if (b.tag) return 1;
  return a.order - b.order || a.label.localeCompare(b.label, 'ru');
}

export interface ListFilter {
  /** Пусто — все типы */
  classes?: string[];
  tagged?: 'all' | 'with' | 'without';
  q?: string;
}

export function filterRows(rows: ListRow[], f: ListFilter): ListRow[] {
  const want = new Set(f.classes || []);
  const q = String(f.q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (want.size && !want.has(r.cls)) return false;
    if (f.tagged === 'with' && !r.tag) return false;
    if (f.tagged === 'without' && r.tag) return false;
    if (!q) return true;
    return [r.tag, r.label, r.kind, r.parentTag, r.unitName, classById(r.cls).title]
      .some((v) => v.toLowerCase().includes(q));
  });
}

/** Сколько строк каждого типа — для чипов отбора; порядок справочника */
export function classCounts(rows: ListRow[]): { cls: ClassId; count: number; tagged: number }[] {
  const m = new Map<ClassId, { count: number; tagged: number }>();
  for (const r of rows) {
    const x = m.get(r.cls) || { count: 0, tagged: 0 };
    x.count++;
    if (r.tag) x.tagged++;
    m.set(r.cls, x);
  }
  return [...m.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0]))
    .map(([cls, x]) => ({ cls, ...x }));
}

export type GroupBy = 'class' | 'unit' | 'none';

export interface RowGroup { key: string; title: string; rows: ListRow[] }

/**
 * Группы списка.
 *
 * По типу — в порядке справочника (установки, секции, вентиляторы…), внутри —
 * по тегу. По установке — по имени установки. Без группировки — одна группа
 * без заголовка, строки по тегу.
 */
export function groupRows(rows: ListRow[], by: GroupBy): RowGroup[] {
  if (by === 'none') return [{ key: '', title: '', rows: [...rows].sort(byTag) }];
  const m = new Map<string, ListRow[]>();
  for (const r of rows) {
    const k = by === 'class' ? r.cls : r.unitId;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  const groups = [...m.entries()].map(([key, list]) => ({
    key,
    title: by === 'class' ? classById(key).plural : list[0].unitName,
    rows: list.sort(byTag),
  }));
  return by === 'class'
    ? groups.sort((a, b) => classOrder(a.key) - classOrder(b.key))
    : groups.sort((a, b) => compareTags(a.title, b.title));
}
