/**
 * Состав в карточке позиции: что внутри, во что входит и какие разделы
 * карточки на самом деле принадлежат вложенным позициям.
 *
 * Владелец прислал снимок: блок «Вентилятор ВСК» показывает разделы
 * «Вентилятор», «Электродвигатель», «Рабочая точка» — а тегов и двигателя в
 * нём нет; они у вентиляторов внутри, и те же данные стоят в их карточках.
 * Так устроена выгрузка САПР: блок-папка несёт отчёт по всему содержимому, и
 * разбор раздаёт разделы вложенным позициям, оставляя копию у блока. В
 * реестре это читается как «данные двоятся».
 *
 * Правило: у секции-корпуса (тип «Секция», equipment/classes) разделы, которые
 * есть у позиций внутри неё, не повторяются — вместо них карточка показывает
 * «Состав» с тегами, и по строке состава открывается позиция. У блока, который
 * сам есть изделие (фильтр, нагреватель с тегом), ничего не прячется: там
 * разделы — его собственные данные.
 *
 * Данные при этом не трогаются: копия у блока остаётся в базе, её видят
 * выгрузка и Таблица, повторный ввоз не находит расхождений. Меняется только
 * то, что человек видит в карточке.
 */

import type { Classified } from '../../equipment/classes';

export interface CompNode {
  id: string;
  itemCode: string;
  name: string;
  parentElementId?: string | null;
  tags?: { identifier: string }[];
  specs?: unknown;
}

export interface CompRow {
  id: string;
  label: string;
  tag: string;
  cls: string;
  kind: string;
  depth: number;
}

export interface CompositionView {
  parent: { id: string; label: string; tag: string } | null;
  /** Всё, что внутри, — деревом, по порядку тега */
  children: CompRow[];
  /** Разделы этой карточки, которые принадлежат позициям внутри */
  hiddenGroups: string[];
}

const tagOf = (n?: CompNode) => String((n?.tags || [])[0]?.identifier || '');

function groupTitles(specs: unknown): string[] {
  let s: any = specs;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { return []; } }
  return (Array.isArray(s?.groups) ? s.groups : []).map((g: any) => String(g?.title || '')).filter(Boolean);
}

/** Естественный порядок тега: 001A раньше 002A, B01-9 раньше B01-10 */
const natural = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });

export function compositionView(
  card: CompNode,
  nodes: CompNode[],
  types: Map<string, Classified>,
  labelOf: (n: CompNode) => string = (n) => n.name,
): CompositionView {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, CompNode[]>();
  for (const n of nodes) {
    if (!n.parentElementId || !byId.has(n.parentElementId)) continue;
    if (!kids.has(n.parentElementId)) kids.set(n.parentElementId, []);
    kids.get(n.parentElementId)!.push(n);
  }
  const order = (list: CompNode[]) => [...list].sort((a, b) => {
    const at = tagOf(a); const bt = tagOf(b);
    if (at && bt) return natural(at, bt);
    if (at) return -1;
    if (bt) return 1;
    return natural(labelOf(a), labelOf(b));
  });

  const children: CompRow[] = [];
  const seen = new Set<string>([card.id]);
  const walk = (id: string, depth: number) => {
    for (const c of order(kids.get(id) || [])) {
      if (seen.has(c.id)) continue;   // кольцо в данных не должно вешать карточку
      seen.add(c.id);
      const t = types.get(c.id);
      children.push({ id: c.id, label: labelOf(c), tag: tagOf(c), cls: t?.cls || 'ПРОЧЕЕ', kind: t?.kind || '', depth });
      walk(c.id, depth + 1);
    }
  };
  walk(card.id, 0);

  const p = card.parentElementId ? byId.get(card.parentElementId) : undefined;
  const parent = p ? { id: p.id, label: labelOf(p), tag: tagOf(p) } : null;

  let hiddenGroups: string[] = [];
  if (types.get(card.id)?.cls === 'СЕКЦИЯ' && children.length) {
    const inside = new Set(children.flatMap((c) => groupTitles(byId.get(c.id)?.specs)));
    hiddenGroups = groupTitles(card.specs).filter((g) => inside.has(g));
  }
  return { parent, children, hiddenGroups };
}
