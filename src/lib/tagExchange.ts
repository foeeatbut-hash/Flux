/**
 * Что именно выгружается из раздела «Теги».
 *
 * Отдельно от экрана по двум причинам. Раздел «Теги» — самый большой файл в
 * программе, и складывать в него ещё и сборку таблицы значит растить его
 * дальше. И вторая: сборку строк можно проверить скриптом, а экран — нет.
 *
 * Само окно обмена (components/ExchangeDialog) про теги не знает ничего: оно
 * спрашивает «что, куда, какие столбцы» и зовёт вот эту сборку. Так же к нему
 * подключаются остальные разделы.
 */
import type { Column } from './exchange';

/** Столбцы, которые умеет отдавать раздел «Теги» */
export const TAG_EXCHANGE_COLUMNS: Column[] = [
  { key: 'id', label: 'ID тега' },
  { key: 'identifier', label: 'Код тега' },
  { key: 'mainName', label: 'Наименование' },
  { key: 'actuality', label: 'Актуальность' },
  { key: 'brand', label: 'Марка' },
  { key: 'department', label: 'Отдел' },
  { key: 'wbs', label: 'WBS' },
  { key: 'fluid', label: 'Среда' },
  { key: 'projectId', label: 'ID проекта' },
  { key: 'equipmentId', label: 'ID оборудования' },
  { key: 'createdAt', label: 'Создан' },
  { key: 'updatedAt', label: 'Изменён' },
  { key: 'chain', label: 'Цепочка' },
  { key: 'descriptions', label: 'Замечания' },
  { key: 'metadata', label: 'Метаданные целиком' },
];

const BUILT_IN_META_KEYS = new Set([
  'x', 'y', '_noPos', 'connections', 'descriptions', 'dynamicFields',
  'mainName', 'parentId', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt',
  'tagSegments', 'markSegments',
]);

function metadataOf(tag: any): Record<string, any> {
  const raw = tag?.metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }
  return tag?.parsedMetadata && typeof tag.parsedMetadata === 'object' ? tag.parsedMetadata : {};
}

/** Дополнительные поля берутся из всего набора тегов, чтобы в меню не пропадали поля, пустые у части тегов. */
export function tagExchangeColumns(tags: any[]): Column[] {
  const rootKeys = new Set<string>();
  const dynamicKeys = new Set<string>();
  for (const tag of tags || []) {
    const meta = metadataOf(tag);
    Object.keys(meta).filter((key) => !BUILT_IN_META_KEYS.has(key)).forEach((key) => rootKeys.add(key));
    const dynamic = meta.dynamicFields;
    if (dynamic && typeof dynamic === 'object' && !Array.isArray(dynamic)) {
      Object.keys(dynamic).forEach((key) => dynamicKeys.add(key));
    }
  }
  const sorted = (keys: Set<string>) => [...keys].sort((a, b) => a.localeCompare(b, 'ru'));
  return [
    ...TAG_EXCHANGE_COLUMNS,
    ...sorted(rootKeys).map((key) => ({ key: `meta:${key}`, label: `Метаданные · ${key}` })),
    ...sorted(dynamicKeys).map((key) => ({ key: `dynamic:${key}`, label: key })),
  ];
}

const cellValue = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};

export interface TagExchangeHelpers {
  /** Цепочка родителей — её знает экран, здесь она приходит работой */
  lineage: (id: string) => string;
  /** Разбор замечаний из поля метаданных тега */
  meta: (tag: any) => { descriptions: { text: string; status: string; comment: string }[] };
  status: (tag: any) => string;
}

const ACTUALITY_LABEL: Record<string, string> = {
  actual: 'Актуально', warning: 'Проверить', critical: 'Критично', info: 'В работе', draft: 'Устарело',
};
const dateCell = (value: unknown): string => {
  if (!value) return '';
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

/** Значение одной ячейки. Пустое поле — пустая строка, а не «undefined» */
export function tagCell(tag: any, key: string, h: TagExchangeHelpers): string {
  switch (key) {
    case 'id': return String(tag?.id || '');
    case 'identifier': return String(tag?.identifier || '');
    case 'mainName': return String(metadataOf(tag).mainName || '');
    case 'actuality': {
      const status = h.status(tag);
      return ACTUALITY_LABEL[status] || status;
    }
    case 'brand': return String(tag?.brand || '');
    case 'department': return String(tag?.department || '');
    case 'wbs': return String(tag?.wbs || '');
    case 'fluid': return String(tag?.fluid || '');
    case 'projectId': return String(tag?.projectId || '');
    case 'equipmentId': return String(tag?.equipmentId || '');
    case 'createdAt': return dateCell(tag?.createdAt);
    case 'updatedAt': return dateCell(tag?.updatedAt);
    case 'chain': return String(h.lineage(tag?.id) || tag?.identifier || '');
    case 'descriptions': {
      const list = h.meta(tag)?.descriptions || [];
      return list
        .map((d) => `${d.text} [${String(d.status).toUpperCase()}]: ${d.comment}`)
        .join(' | ');
    }
    case 'metadata': return cellValue(metadataOf(tag));
    default:
      if (key.startsWith('meta:')) return cellValue(metadataOf(tag)[key.slice(5)]);
      if (key.startsWith('dynamic:')) return cellValue(metadataOf(tag).dynamicFields?.[key.slice(8)]);
      return '';
  }
}

/** Таблица для выгрузки: заголовки в том порядке, в каком выбраны столбцы */
export function buildTagExchange(tags: any[], cols: Column[], h: TagExchangeHelpers): {
  headers: string[]; rows: string[][];
} {
  return {
    headers: cols.map((c) => c.label),
    rows: (tags || []).map((t) => cols.map((c) => tagCell(t, c.key, h))),
  };
}

/** Какие столбцы включены в подборе по сегментам */
export interface SegmentColumns {
  identifier?: boolean; brand?: boolean; brandParts?: boolean; parts?: boolean;
  department?: boolean; fluid?: boolean; chain?: boolean; descriptions?: boolean;
}

export interface SegmentHelpers extends TagExchangeHelpers {
  /** Сколько сегментов в самом длинном коде и в самой длинной марке */
  segments: number;
  brandSegments: number;
  splitTag: (code: string) => string[];
  splitBrand: (brand: string) => string[];
}

/**
 * Таблица подбора по сегментам: код разбит на части, и каждая часть — столбец.
 *
 * Число столбцов зависит от данных: сегментов столько, сколько их в самом
 * длинном коде проекта. Поэтому заголовки и строки собираются в одном месте —
 * разойдись они на два, таблица поехала бы на один столбец, и заметили бы это
 * не сразу, а в Excel у заказчика.
 */
export function buildSegmentTable(tags: any[], on: SegmentColumns, h: SegmentHelpers): {
  headers: string[]; rows: string[][];
} {
  const headers: string[] = [];
  if (on.identifier) headers.push('Код тега (Tag)');
  if (on.brand) headers.push('Марка');
  if (on.brandParts) for (let i = 0; i < h.brandSegments; i++) headers.push(`Сегмент Марки ${i + 1}`);
  if (on.parts) for (let i = 0; i < h.segments; i++) headers.push(`Сегмент ${i + 1}`);
  if (on.department) headers.push('Дисциплина / Отдел');
  if (on.fluid) headers.push('Тех. Среда / Назначение');
  if (on.chain) headers.push('Инженерная Цепочка (Parent Chain)');
  if (on.descriptions) headers.push('Комментарии');

  const rows = (tags || []).map((t) => {
    const row: string[] = [];
    if (on.identifier) row.push(String(t.identifier || ''));
    if (on.brand) row.push(String(t.brand || ''));
    if (on.brandParts) {
      const bp = h.splitBrand(t.brand || '');
      for (let i = 0; i < h.brandSegments; i++) row.push(bp[i] || '');
    }
    if (on.parts) {
      const parts = h.splitTag(t.identifier || '');
      for (let i = 0; i < h.segments; i++) row.push(parts[i] || '');
    }
    if (on.department) row.push(String(t.department || ''));
    if (on.fluid) row.push(String(t.fluid || ''));
    if (on.chain) row.push(String(h.lineage(t.id) || t.identifier || ''));
    if (on.descriptions) {
      const list = h.meta(t)?.descriptions || [];
      const text = list.map((d) => `${d.text} [${String(d.status).toUpperCase()}]: ${d.comment}`).join(' | ');
      row.push(text || 'Нет замечаний');
    }
    return row;
  });

  return { headers, rows };
}
