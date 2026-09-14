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
import { convert, parseNumericValue, unitInfo } from '../import/valueGrammar';

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
  // Внутренний адрес позиции: по нему видно, что четыре строки с разными
  // тегами — одна и та же конфигурация, а не четыре разных изделия, и что
  // один и тот же клапан, показанный в установке и в категории клапанов, —
  // одна позиция, а не две
  { key: 'instanceId', label: 'Код позиции в программе' },
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
 * Единица столбца и как к ней приводить.
 *
 * Столбец один, а бланки разные: тот же расход приходит и в м³/ч, и в м³/с.
 * Раньше заголовок брался у первого попавшегося, а числа выписывались как
 * есть — в столбце «Расход воздуха, м³/ч» стояли рядом 3600 и 1, и это одно
 * и то же значение. Теперь у столбца есть своя единица, и каждое значение
 * приводится к ней; что привести нельзя, названо ошибкой подготовки.
 */
export interface ParamColumn extends Column {
  /** Единица, в которой выписан весь столбец. Пустая — величина без единицы. */
  unit: string;
  group: string;
  param: string;
}

/** Столбец числовой, если его единица известна онтологии. */
const convertible = (unit: string): boolean => !!unitInfo(unit);

/**
 * Столбцы характеристик собираются ПО ДАННЫМ, а не по словарю: в выгрузку
 * попадает то, что в проекте действительно есть. Порядок — как в карточке,
 * то есть в порядке появления, иначе один и тот же проект давал бы разные
 * таблицы при каждом открытии.
 *
 * Единицу столбца выбирает первое встреченное непустое значение. Выбор
 * произвольный, но объявленный: важно не какая именно, а что она одна на
 * столбец и что остальные к ней приводятся.
 */
export function equipmentColumns(items: ExchangeComponent[]): ParamColumn[] {
  const seen = new Map<string, ParamColumn>();
  for (const it of items) {
    for (const g of it.groups || []) {
      for (const p of g.params || []) {
        if (!p?.key) continue;
        const key = paramColumnKey(g.title, p.key);
        const existing = seen.get(key);
        if (existing) {
          // Столбец без единицы, а значение с единицей — единица у столбца
          // появляется: иначе первый пустой бланк обезличил бы весь столбец
          if (!existing.unit && p.unit) {
            existing.unit = p.unit;
            existing.label = headerLabel(p.key, p.unit);
          }
          continue;
        }
        seen.set(key, {
          key, label: headerLabel(p.key, p.unit), unit: String(p.unit || ''),
          group: g.title, param: p.key,
        });
      }
    }
  }
  return [...BASE_EQUIPMENT_COLUMNS.map(c => ({ ...c, unit: '', group: '', param: '' })), ...seen.values()];
}

/** Почему значение нельзя выписать в столбец. Пустая строка — можно. */
export interface ExchangeProblem {
  tag: string;
  column: string;
  value: string;
  from: string;
  to: string;
  why: string;
}

/** Значение и его единица так, как они лежат в карточке. */
function paramRaw(it: ExchangeComponent, group: string, key: string): { value: string; unit: string } {
  const manual = it.overrides?.[overrideKey(group, key)];
  for (const g of it.groups || []) {
    if (g.title !== group) continue;
    for (const p of g.params || []) {
      if (p.key !== key) continue;
      // Ручная правка сильнее импортированной, но единица остаётся от поля:
      // инженер правит число, а не размерность
      return { value: manual !== undefined && manual !== null ? String(manual) : String(p.value ?? ''), unit: String(p.unit || '') };
    }
  }
  return { value: manual !== undefined && manual !== null ? String(manual) : '', unit: '' };
}

/** Значение характеристики строкой — без приведения единиц. */
function paramValue(it: ExchangeComponent, group: string, key: string): string {
  return paramRaw(it, group, key).value;
}

/**
 * Число в единицах столбца.
 *
 * `null` — значение в столбец не ложится: либо это не число, либо единица
 * другой размерности. Второе — настоящая ошибка, и молчать о ней нельзя:
 * именно так «1 м³/с» выписывалось единицей в столбец кубометров в час.
 */
function inColumnUnit(
  raw: { value: string; unit: string }, columnUnit: string,
): { text: string; problem?: string } {
  const text = raw.value;
  if (!text) return { text: '' };
  // Столбец без объявленной единицы или величина без единицы — выписываем как есть
  if (!columnUnit || !convertible(columnUnit)) return { text };
  const from = raw.unit || columnUnit;
  if (!convertible(from)) return { text };
  const parsed = parseNumericValue(text);
  // Диапазоны, списки и допуски не притворяются одним числом: их переводом
  // можно только испортить, поэтому они идут как есть и помечаются
  if (!parsed.ok || parsed.kind !== 'single') {
    const same = unitInfo(from)!.dim === unitInfo(columnUnit)!.dim;
    return same && from === columnUnit
      ? { text }
      : { text, problem: 'значение не одно число — перевести нельзя' };
  }
  const converted = convert(parsed.value, from, columnUnit);
  if (converted === null) {
    return { text, problem: `${from} и ${columnUnit} — разные величины` };
  }
  // Хвост нулей не нужен: 3600 остаётся 3600, а не 3600.0000000000005
  const rounded = Math.round(converted * 1e9) / 1e9;
  return { text: String(rounded) };
}

/** Значение одной ячейки. Пустое поле — пустая строка, а не «undefined» */
export function equipmentCell(it: ExchangeComponent, key: string, columnUnit = ''): string {
  if (key.startsWith('param:')) {
    const rest = key.slice('param:'.length);
    const bar = rest.indexOf('|');
    if (bar < 0) return '';
    const raw = paramRaw(it, rest.slice(0, bar), rest.slice(bar + 1));
    return inColumnUnit(raw, columnUnit).text;
  }
  switch (key) {
    // Один тег в строке: тегов у изделия бывает несколько, но каждый из них
    // адресует СВОЮ позицию проекта. Перечисление через запятую в одной ячейке
    // означало бы, что четыре вентилятора — это один вентилятор
    case 'tag': return (it.tags || [])[0]?.identifier || '';
    case 'instanceId': return String(it.id || '');
    case 'system': return String(it.systemName || '');
    case 'monoblock': return String(it.monoblockName || '');
    case 'itemCode': return String(it.itemCode || '');
    case 'name': return String(it.name || '');
    case 'equipType': return String(it.equipType || '');
    default: return '';
  }
}

/**
 * Развернуть позиции по тегам.
 *
 * Одна физическая позиция с четырьмя тегами — четыре строки выгрузки и четыре
 * адреса в проекте, но один `instanceId`: по нему видно, что техническая
 * конфигурация у них общая. Позиция без тега остаётся одной строкой с пустой
 * ячейкой тега — своего адреса у неё нет, и подставлять туда тег родителя
 * нельзя: это сделало бы её неотличимой от родителя в реестре.
 */
export function byTag(items: ExchangeComponent[]): ExchangeComponent[] {
  const out: ExchangeComponent[] = [];
  for (const it of items || []) {
    const tags = it.tags || [];
    if (tags.length <= 1) { out.push(it); continue; }
    for (const t of tags) out.push({ ...it, tags: [t] });
  }
  return out;
}

/**
 * Таблица для выгрузки: заголовки в том порядке, в каком выбраны столбцы.
 *
 * Вместе с таблицей возвращается список того, что не удалось привести к
 * единице столбца. Пустой список — выгрузка сходится; непустой показывается
 * человеку до записи файла, а не обнаруживается потом в чужой смете.
 */
export function buildEquipmentExchange(items: ExchangeComponent[], cols: Column[]): {
  headers: string[]; rows: string[][]; problems: ExchangeProblem[];
} {
  const rows: string[][] = [];
  const problems: ExchangeProblem[] = [];
  const expanded = byTag(items || []);
  for (const it of expanded) {
    const row: string[] = [];
    for (const c of cols) {
      const unit = (c as ParamColumn).unit || '';
      if (c.key.startsWith('param:')) {
        const rest = c.key.slice('param:'.length);
        const bar = rest.indexOf('|');
        const raw = bar < 0 ? { value: '', unit: '' } : paramRaw(it, rest.slice(0, bar), rest.slice(bar + 1));
        const cell = inColumnUnit(raw, unit);
        if (cell.problem) {
          problems.push({
            tag: (it.tags || [])[0]?.identifier || it.itemCode || it.name || '',
            column: c.label, value: raw.value, from: raw.unit, to: unit, why: cell.problem,
          });
        }
        row.push(cell.text);
      } else {
        row.push(equipmentCell(it, c.key, unit));
      }
    }
    rows.push(row);
  }
  return { headers: cols.map(c => c.label), rows, problems };
}
