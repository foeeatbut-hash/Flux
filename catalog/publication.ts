/** Договор редакторского пространства; полнота данных не является статусом публикации. */
import type { Catalog } from './model';
export type CatalogEntity = 'family' | 'component' | 'tagRule' | 'class' | 'manufacturer';
export type CatalogAction = 'edit' | 'import' | 'publish';
export interface CatalogGrant { userId: string; action: CatalogAction; classId?: string; manufacturerId?: string }
export interface CatalogDraft {
  entity: CatalogEntity; id: string; operation: 'save' | 'archive'; document: any;
  before?: any; reviewedById?: string;
  baseHash: string; revision: string; state: 'draft' | 'review';
  authorId: string; updatedAt: string;
}
export interface CatalogWorkspace {
  catalog: Catalog; drafts: CatalogDraft[];
  policy?: { requireSecondReview: boolean };
  rights: Record<CatalogAction, boolean>; grants: CatalogGrant[];
}
export const CATALOG_LISTS: Record<CatalogEntity, keyof Catalog> = {
  family: 'families', component: 'components', tagRule: 'tagRules', class: 'classes', manufacturer: 'manufacturers',
};
/** JSON импорт не исполняет выражения и не допускает ключи изменения прототипа. */
export function catalogDocumentProblem(entity: CatalogEntity, d: any): string {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'Ожидалась запись каталога';
  let count = 0;
  const walk = (v: any, depth: number): boolean => {
    if (++count > 60000 || depth > 30) return false;
    if (!v || typeof v !== 'object') return typeof v !== 'number' || Number.isFinite(v);
    return Object.entries(v).every(([k, x]) => !['__proto__', 'prototype', 'constructor'].includes(k) && walk(x, depth + 1));
  };
  if (!walk(d, 0) || JSON.stringify(d).length > 2_000_000) return 'Слишком большая или некорректная запись';
  if (d.sections !== undefined && (!Array.isArray(d.sections) || d.sections.some((s: any) => !s?.id || typeof s.title !== 'string' || typeof s.text !== 'string' || !s.source || typeof s.source.file !== 'string' || !['description','dimensions','selection','marking','installation','wiring','general'].includes(s.kind)))) return 'Повреждено содержание справочника';
  if (!/^[\w\-:.]{1,160}$/.test(String(d.id || ''))) return 'Некорректный идентификатор записи';
  if (entity === 'class' && (!d.title?.ru || !d.itemName?.ru || !Array.isArray(d.facts))) return 'У вида оборудования нужны название, имя позиции и список характеристик';
  if (entity === 'component' && (!d.title?.ru || (d.specs && (!Array.isArray(d.specs) || d.specs.some((s: any) => !s.label?.ru || typeof s.value !== 'string'))))) return 'Характеристики компонента повреждены';
  if (entity === 'manufacturer') return String(d.name || '').trim() ? '' : 'Нет названия изготовителя';
  if (!String(d.code || '').trim()) return 'Нет кода записи';
  if (entity !== 'class' && !d.classId) return 'Не указан вид оборудования';
  if (entity === 'family') {
    if (!d.title?.ru || !d.typeLabel?.ru || typeof d.kind !== 'string' || !Array.isArray(d.shapes) || d.shapes.some((s: any) => !['rect', 'round'].includes(s)) || !d.match || !Array.isArray(d.match.kinds) || !['full','partial','draft'].includes(d.status)) return 'Повреждены основные поля модели';
    if (!d.manufacturerId) return 'Не указан изготовитель';
    if (!Array.isArray(d.params) || !Array.isArray(d.positions) || !Array.isArray(d.specs) || !Array.isArray(d.rules)) return 'Параметры, позиции, правила и характеристики должны быть массивами';
    if (d.documents !== undefined && (!Array.isArray(d.documents) || d.documents.some((r: any) => !r?.id || typeof r.file !== 'string' || typeof r.label !== 'string' || !['manual','image','drawing','curve'].includes(r.kind)))) return 'Повреждён список документов';
    if (d.tables !== undefined && !Array.isArray(d.tables)) return 'Таблицы должны быть массивом';
    if (d.params.some((p: any) => !p || !['choice','number','text'].includes(p.kind) || !p.label?.ru || (p.values && (!Array.isArray(p.values) || p.values.some((v: any) => typeof v.code !== 'string' || !v.label?.ru))))) return 'Повреждены определения параметров';
    if (d.specs.some((s: any) => !s || !s.key || !s.label?.ru || typeof s.value?.ru !== 'string' || (s.cases && !Array.isArray(s.cases)))) return 'Повреждены характеристики модели';
    if (d.rules.some((r: any) => !r?.id || !r.then || typeof r.message !== 'string')) return 'Повреждены правила модели';

    if ((!d.designationMode || d.designationMode === 'structured') && !d.positions.length) return 'У структурированного обозначения нет позиций';
    if (d.designationSeparator !== undefined && (typeof d.designationSeparator !== 'string' || !d.designationSeparator.length || d.designationSeparator.length > 4)) return 'Разделитель обозначения должен содержать 1–4 символа';
    if (d.params.length > 200 || d.positions.length > 100 || d.positions.some((p: any) => !Array.isArray(p.formats) || !p.formats.length || p.formats.length > 12 || p.formats.some((f: any) => typeof f !== 'string' || f.length > 4096))) return 'Слишком большая или повреждённая схема обозначения';
    if (d.designationSeparator !== undefined && !d.designationSeparator.trim()) return 'Разделитель не может состоять только из пробелов';
    const keys = d.params.map((p: any) => p.key);
    if (new Set(keys).size !== keys.length || keys.some((k: any) => !/^[a-zA-Z0-9_]{1,80}$/.test(k))) return 'Ключи параметров должны быть уникальными';
    for (const table of d.tables || []) {
      if (!table.id || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return 'Таблица повреждена';
      if (table.columns.some((c: any) => !c || !/^[a-zA-Z0-9_]{1,80}$/.test(c.key) || typeof c.label !== 'string' || !['input','output'].includes(c.role))) return 'Некорректное определение колонки';
      if (new Set(table.rows.map((r: any) => r.id)).size !== table.rows.length) return 'В таблице повторяются ключи строк';
      if (new Set(table.columns.map((c: any) => c.key)).size !== table.columns.length) return 'В таблице повторяются колонки';
      if (table.rows.some((r: any) => !r.id || typeof r.verified !== 'boolean' || !r.values || Object.values(r.values).some(v => v !== null && !['string', 'number'].includes(typeof v)))) return 'В таблице некорректные значения';
    }
  }
  return '';
}
export function overlayCatalog(catalog: Catalog, drafts: CatalogDraft[]): Catalog {
  const out = Object.fromEntries(Object.entries(catalog).filter(([key]) => Object.values(CATALOG_LISTS).includes(key as keyof Catalog)).map(([k, rows]) => [k, [...rows as any[]]])) as unknown as Catalog;
  for (const draft of drafts) {
    const key = CATALOG_LISTS[draft.entity];
    out[key] = out[key].filter((r: any) => r.id !== draft.id) as any;
    if (draft.operation === 'save') (out[key] as any[]).push({ ...draft.document, _draftVersion: draft.revision });
  }
  return out;
}
