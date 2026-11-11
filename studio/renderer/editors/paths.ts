/**
 * Соответствие путей в форме и выделения в редакторе: замечание «groups[0].fields[1].label»
 * принадлежит полю с выделением {field, g: 0, f: 1}.
 */
import type { JsonPath } from './jsonText';
import type { Selection } from './formModel';

export function selectionOfJsonPath(path: JsonPath): Selection {
  const [root, index, inner, sub] = path;
  if (root === 'groups' && typeof index === 'number') return inner === 'fields' && typeof sub === 'number' ? { kind: 'field', g: index, f: sub } : { kind: 'group', g: index };
  if (root === 'tables' && typeof index === 'number') return inner === 'columns' && typeof sub === 'number' ? { kind: 'column', t: index, c: sub } : { kind: 'table', t: index };
  return { kind: 'form' };
}

/** Путь вида `groups[0].fields[1].label` → массив частей */
export function parsePathString(path: string): JsonPath {
  return [...path.matchAll(/\[(\d+)\]|([A-Za-z_]\w*)/g)].map(match => match[1] !== undefined ? Number(match[1]) : match[2]);
}

export const sameSelection = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);
