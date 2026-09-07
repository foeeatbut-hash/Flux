/**
 * Что именно выгружается из раздела «Оборудование».
 *
 * Владелец просил дословно: «когда мы выгружаем к примеру расход воздуха
 * вентилятора „Тег“». До сих пор такой выгрузки не было вовсе — оборудование
 * доставали обходом, через Конструктор. Здесь строка таблицы — одна единица
 * оборудования, а столбцы — её характеристики; тег стоит первым, потому что
 * без него выгрузка не сходится с реестром.
 *
 * Отдельно от экрана по той же причине, что и у тегов: сборку строк можно
 * проверить скриптом, а экран — нет. Окно обмена (components/ExchangeDialog)
 * про оборудование не знает ничего.
 *
 * Соглашение о единице то же, что в Конструкторе и мастере данных: единица
 * стоит В ЗАГОЛОВКЕ столбца («Расход воздуха, м³/ч»), в ячейке — только число.
 * Иначе столбец нельзя ни сложить, ни отсортировать.
 */
import type { Column } from './exchange';

export interface ExchangeParam { key: string; value: string; unit: string }
export interface ExchangeGroup { title: string; params: ExchangeParam[] }
export interface ExchangeComponent {
  id: string;
  itemCode: string;
  name: string;
  equipType: string;
  /** Разобранные характеристики (нормализованные экраном) */
  groups: ExchangeGroup[];
  /** Ручные правки инженера: «группа||ключ» → значение */
  overrides?: Record<string, string>;
  tags?: { identifier: string }[];
  systemName: string;
  monoblockName: string;
}

/** Ключ ручной правки — тот же, что пишет карточка оборудования */
const overrideKey = (group: string, key: string) => `${group}||${key}`;

/** Ключ столбца характеристики: группа и ключ, разделённые вертикальной чертой */
export const paramColumnKey = (group: string, key: string) => `param:${group}|${key}`;

/** Постоянные столбцы: они есть у любой единицы оборудования */
export const BASE_EQUIPMENT_COLUMNS: Column[] = [
  { key: 'tag', label: 'Тег' },
  { key: 'system', label: 'Установка' },
  { key: 'monoblock', label: 'Моноблок' },
  { key: 'itemCode', label: 'Код позиции' },
  { key: 'name', label: 'Наименование' },
  { key: 'equipType', label: 'Тип' },
];

/**
 * Заголовок столбца характеристики. Подпись из бланка нередко уже несёт
 * единицу («Ширина В, мм») — второй раз её дописывать нельзя, иначе в шапке
 * оказывается «Ширина В, мм, мм».
 */
export function headerLabel(key: string, unit?: string): string {
  const name = String(key || '').trim();
  const u = String(unit || '').trim();
  if (!u) return name;
  const tail = name.split(',').pop()?.trim().toLowerCase() || '';
  const norm = (s: string) => s.replace(/³/g, '3').replace(/²/g, '2').replace(/[\s .]/g, '').toLowerCase();
  if (tail && norm(tail) === norm(u)) return name;
  return `${name}, ${u}`;
}

/**
 * Столбцы характеристик собираются ПО ДАННЫМ, а не по словарю: в выгрузку
 * попадает то, что в проекте действительно есть. Порядок — как в карточке,
 * то есть в порядке появления, иначе один и тот же проект давал бы разные
 * таблицы при каждом открытии.
 */
export function equipmentColumns(items: ExchangeComponent[]): Column[] {
  const seen = new Map<string, Column>();
  for (const it of items) {
    for (const g of it.groups || []) {
      for (const p of g.params || []) {
        if (!p?.key) continue;
        const key = paramColumnKey(g.title, p.key);
        if (seen.has(key)) continue;
        seen.set(key, { key, label: headerLabel(p.key, p.unit) });
      }
    }
  }
  return [...BASE_EQUIPMENT_COLUMNS, ...seen.values()];
}

/** Значение характеристики: ручная правка инженера сильнее импортированной */
function paramValue(it: ExchangeComponent, group: string, key: string): string {
  const manual = it.overrides?.[overrideKey(group, key)];
  if (manual !== undefined && manual !== null) return String(manual);
  for (const g of it.groups || []) {
    if (g.title !== group) continue;
    for (const p of g.params || []) if (p.key === key) return String(p.value ?? '');
  }
  return '';
}

/** Значение одной ячейки. Пустое поле — пустая строка, а не «undefined» */
export function equipmentCell(it: ExchangeComponent, key: string): string {
  if (key.startsWith('param:')) {
    const rest = key.slice('param:'.length);
    const bar = rest.indexOf('|');
    if (bar < 0) return '';
    return paramValue(it, rest.slice(0, bar), rest.slice(bar + 1));
  }
  switch (key) {
    // Тегов у изделия бывает несколько (один бланк на пять одинаковых) —
    // перечисляем все, чтобы строка сходилась с реестром в обе стороны
    case 'tag': return (it.tags || []).map(t => t.identifier).join(', ');
    case 'system': return String(it.systemName || '');
    case 'monoblock': return String(it.monoblockName || '');
    case 'itemCode': return String(it.itemCode || '');
    case 'name': return String(it.name || '');
    case 'equipType': return String(it.equipType || '');
    default: return '';
  }
}

/** Таблица для выгрузки: заголовки в том порядке, в каком выбраны столбцы */
export function buildEquipmentExchange(items: ExchangeComponent[], cols: Column[]): {
  headers: string[]; rows: string[][];
} {
  return {
    headers: cols.map(c => c.label),
    rows: (items || []).map(it => cols.map(c => equipmentCell(it, c.key))),
  };
}
