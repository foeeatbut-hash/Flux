import type { Catalog, Component } from './model';

/** Суффикс и разделитель исполнения значимы; буква O не становится нулём. */
export const modelCode = (v: unknown): string => String(v ?? '').trim().toUpperCase()
  .replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, '')
  .replace(/[АВЕКМНОРСТХ]/g, c => ({ А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X' }[c]!));
export const manufacturerKey = (v: unknown): string => String(v ?? '').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[«»"']/g, '').replace(/^ооо\s+/, '').replace(/\s+/g, ' ');
export const componentKey = (c: Pick<Component, 'code' | 'manufacturer' | 'kind'>): string => `${c.kind}|${manufacturerKey(c.manufacturer)}|${modelCode(c.code)}`;
export const componentsForClass = (catalog: Catalog, classId: string): Component[] => catalog.components.filter(c => c.classId === classId || c.classIds?.includes(classId));

/** Одно точное обозначение без изготовителя может быть неоднозначным. */
export function matchComponent(components: Component[], code: string, manufacturer?: string, kind?: string): Component[] {
  return components.filter(c => modelCode(c.code) === modelCode(code)
    && (!manufacturer || manufacturerKey(c.manufacturer) === manufacturerKey(manufacturer))
    && (!kind || c.kind === kind));
}
