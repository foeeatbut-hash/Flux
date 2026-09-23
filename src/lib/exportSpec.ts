/**
 * Выгрузка оборудования по шаблону: что выгружать, какими столбцами и в каком
 * порядке.
 *
 * Прежний шаблон вида помнил только набор характеристик: без отбора по типу,
 * без столбцов тега, без порядка, — и «собрать» было отдельным шагом. Владелец
 * просил выгрузку «удобнее, продуманнее». Здесь шаблон — это целый ответ:
 *
 *   — ЧТО: типы и виды оборудования (пусто — все), «только с тегом»;
 *   — СТОЛБЦЫ: служебные (тег, тег родителя, тип, вид, модель…) и
 *     характеристики, в своём порядке и со своими заголовками;
 *   — ПОРЯДОК: по тегу, «тип → тег» с заголовками групп, «установка → тег».
 *
 * Тот же шаблон раскладывается в Таблице Flux Office (`toLayout`): отбор,
 * столбцы и порядок становятся разметкой листа, и «Собрать» потом обновляет
 * значения. Старый шаблон (только поля) читается как новый (`specOf`).
 *
 * Правила — здесь и проверяются scripts/test-export-builder.ts.
 */

import { buildEquipmentExchange, byTag, paramColumnKey, type ExchangeComponent, type ParamColumn } from './equipmentExchange';
import { classById, classOrder, isClassId } from '../../equipment/classes';
import { compareTags } from '../../equipment/notes';
import type { TableLayout } from './tableLayout';

export type ExportOrder = 'tag' | 'class-tag' | 'unit-tag';

export interface ExportColumn { key: string; label: string; unit?: string }

export interface ExportSpec {
  v: 2;
  /** Типы оборудования; пусто — все */
  classes: string[];
  /** Виды; пусто — все */
  kinds: string[];
  taggedOnly: boolean;
  columns: ExportColumn[];
  order: ExportOrder;
  /** Строка-заголовок перед каждой группой типа («Приводы») */
  groupHeaders: boolean;
}

/** Служебные столбцы — они есть у любой позиции, в отличие от характеристик */
export const SERVICE_COLUMNS: ExportColumn[] = [
  { key: 'tag', label: 'Тег' },
  { key: 'parentTag', label: 'Тег родителя' },
  { key: 'unitTag', label: 'Тег установки' },
  { key: 'name', label: 'Наименование' },
  { key: 'class', label: 'Тип' },
  { key: 'kind', label: 'Вид' },
  { key: 'model', label: 'Модель' },
  { key: 'system', label: 'Установка' },
  { key: 'monoblock', label: 'Моноблок' },
  { key: 'itemCode', label: 'Код позиции' },
  { key: 'origin', label: 'Откуда' },
];

export const ORDER_TITLE: Record<ExportOrder, string> = {
  'tag': 'по тегу', 'class-tag': 'тип → тег', 'unit-tag': 'установка → тег',
};

const service = (key: string) => SERVICE_COLUMNS.find((c) => c.key === key)!;

export const defaultSpec = (): ExportSpec => ({
  v: 2, classes: [], kinds: [], taggedOnly: false,
  columns: ['tag', 'name', 'class', 'kind', 'model', 'parentTag'].map((k) => ({ ...service(k) })),
  order: 'class-tag', groupHeaders: true,
});

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.map(String).map((s) => s.trim()).filter(Boolean) : []);

/**
 * Разобрать сохранённый шаблон.
 *
 * Шаблон первой версии — только характеристики и роль. Он не теряется:
 * становится шаблоном второй с тегом и тегом родителя впереди (владелец так и
 * просил — «первый столбец теги, дальше данные и тег родителя») и отбором по
 * типу роли.
 */
export function specOf(raw: unknown, v1?: { role?: string; fields?: { group: string; key: string; unit?: string }[] }): ExportSpec {
  let r: any = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { r = null; } }
  if (r && r.v === 2) {
    const columns = (Array.isArray(r.columns) ? r.columns : [])
      .map((c: any) => ({ key: String(c?.key || ''), label: String(c?.label || '').trim(), unit: String(c?.unit || '') }))
      .filter((c: ExportColumn) => c.key && (c.key.startsWith('param:') || SERVICE_COLUMNS.some((s) => s.key === c.key)))
      .map((c: ExportColumn) => ({ ...c, label: c.label || service(c.key)?.label || c.key.split('|').pop() || c.key }));
    return {
      v: 2,
      classes: strings(r.classes).filter(isClassId),
      kinds: strings(r.kinds),
      taggedOnly: !!r.taggedOnly,
      columns: columns.length ? columns : defaultSpec().columns,
      order: r.order === 'tag' || r.order === 'unit-tag' ? r.order : 'class-tag',
      groupHeaders: r.groupHeaders !== false,
    };
  }
  const fields = v1?.fields || [];
  const role = String(v1?.role || '');
  return {
    ...defaultSpec(),
    classes: isClassId(role) ? [role] : [],
    columns: [
      service('tag'), service('parentTag'), service('name'),
      ...fields.map((f) => ({ key: paramColumnKey(f.group, f.key), label: f.key, unit: f.unit || '' })),
    ],
  };
}

/** Строки с одним тегом каждая, отобранные по шаблону */
export function selectItems(items: ExchangeComponent[], spec: ExportSpec): ExchangeComponent[] {
  const cls = new Set(spec.classes);
  const kinds = new Set(spec.kinds);
  return byTag(items || []).filter((it) => {
    if (cls.size && !cls.has(String(it.cls || ''))) return false;
    if (kinds.size && !kinds.has(String(it.kind || ''))) return false;
    if (spec.taggedOnly && !(it.tags || [])[0]?.identifier) return false;
    return true;
  });
}

const tagOf = (it: ExchangeComponent) => (it.tags || [])[0]?.identifier || '';
const byTagFirst = (a: ExchangeComponent, b: ExchangeComponent) => {
  const at = tagOf(a); const bt = tagOf(b);
  if (at && bt) return compareTags(at, bt);
  if (at) return -1;
  if (bt) return 1;
  return (a.sourceOrder || 0) - (b.sourceOrder || 0);
};

export function orderItems(items: ExchangeComponent[], order: ExportOrder): ExchangeComponent[] {
  return [...items].sort((a, b) => {
    if (order === 'class-tag') {
      const c = classOrder(String(a.cls || 'ПРОЧЕЕ')) - classOrder(String(b.cls || 'ПРОЧЕЕ'));
      if (c) return c;
    }
    if (order === 'unit-tag') {
      const u = compareTags(a.systemName || '', b.systemName || '');
      if (u) return u;
    }
    return byTagFirst(a, b);
  });
}

/** Столбцы шаблона → столбцы выгрузки: у характеристики своя единица */
function asColumns(spec: ExportSpec, known: ParamColumn[]): ParamColumn[] {
  return spec.columns.map((c) => {
    const k = known.find((x) => x.key === c.key);
    return { key: c.key, label: c.label, unit: c.unit ?? k?.unit ?? '', group: k?.group || '', param: k?.param || '' };
  });
}

export interface ExportTable {
  headers: string[];
  rows: string[][];
  /** Номера строк-заголовков групп — предпросмотр рисует их иначе */
  groupRows: number[];
  problems: ReturnType<typeof buildEquipmentExchange>['problems'];
  count: number;
}

/**
 * Таблица по шаблону.
 *
 * Заголовок группы — строка с названием типа в первой ячейке и пустыми
 * остальными: так она читается и в Excel, и в буфере обмена, и не ломает
 * столбцы, если таблицу потом сортируют.
 */
export function exportTable(items: ExchangeComponent[], spec: ExportSpec, known: ParamColumn[] = []): ExportTable {
  const picked = orderItems(selectItems(items, spec), spec.order);
  const cols = asColumns(spec, known);
  const built = buildEquipmentExchange(picked, cols, { keepOrder: true });
  if (!(spec.groupHeaders && spec.order === 'class-tag') || !cols.length) {
    return { headers: built.headers, rows: built.rows, groupRows: [], problems: built.problems, count: picked.length };
  }
  const rows: string[][] = [];
  const groupRows: number[] = [];
  let last = '';
  picked.forEach((it, i) => {
    const cls = String(it.cls || 'ПРОЧЕЕ');
    if (cls !== last) {
      groupRows.push(rows.length);
      rows.push([classById(cls).plural, ...cols.slice(1).map(() => '')]);
      last = cls;
    }
    rows.push(built.rows[i]);
  });
  return { headers: built.headers, rows, groupRows, problems: built.problems, count: picked.length };
}

// Служебный столбец выгрузки → поле Таблицы. Внутреннего кода позиции в
// Таблице нет: связь листа с проектом держит ключ строки
const PATH: Record<string, string> = {
  tag: 'tag', parentTag: 'parentTag', unitTag: 'unitTag', name: 'name', class: 'classTitle', kind: 'kind',
  model: 'model', system: 'system.name', monoblock: 'monoblock.name', itemCode: 'itemCode', origin: 'origin',
  role: 'role', instanceNo: 'instanceNo',
};

/**
 * Шаблон → разметка листа Таблицы.
 *
 * Строка — позиция (а не тег): характеристики принадлежат позициям. Отбор и
 * порядок уходят в разметку, и «Собрать» на листе режет и сортирует строки
 * тем же правилом, что и выгрузка. Заголовков групп на листе нет: собранный
 * лист пишет строки подряд, а вставные заголовки съехали бы при обновлении.
 */
export function toLayout(spec: ExportSpec, headerRow = 0, fromCol = 0): TableLayout & { sort: { field: string }[] } {
  const columns = spec.columns
    .filter((c) => c.key.startsWith('param:') || PATH[c.key])
    .map((c, i) => ({
      path: c.key.startsWith('param:') ? c.key : PATH[c.key],
      title: c.label,
      unit: c.unit || '',
      col: fromCol + i,
    }));
  const filters: TableLayout['filters'] = [];
  if (spec.classes.length) filters.push({ field: 'class', op: 'in', value: spec.classes.join('|') });
  if (spec.kinds.length) filters.push({ field: 'kind', op: 'in', value: spec.kinds.join('|') });
  if (spec.taggedOnly) filters.push({ field: 'tag', op: 'nempty', value: '' });
  const sort = spec.order === 'class-tag' ? [{ field: 'class' }, { field: 'tag' }]
    : spec.order === 'unit-tag' ? [{ field: 'system.name' }, { field: 'tag' }] : [{ field: 'tag' }];
  return { grain: 'element', headerRow, columns, filters, sort };
}

// ── Быстрые наборы и характеристики по разделам ─────────────────────────────

/**
 * Готовые наборы столбцов — то, что выгружают чаще всего.
 *
 * Собирать «тег, тип, вид, модель» по одной галочке каждый раз — ровно та
 * возня, на которую жаловались. Набор заменяет служебные столбцы и оставляет
 * выбранные характеристики на месте: «теги с родителями» поверх «мощности и
 * тока» не должен стирать мощность и ток.
 */
export const PRESETS: { id: string; title: string; keys: string[] }[] = [
  { id: 'types', title: 'Теги и типы', keys: ['tag', 'class', 'kind', 'name'] },
  { id: 'tree', title: 'Теги с родителями', keys: ['tag', 'parentTag', 'unitTag', 'class', 'name'] },
  { id: 'buy', title: 'Для закупки', keys: ['tag', 'class', 'kind', 'model', 'name', 'system'] },
  { id: 'all', title: 'Все служебные', keys: SERVICE_COLUMNS.map((c) => c.key) },
];

export function applyPreset(spec: ExportSpec, id: string): ExportSpec {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return spec;
  const params = spec.columns.filter((c) => c.key.startsWith('param:'));
  return { ...spec, columns: [...preset.keys.map((k) => ({ ...service(k) })), ...params] };
}

export interface ParamSection {
  title: string;
  params: { key: string; label: string; unit: string; count: number }[];
}

/**
 * Характеристики по разделам карточки, с числом позиций, у которых значение
 * есть: «Номинальная мощность — у 12». Раздел добавляется в выгрузку целиком
 * одной кнопкой, а не двадцатью.
 */
export function paramSections(items: ExchangeComponent[], known: ParamColumn[]): ParamSection[] {
  const count = new Map<string, number>();
  for (const it of items) {
    const seen = new Set<string>();
    for (const g of it.groups || []) for (const p of g.params || []) {
      const k = paramColumnKey(g.title, p.key);
      if (seen.has(k) || !String(p.value ?? '').trim()) continue;
      seen.add(k);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  const out: ParamSection[] = [];
  for (const c of known) {
    let sec = out.find((s) => s.title === c.group);
    if (!sec) { sec = { title: c.group, params: [] }; out.push(sec); }
    sec.params.push({ key: c.key, label: c.param || c.label, unit: c.unit, count: count.get(c.key) || 0 });
  }
  return out;
}
