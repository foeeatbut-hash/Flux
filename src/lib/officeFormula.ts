import type { OfficePart } from './officeModel';

const FORMULA_FN_RE = /^(?:SUM|AVG|AVERAGE|MIN|MAX|COUNT|CONCAT|СУММ|СРЗНАЧ|МИН|МАКС|СЧЁТ|СЧЕТ|СЦЕПИТЬ)$/iu;

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
    // Пробелы и размерность после числа остаются текстом, а не новой операцией; функции с «(» входят в выражение.
    // Запятая сразу после «)» — разделитель аргументов, а не начало дроби: «SUM(SUM(a,b),1)» не читается как «.1».
    const expression = /^(?:\s*(?:(?:SUM|AVG|AVERAGE|MIN|MAX|COUNT|CONCAT|СУММ|СРЗНАЧ|МИН|МАКС|СЧЁТ|СЧЕТ|СЦЕПИТЬ)(?=\s*\()|(?:\d+(?:[.,]\d*)?|(?<![\d)])[.,]\d+)|[+*/()\-,;]))*\s*/iu.exec(text)?.[0] || '';
    for (const token of expression.match(/(?:SUM|AVG|AVERAGE|MIN|MAX|COUNT|CONCAT|СУММ|СРЗНАЧ|МИН|МАКС|СЧЁТ|СЧЕТ|СЦЕПИТЬ)(?=\s*\()|(?:\d+(?:[.,]\d*)?|(?<![\d)])[.,]\d+)|[+*/()\-,;]/giu) || []) {
      if (FORMULA_FN_RE.test(token)) {
        parts.push({ kind: 'operator', operator: token.toUpperCase() as any });
      } else if (/^[+*/()\-,;]$/.test(token)) {
        parts.push({ kind: 'operator', operator: (token === ';' ? ',' : token) as any });
      } else {
        parts.push({ kind: 'text', text: token });
      }
    }
    const tail = text.slice(expression.length);
    if (tail) parts.push({ kind: 'text', text: tail });
  }
  return { parts, explicit: true };
}
