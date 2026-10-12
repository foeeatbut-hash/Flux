import type { OfficePart } from './officeModel';

/** Знак «=» задаёт формулу, а не попадает в текст результата заполнения. */
export function normalizeOfficeFormulaParts(input: OfficePart[]): { parts: OfficePart[]; explicit: boolean } {
  const first = input.findIndex((part) => part.kind !== 'text' || !!part.text.trim());
  const initial = input[first];
  if (initial?.kind !== 'text' || !initial.text.trimStart().startsWith('=')) return { parts: input, explicit: false };
  const parts: OfficePart[] = [];
  for (const [index, part] of input.entries()) {
    if (part.kind !== 'text') { parts.push(part); continue; }
    let text = index === first ? part.text.trimStart().slice(1) : part.text;
    text = text.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-');
    // Пробелы и размерность после числа остаются текстом, а не новой операцией.
    const expression = /^[\s\d.,+*/()\-]*/.exec(text)?.[0] || '';
    for (const token of expression.match(/(?:\d+(?:[.,]\d*)?|[.,]\d+)|[+*/()\-]/g) || []) {
      parts.push(/^[+*/()\-]$/.test(token) ? { kind: 'operator', operator: token as Extract<OfficePart, {kind:'operator'}>['operator'] } : { kind: 'text', text: token });
    }
    const tail = text.slice(expression.length);
    if (tail) parts.push({ kind: 'text', text: tail });
  }
  return { parts, explicit: true };
}
