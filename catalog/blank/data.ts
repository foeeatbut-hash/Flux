/**
 * Данные для бланка: ведомость, разложенная по листам.
 *
 * Всё, что в бланках E06 набиралось руками или формулой `=A11`, считается
 * здесь один раз: номер строки б/з (`255000475-1-КОМ`), теги приводов из тегов
 * клапана (DF → DFD), характеристики листа из Каталога, признаки «есть привод»,
 * «есть обогрев», «взрывозащита» — по ним шаблон решает, какие блоки показать.
 */
import type { Catalog, Family, ValveValues, SpecDefault, Text2 } from '../model';
import { factsOfConfig, withDefaults, num } from '../model';
import { evalCond, areaOf } from '../rules';
import { buildDesignation } from '../designation';
import { tagRuleOf, derivedTag, tagTypeOf } from '../tags';
import { type SelectionItemData, type ListHeader, type IssueInfo, DEFAULT_ORDER_LINE, groupKeyOf } from '../selection';
import type { Scope } from './expr';
import type { SheetRepeat } from './model';

export interface GroupData extends Scope {
  key: string;
  family: Record<string, unknown>;
  exec: string;
  execSuffix: string;
  orderNo: string;
  items: Scope[];
  actuators: Scope[];
  heating: Scope[];
  spec: Record<string, { label: Text2; value: Text2; unit: string }>;
  hasActuators: boolean;
  hasHeating: boolean;
  isEx: boolean;
  qtyTotal: number;
}

export interface BlankData {
  root: Scope;
  groups: GroupData[];
}

export interface BlankInput {
  catalog: Catalog;
  header: ListHeader;
  items: SelectionItemData[];
  /** Номера бланк-заказов по листам: ключ группы → номер */
  orderNos?: Record<string, string>;
  issue?: IssueInfo;
  revisions?: IssueInfo[];
  project?: { name?: string; code?: string };
  sizeSep?: string;
}

const MANUAL = new Set(['manual', 'none']);

/** Значение характеристики с учётом выбранных кодов */
export function specValue(f: Family, s: SpecDefault, values: ValveValues): Text2 {
  const vals = withDefaults(f, values);
  for (const c of s.cases || []) if (evalCond(f, c.when, vals)) return c.value;
  return s.value;
}

/** Марка привода для таблицы приводов: из обозначения или заданная руками */
function driveModelOf(f: Family, values: ValveValues, manual?: string): string {
  if (manual) return manual;
  const v = withDefaults(f, values);
  const code = String(v.drive ?? '');
  if (!code || code === 'РУЧКА') return '';
  return `${String(v.driveEx ?? '')}${code}${String(v.driveExK ?? '')}`;
}

function sizeText(values: ValveValues, sep: string): string {
  if (num(values.D)) return `Ø${num(values.D)}`;
  if (num(values.W) || num(values.H)) return `${num(values.W)}${sep}${num(values.H)}`;
  return '';
}

export function buildBlankData(input: BlankInput, repeat: SheetRepeat = 'family'): BlankData {
  const { catalog } = input;
  const famById = new Map(catalog.families.map((f) => [f.id, f]));
  const mfById = new Map(catalog.manufacturers.map((m) => [m.id, m]));
  const byExec = repeat === 'family-exec';
  const sep = input.sizeSep ?? 'х';
  const pattern = input.header.orderLinePattern || DEFAULT_ORDER_LINE;

  const items = [...input.items].sort((a, b) => a.sort - b.sort);
  const groups = new Map<string, GroupData>();
  for (const it of items) {
    const f = it.familyId ? famById.get(it.familyId) : undefined;
    const values = f ? withDefaults(f, it.values) : it.values;
    const exec = String(values.exec ?? '');
    const key = repeat === 'none' ? 'all' : groupKeyOf(it.familyId, exec, byExec);
    let g = groups.get(key);
    if (!g) {
      const mf = f ? mfById.get(f.manufacturerId) : undefined;
      g = {
        key,
        family: f
          ? { id: f.id, code: f.code, title: f.title, typeLabel: f.typeLabel, manufacturer: mf?.name || '', standard: mf?.standard || '' }
          : { id: '', code: 'Без семейства', title: { ru: 'Без семейства' }, typeLabel: { ru: '' }, manufacturer: '', standard: '' },
        exec,
        execSuffix: byExec && exec ? `-${exec}` : '',
        orderNo: input.orderNos?.[key] || '',
        items: [],
        actuators: [],
        heating: [],
        spec: {},
        hasActuators: false,
        hasHeating: false,
        isEx: false,
        qtyTotal: 0,
      };
      groups.set(key, g);
    }
    const n = g.items.length + 1;
    const orderLine = it.orderLine || (g.orderNo ? pattern.replace('{orderNo}', g.orderNo).replace('{n}', String(n)) : '');
    const facts = f ? factsOfConfig(f, values) : {};
    const designation = it.designation || (f ? buildDesignation(f, values, { sizeSep: sep }).text : '');
    const hasDrive = !!f && !!values.drive && !MANUAL.has(String(facts.actuator ?? '')) && String(values.drive) !== 'РУЧКА';
    const rule = it.tags[0] ? tagRuleOf(catalog.tagRules, it.tags[0]) : undefined;
    const actTags = it.actuator?.tags?.length
      ? it.actuator.tags
      : it.tags.map((t) => derivedTag(t, tagTypeOf(t), rule?.actuatorCode)).filter(Boolean);
    const row: Scope = {
      id: it.id,
      n,
      tags: it.tags,
      tagsText: it.tags.join(' '),
      qty: it.qty,
      designation,
      W: num(values.W) || '-',
      H: num(values.H) || '-',
      D: num(values.D) || '-',
      size: sizeText(values, sep),
      area: areaOf(values),
      orderLine,
      notes: it.notes || '',
      values,
      facts,
      drive: driveModelOf(f as Family, values, it.actuator?.model),
      driveCount: num(values.driveCount) || it.actuator?.count || (hasDrive ? 1 : 0),
      actuatorTags: actTags,
      boxTags: it.actuator?.boxTags || [],
      boxModel: it.actuator?.boxModel || '',
      glands: it.actuator?.glands || '',
      heating: it.heating || {},
      source: it.sourceRef || {},
    };
    g.items.push(row);
    g.qtyTotal += it.qty;
    if (facts.ex) g.isEx = true;
    if (hasDrive) {
      g.hasActuators = true;
      g.actuators.push({ ...row, count: row.driveCount });
    }
    if (facts.heating || it.heating?.voltage) {
      g.hasHeating = true;
      g.heating.push(row);
    }
  }

  // Характеристики листа: у позиций одного листа они обычно одни, а если
  // разошлись (разное исполнение на одном листе) — перечисляем через «;»,
  // чтобы расхождение было видно, а не спрятано за первым значением
  for (const g of groups.values()) {
    const f = famById.get(String(g.family.id));
    if (!f) continue;
    for (const s of f.specs) {
      const seen: Text2[] = [];
      for (const row of g.items) {
        const v = specValue(f, s, row.values as ValveValues);
        if (!seen.some((x) => x.ru === v.ru)) seen.push(v);
      }
      const value: Text2 = seen.length <= 1
        ? seen[0] || s.value
        : { ru: seen.map((x) => x.ru).join('; '), en: seen.map((x) => x.en || x.ru).join('; ') };
      g.spec[s.key] = { label: s.label, value, unit: s.unit || '' };
    }
  }

  const list = [...groups.values()];
  const families = list.map((g) => ({ code: g.family.code, typeLabel: g.family.typeLabel, items: g.items.length, qty: g.qtyTotal, orderNo: g.orderNo }));
  const issue = input.issue || { rev: '', date: '', reason: '' };
  const root: Scope = {
    doc: { ...input.header, rev: issue.rev, issueDate: issue.date },
    issue,
    revisions: input.revisions || [],
    families,
    project: input.project || {},
    today: new Date().toISOString(),
    totals: { items: items.length, qty: items.reduce((a, b) => a + b.qty, 0), sheets: list.length },
  };
  return { root, groups: list };
}

/** Подпись поля для каталога полей конструктора бланков */
export const FIELD_CATALOG: Array<{ path: string; label: string; scope: 'doc' | 'group' | 'item' | 'actuator' }> = [
  { path: 'doc.docNo', label: 'Номер документа', scope: 'doc' },
  { path: 'doc.rev', label: 'Ревизия выпуска', scope: 'doc' },
  { path: 'doc.issueDate', label: 'Дата выпуска', scope: 'doc' },
  { path: 'doc.object', label: 'Объект', scope: 'doc' },
  { path: 'doc.subobject', label: 'Подобъект', scope: 'doc' },
  { path: 'doc.customer', label: 'Заказчик', scope: 'doc' },
  { path: 'doc.executor', label: 'Исполнитель', scope: 'doc' },
  { path: 'doc.date', label: 'Дата бланк-заказа', scope: 'doc' },
  { path: 'project.name', label: 'Проект', scope: 'doc' },
  { path: 'totals.qty', label: 'Всего штук', scope: 'doc' },
  { path: 'family.code', label: 'Семейство', scope: 'group' },
  { path: 'family.typeLabel', label: 'Тип (для бланка)', scope: 'group' },
  { path: 'family.manufacturer', label: 'Производитель', scope: 'group' },
  { path: 'orderNo', label: 'Номер бланк-заказа листа', scope: 'group' },
  { path: 'exec', label: 'Исполнение листа', scope: 'group' },
  { path: 'qtyTotal', label: 'Штук на листе', scope: 'group' },
  { path: 'spec.<ключ>.value', label: 'Характеристика из Каталога', scope: 'group' },
  { path: 'n', label: 'Номер строки', scope: 'item' },
  { path: 'orderLine', label: 'Номер строки б/з', scope: 'item' },
  { path: 'designation', label: 'Обозначение', scope: 'item' },
  { path: 'tags', label: 'Теги (список)', scope: 'item' },
  { path: 'qty', label: 'Количество', scope: 'item' },
  { path: 'W', label: 'Ширина', scope: 'item' },
  { path: 'H', label: 'Высота', scope: 'item' },
  { path: 'D', label: 'Диаметр', scope: 'item' },
  { path: 'size', label: 'Размер строкой', scope: 'item' },
  { path: 'area', label: 'Площадь сечения, м²', scope: 'item' },
  { path: 'notes', label: 'Примечание', scope: 'item' },
  { path: 'drive', label: 'Марка привода', scope: 'actuator' },
  { path: 'driveCount', label: 'Приводов на клапан', scope: 'actuator' },
  { path: 'actuatorTags', label: 'Теги приводов', scope: 'actuator' },
  { path: 'boxTags', label: 'Теги коробок', scope: 'actuator' },
  { path: 'boxModel', label: 'Маркировка коробки', scope: 'actuator' },
  { path: 'glands', label: 'Кабельные вводы', scope: 'actuator' },
];
