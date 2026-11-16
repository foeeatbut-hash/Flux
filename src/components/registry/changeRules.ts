/**
 * Правила «что изменилось» для тега: какие поля записи видит человек.
 *
 * Тег на экране и `current` из отказа устроены одинаково (строка базы с полем
 * `metadata` — JSON-строка), но экран хранит в том же объекте и свой кэш разбора
 * (`parsedMetadata`, `__procMeta`) с позицией на доске. Поэтому правила читают
 * только `metadata`, а служебное (x, y, `_noPos`, кто и когда правил) в перечень
 * не входит: раскладку сервер версией не сверяет, а «правил такой-то» шумело бы
 * на каждой правке.
 *
 * Имена вместо идентификаторов (связи, родитель, поля справочника, этапы)
 * подставляет `TagNames` — его собирает экран из того, что у него загружено.
 */
import { changesBetween, type ChangeRule, type FieldChange } from '../../lib/recordChanges';

/** Как назвать то, что в записи лежит идентификатором; нет имени — остаётся сам идентификатор */
export interface TagNames {
  tag?: (id: string) => string | undefined;
  /** Дополнительное поле справочника тегов: по id или по прежнему имени */
  field?: (key: string) => string | undefined;
  /** Этап закупки */
  stage?: (id: string) => string | undefined;
  template?: (id: string) => string | undefined;
}

/** Метаданные тега объектом: из строки базы, а при её отсутствии — из разобранного вида */
export function metaOf(record: any): Record<string, any> {
  const raw = record?.metadata ?? record?.parsedMetadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

const STATUS_TEXT: Record<string, string> = {
  actual: 'актуально', warning: 'проверить', critical: 'критично', info: 'в работе', draft: 'устарело',
};

const text = (v: unknown): string => String(v ?? '').trim();

/** Замечания тега — по строке на каждое: «Замечание «текст»» → «статус — комментарий» */
export function descriptionRows(record: any): Array<{ label: string; value: unknown }> {
  const list: any[] = Array.isArray(metaOf(record).descriptions) ? metaOf(record).descriptions : [];
  return list.filter((d) => d && typeof d === 'object').map((d) => ({
    label: `Замечание «${text(d.text)}»`,
    value: [STATUS_TEXT[d.status] || text(d.status), text(d.comment)].filter(Boolean).join(' — ') || 'есть',
  }));
}

export function tagRules(names: TagNames = {}, shown?: any): ChangeRule[] {
  const tagName = (id: string) => names.tag?.(id) || id;
  // Оборудование экран держит вместе с тегом, а отказ присылает голую запись: имя берётся у показанной
  const equipmentName = (r: any): string => {
    const id = text(r?.equipmentId);
    if (!id) return '';
    const e = shown?.equipment;
    return e && e.id === id ? text(e.description || e.type) || id : id;
  };
  return [
    { label: 'Код тега', value: (r) => r.identifier },
    { label: 'Наименование', value: (r) => metaOf(r).mainName },
    { label: 'Марка', value: (r) => r.brand },
    { label: 'Отдел', value: (r) => r.department },
    { label: 'WBS', value: (r) => r.wbs },
    { label: 'Среда', value: (r) => r.fluid },
    { label: 'Оборудование', value: equipmentName },
    { label: 'Родитель', value: (r) => { const p = text(metaOf(r).parentId); return p ? tagName(p) : ''; } },
    {
      label: 'Связи',
      rows: (r) => (Array.isArray(metaOf(r).connections) ? metaOf(r).connections as string[] : []).map((id) => ({ label: `Связь с ${tagName(String(id))}`, value: 'есть' })),
    },
    { label: 'Замечания', rows: descriptionRows },
    {
      label: 'Дополнительные поля',
      rows: (r) => {
        const f = metaOf(r).dynamicFields;
        return f && typeof f === 'object' ? Object.entries(f as Record<string, unknown>).map(([k, v]) => ({ label: names.field?.(k) || k, value: v })) : [];
      },
    },
    { label: 'Этап закупки', value: (r) => { const s = text(metaOf(r).procurement?.stage); return s ? names.stage?.(s) || s : ''; } },
    { label: 'Шаблон этапов', value: (r) => { const t = text(metaOf(r).procurement?.templateId); return t ? names.template?.(t) || t : ''; } },
    { label: 'Поставщик', value: (r) => metaOf(r).procurement?.supplier },
    { label: 'Количество', value: (r) => metaOf(r).procurement?.qty },
    { label: 'Примечание к закупке', value: (r) => metaOf(r).procurement?.note },
  ];
}

/** Перечень изменений тега; `shown` — копия, какой её видел экран в момент правки, `current` — запись из отказа. */
export function tagChanges(shown: any, current: any, names: TagNames = {}): FieldChange[] {
  return changesBetween(shown, current, tagRules(names, shown));
}
