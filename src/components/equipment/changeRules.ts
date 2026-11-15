/**
 * Правила «что изменилось» для оборудования: какие поля записи видит человек.
 *
 * Запись в дереве экрана и `current` из отказа устроены немного по-разному:
 * - характеристики в дереве подменены каталогом, сырые лежат в `originalSpecs`;
 *   в `current` — сырая строка `specs`, поэтому читается `originalSpecs ?? specs`;
 * - теги в дереве — `{ id, identifier }`, в `current` — `{ id, code }`.
 * Правила читают оба вида одинаково. Поля, которых человек не видит (id,
 * даты, версия, служебные), сюда не входят — иначе перечень шумел бы.
 */
import { classTitle } from '../../../equipment/classes';
import { normalizeSpecs } from '../../lib/specs';
import { changesBetween, type ChangeRule, type FieldChange } from '../../lib/recordChanges';

export type EquipmentRecordKind = 'component' | 'monoblock' | 'system';

function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

/** Характеристики — по строке на каждую: «Группа · Ключ» → «значение единица». */
export function specRows(record: any): Array<{ label: string; value: unknown }> {
  const rows: Array<{ label: string; value: unknown }> = [];
  for (const group of normalizeSpecs(record?.originalSpecs ?? record?.specs).groups) {
    for (const p of group.params) {
      const value = [p?.value ?? '', p?.unit ?? ''].map((x) => String(x).trim()).filter(Boolean).join(' ');
      rows.push({ label: `${group.title} · ${p?.key ?? ''}`, value });
    }
  }
  return rows;
}

/** Ручные значения — по строке на каждое; ключ в базе — «группа||характеристика». */
export function overrideRows(record: any): Array<{ label: string; value: unknown }> {
  const raw = parseJson(record?.overrides);
  return Object.entries(raw).map(([key, value]) => ({ label: `${key.replace('||', ' · ')} (вручную)`, value }));
}

/** Теги позиции — по строке на каждый. */
export function tagRows(record: any): Array<{ label: string; value: unknown }> {
  const tags: any[] = Array.isArray(record?.tags) ? record.tags : [];
  return tags.map((t) => ({ label: `Тег ${t?.code ?? t?.identifier ?? ''}`, value: 'привязан' }));
}

/** Тип и вид — как их видит человек: «Вентилятор · Радиальный»; пусто — тип определяется сам. */
export function typeText(record: any): string {
  const cls = String(record?.equipClass ?? '').trim();
  const kind = String(record?.equipKind ?? '').trim();
  return [cls ? classTitle(cls) : '', kind].filter(Boolean).join(' · ');
}

export const COMPONENT_RULES: ChangeRule[] = [
  { label: 'Название', value: (r) => r.name },
  { label: 'Обозначение', value: (r) => r.itemCode },
  { label: 'Тип', value: typeText },
  { label: 'Состояние', value: (r) => r.status },
  { label: 'Номер экземпляра', value: (r) => r.instanceNo },
  { label: 'Количество', value: (r) => r.instanceCount },
  { label: 'Характеристики', rows: specRows },
  { label: 'Ручные значения', rows: overrideRows },
  { label: 'Теги', rows: tagRows },
];
export const MONOBLOCK_RULES: ChangeRule[] = [
  { label: 'Название', value: (r) => r.name },
];
export const SYSTEM_RULES: ChangeRule[] = [
  { label: 'Название', value: (r) => r.name },
  { label: 'Категория', value: (r) => r.category },
  { label: 'Файл', value: (r) => r.fileName },
];

export const RULES: Record<EquipmentRecordKind, ChangeRule[]> = {
  component: COMPONENT_RULES, monoblock: MONOBLOCK_RULES, system: SYSTEM_RULES,
};

/** Перечень изменений записи оборудования; `shown` — из дерева экрана, `current` — из отказа. */
export function equipmentChanges(kind: EquipmentRecordKind, shown: unknown, current: unknown): FieldChange[] {
  return changesBetween(shown, current, RULES[kind]);
}
