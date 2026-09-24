/**
 * Проверка ведомости перед выпуском и «что изменилось» между выпусками.
 *
 * Проверка ищет то, что в бланках E06 находил только заказчик: один тег в
 * двух строках, количество, не совпадающее с числом тегов, размер вне
 * каталога, позицию без семейства. Ошибка — выпуск с ней будет неверным;
 * предупреждение — стоит посмотреть.
 */
import type { Catalog, ValveValues } from './model';
import { withDefaults } from './model';
import type { SelectionItemData } from './selection';
import { checkConfig } from './rules';
import { buildDesignation, sameDesignation } from './designation';
import { duplicateTags } from './tags';

export interface ListProblem {
  level: 'error' | 'warning';
  itemId?: string;
  code: string;
  text: string;
}

export function checkList(catalog: Catalog, items: SelectionItemData[], opts: { requiredHeader?: string[]; header?: Record<string, string> } = {}): ListProblem[] {
  const out: ListProblem[] = [];
  const fam = new Map(catalog.families.map((f) => [f.id, f]));
  for (const [tag, ids] of duplicateTags(items)) {
    for (const id of new Set(ids)) out.push({ level: 'error', itemId: id, code: 'dup-tag', text: `Тег ${tag} стоит в нескольких позициях` });
  }
  for (const it of items) {
    if (!it.tags.length) out.push({ level: 'warning', itemId: it.id, code: 'no-tag', text: 'У позиции нет тега' });
    if (!(it.qty > 0)) out.push({ level: 'error', itemId: it.id, code: 'qty', text: 'Количество не задано' });
    else if (it.tags.length && it.qty !== it.tags.length) {
      out.push({ level: 'warning', itemId: it.id, code: 'qty-tags', text: `Количество ${it.qty}, а тегов ${it.tags.length}` });
    }
    const f = it.familyId ? fam.get(it.familyId) : undefined;
    if (!f) { out.push({ level: 'error', itemId: it.id, code: 'no-family', text: it.familyId ? 'Семейство удалено из Каталога' : 'Изделие не подобрано' }); continue; }
    for (const v of checkConfig(f, it.values)) {
      out.push({ level: v.level, itemId: it.id, code: `rule:${v.ruleId}`, text: `${f.code}: ${v.message}${v.source ? ` (${v.source})` : ''}` });
    }
    if (it.designationManual && it.designation) {
      const auto = buildDesignation(f, it.values).text;
      if (!sameDesignation(auto, it.designation)) {
        out.push({ level: 'warning', itemId: it.id, code: 'manual-designation', text: `Обозначение правлено руками и расходится с параметрами: ${auto}` });
      }
    }
    if (f.status !== 'full') out.push({ level: 'warning', itemId: it.id, code: 'family-partial', text: `${f.code}: данные семейства не сверены с каталогом полностью` });
  }
  for (const key of opts.requiredHeader || []) {
    if (!String(opts.header?.[key] ?? '').trim()) out.push({ level: 'warning', code: `header:${key}`, text: `Не заполнен реквизит «${key}»` });
  }
  return out;
}

// ── Что изменилось с прошлого выпуска ───────────────────────────────────────

export interface ItemDiff {
  added: SelectionItemData[];
  removed: SelectionItemData[];
  changed: Array<{ before: SelectionItemData; after: SelectionItemData; what: string[] }>;
}

const keyOf = (it: SelectionItemData) => [...it.tags].map((t) => t.toUpperCase()).sort().join(',') || `id:${it.id}`;

/**
 * Сравнение по тегам, как и импорт: позиция та же, если у неё те же теги.
 * Если теги у позиции поменялись, она сравнивается по id — иначе переименование
 * тега выглядело бы как «снята одна, добавлена другая».
 */
export function diffItems(catalog: Catalog, before: SelectionItemData[], after: SelectionItemData[]): ItemDiff {
  const fam = new Map(catalog.families.map((f) => [f.id, f]));
  const desig = (it: SelectionItemData) => {
    const f = it.familyId ? fam.get(it.familyId) : undefined;
    return it.designation || (f ? buildDesignation(f, it.values as ValveValues).text : '');
  };
  const prevByKey = new Map(before.map((it) => [keyOf(it), it]));
  const prevById = new Map(before.map((it) => [it.id, it]));
  const seen = new Set<string>();
  const out: ItemDiff = { added: [], removed: [], changed: [] };
  for (const it of after) {
    const prev = prevByKey.get(keyOf(it)) || prevById.get(it.id);
    if (!prev) { out.added.push(it); continue; }
    seen.add(prev.id);
    const what: string[] = [];
    if (keyOf(prev) !== keyOf(it)) what.push(`теги: ${prev.tags.join(', ')} → ${it.tags.join(', ')}`);
    if (prev.qty !== it.qty) what.push(`кол-во: ${prev.qty} → ${it.qty}`);
    const a = desig(prev);
    const b = desig(it);
    if (!sameDesignation(a, b)) what.push(`обозначение: ${a || '—'} → ${b || '—'}`);
    if (what.length) out.changed.push({ before: prev, after: it, what });
  }
  for (const it of before) if (!seen.has(it.id)) out.removed.push(it);
  return out;
}

/** Текст для графы «Описание изменения» — инженер правит его, а не пишет с нуля */
export function diffText(d: ItemDiff): string {
  const lines: string[] = [];
  const tags = (it: SelectionItemData) => it.tags.join(', ') || it.designation || it.id;
  if (d.added.length) lines.push(`Добавлены: ${d.added.map(tags).join('; ')}`);
  if (d.removed.length) lines.push(`Исключены: ${d.removed.map(tags).join('; ')}`);
  for (const c of d.changed) lines.push(`${tags(c.after)}: ${c.what.join('; ')}`);
  return lines.join('\n') || 'Без изменений позиций';
}

/** Значения по умолчанию, сведённые с заданными, — для сравнения «было/стало» */
export function effectiveValues(catalog: Catalog, it: SelectionItemData): ValveValues {
  const f = it.familyId ? catalog.families.find((x) => x.id === it.familyId) : undefined;
  return f ? withDefaults(f, it.values) : it.values;
}
