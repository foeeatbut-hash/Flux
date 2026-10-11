/**
 * Данные проекта для Flux Office: выборка оборудования/тегов/менеджмента/E3
 * через адресные запросы к серверу. Единый контракт: fieldKey, sourceId,
 * entityId, entityType, displayName, value, unit (ТЗ Flux Office §9).
 */
import { ENV_CONFIG } from '../../config/env';

export type FluxSource = 'equipment' | 'tags' | 'management' | 'e3';

export interface FluxField {
  key: string;
  label: string;
  source: FluxSource;
  kind: 'text' | 'number';
  unit?: string;
}

export interface FluxRow {
  entityId: string;
  tag: string;
  name: string;
  type: string;
  systemName: string;
  values: Record<string, string | number | null>;
}

export interface FluxDataSet {
  rows: FluxRow[];
  fields: FluxField[];
  total: number;
}

export const FLUX_FIELDS: FluxField[] = [
  { key: 'tag', label: 'Тег', source: 'tags', kind: 'text' },
  { key: 'name', label: 'Наименование', source: 'tags', kind: 'text' },
  { key: 'type', label: 'Тип', source: 'equipment', kind: 'text' },
  { key: 'system', label: 'Система', source: 'equipment', kind: 'text' },
  { key: 'model', label: 'Модель', source: 'equipment', kind: 'text' },
  { key: 'airflow', label: 'Расход воздуха', source: 'equipment', kind: 'number', unit: 'м³/ч' },
  { key: 'pressure', label: 'Давление', source: 'equipment', kind: 'number', unit: 'Па' },
  { key: 'power', label: 'Мощность', source: 'equipment', kind: 'number', unit: 'кВт' },
  { key: 'stage', label: 'Этап закупки', source: 'management', kind: 'text' },
  { key: 'supplier', label: 'Поставщик', source: 'management', kind: 'text' },
  { key: 'quantity', label: 'Количество', source: 'management', kind: 'number' },
  { key: 'signal', label: 'Тип сигнала', source: 'e3', kind: 'text' },
  { key: 'channel', label: 'Канал I/O', source: 'e3', kind: 'text' },
];

/** Загрузка выборки оборудования проекта с характеристиками */
export async function fetchProjectData(
  projectId: string,
  opts: { type?: string; untagged?: boolean; search?: string } = {},
): Promise<FluxDataSet> {
  const qs = new URLSearchParams();
  if (opts.type) qs.set('type', opts.type);
  if (opts.untagged) qs.set('untagged', '1');
  if (opts.search) qs.set('q', opts.search);
  const res = await fetch(`${ENV_CONFIG.apiUrl}/guide/project/${encodeURIComponent(projectId)}/components?${qs}&limit=200`);
  if (!res.ok) throw new Error(`Не удалось загрузить оборудование: ${res.status}`);
  const data = await res.json() as { items: Array<Record<string, any>>; total: number };

  const rows: FluxRow[] = data.items.map((c: any) => {
    const values: Record<string, string | number | null> = {};
    for (const s of c.specs || []) {
      const key = s.key.toLowerCase().replace(/\s/g, '_');
      values[key] = toNumberOrText(s.value, s.unit);
      // Алиасы для стандартных полей
      if (/расход/i.test(s.key)) values['airflow'] = toNumberOrText(s.value, s.unit);
      if (/давление/i.test(s.key) && !values['pressure']) values['pressure'] = toNumberOrText(s.value, s.unit);
      if (/мощност/i.test(s.key)) values['power'] = toNumberOrText(s.value, s.unit);
    }
    return {
      entityId: c.id,
      tag: c.tags?.[0] || '',
      name: c.name,
      type: c.equipType,
      systemName: c.systemName,
      values,
    };
  });

  return { rows, fields: FLUX_FIELDS, total: data.total };
}

function toNumberOrText(value: string, unit: string): string | number | null {
  if (!value || value === '—' || value === '-') return null;
  const n = Number(value.replace(',', '.').replace(/[^\d.\-+eE]/g, ''));
  if (Number.isFinite(n) && n !== 0) return n;
  return value + (unit ? ' ' + unit : '');
}

/** Арифметика между метками полей (ТЗ Flux Office §7) */
export function evaluateArithmetic(ops: string[], values: (number | null)[]): { value: string; error?: string } {
  const nums = values.map((v) => (typeof v === 'number' ? v : null));
  if (nums.some((v) => v === null)) return { value: '—', error: 'Нет числового параметра у одной из позиций' };
  const n = nums as number[];
  const o = [...ops];
  // Умножение/деление
  for (let i = 0; i < o.length;) {
    if (o[i] === '×' || o[i] === '÷' || o[i] === '*' || o[i] === '/') {
      if ((o[i] === '÷' || o[i] === '/') && n[i + 1] === 0) return { value: 'Ошибка', error: 'Деление на ноль' };
      n.splice(i, 2, (o[i] === '×' || o[i] === '*') ? n[i] * n[i + 1] : n[i] / n[i + 1]);
      o.splice(i, 1);
    } else i++;
  }
  // Сложение/вычитание
  let total = n[0];
  for (let i = 0; i < o.length; i++) total += (o[i] === '+' ? n[i + 1] : -n[i + 1]);
  return { value: String(Number(total.toFixed(4))) };
}
