import { normalizeSpecs } from './projectSlice.js';

/** Единицы только из исходных specs/алиаса, а не из догадок по значению. */
export function resolveOfficeUnit(fieldKey: string, element: any, aliases: Array<{ name: string; unit?: string }>): string | undefined {
  if (fieldKey.startsWith('param:@')) {
    const name = fieldKey.slice('param:@'.length);
    return aliases.find((alias) => alias.name === name)?.unit || undefined;
  }
  if (!fieldKey.startsWith('param:')) return undefined;
  const splitAt = fieldKey.indexOf('|', 'param:'.length);
  if (splitAt < 0) return undefined;
  const group = fieldKey.slice('param:'.length, splitAt), key = fieldKey.slice(splitAt + 1);
  const parameter = element && normalizeSpecs(element.specs).groups
    .find((item) => item.title === group)?.params.find((item) => item.key === key);
  return parameter?.unit || undefined;
}
