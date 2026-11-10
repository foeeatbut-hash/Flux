/**
 * Выписка из методологии дизайна для редакторов Studio.
 *
 * Редактор формы показывает у каждого компонента «когда применять» и пример, а проверка
 * оформления ссылается на правила разделов 1, 5, 6 и 8 из docs/methodology/01-design.md. Тексты
 * берутся из документа при сборке, а не набираются руками: иначе методология и редактор
 * разойдутся. Запуск: npx tsx scripts/gen-studio-editor-methodology.ts
 * Тест scripts/test-studio-editor.ts сверяет файл с документом и падает, если они расходятся.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MethodologyExtract } from '../studio/renderer/editors/methodologyTypes';

const root = path.resolve(__dirname, '..');
export const SOURCE = 'docs/methodology/01-design.md';
export const TARGET = path.join(root, 'studio/renderer/editors/methodology.generated.ts');

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(clean);

/** Пункты и абзацы блока: продолжение пункта с отступом склеивается с ним */
function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let current: string | null = null;
  const flush = () => { if (current !== null) out.push(clean(current)); current = null; };
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    if (line.trim().startsWith('|') || line.startsWith('```')) { flush(); continue; }
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(?:\[[ x]\]\s+)?(.*)$/.exec(line);
    if (bullet) { flush(); current = bullet[1]; continue; }
    current = current === null ? line : `${current} ${line}`;
  }
  flush();
  return out;
}

export function extractMethodology(markdown: string): MethodologyExtract {
  const lines = markdown.split('\n');
  const slice = (from: number, until: (line: string) => boolean) => {
    const out: string[] = [];
    for (let i = from + 1; i < lines.length && !until(lines[i]); i++) out.push(lines[i]);
    return out;
  };
  const top = (n: string) => lines.findIndex(line => line.startsWith(`## ${n}.`));
  const nextTop = (line: string) => line.startsWith('## ');

  const section5 = slice(top('5'), nextTop);
  const section1 = slice(top('1'), nextTop);
  const table = (block: string[]) => block.filter(line => line.trim().startsWith('|')).map(cells).filter(row => !row.every(cell => /^-+$/.test(cell)));

  const components = table(section5.slice(0, section5.findIndex(line => line.startsWith('### ')))).slice(1)
    .map(([what, cls, component]) => ({ what, cls: cls.replace(/`/g, ''), component: component.replace(/`/g, '') }));
  const sections: Record<string, string[]> = {};
  section5.forEach((line, index) => {
    if (!line.startsWith('### ')) return;
    const body = section5.slice(index + 1);
    const end = body.findIndex(next => next.startsWith('### '));
    sections[line.slice(4).trim()] = blocks(end < 0 ? body : body.slice(0, end));
  });
  const preface = section5.slice(0, section5.findIndex(line => line.startsWith('### ')));
  const fontRule = blocks(preface.slice(preface.findIndex(line => line.startsWith('Число, которое')))).join(' ');

  const spacingRow = table(section1)[0];
  const heights = table(section1).slice(3).map(([element, height, note]) => ({ element, height: height.replace(/\*/g, ''), note: note ?? '' }));
  const checklist = blocks(slice(top('8'), nextTop));
  return {
    source: SOURCE,
    components,
    sections,
    fontRule,
    heights,
    spacing: spacingRow.slice(1).map(Number).filter(Number.isFinite),
    textRules: blocks(slice(top('6'), nextTop)),
    checklist: checklist.filter(item => !/^(npx|ONLY)/.test(item)),
  };
}

export function render(extract: MethodologyExtract): string {
  return `// Создано scripts/gen-studio-editor-methodology.ts из ${extract.source}. Не правьте вручную: запустите скрипт заново.
import type { MethodologyExtract } from './methodologyTypes';

export const METHODOLOGY: MethodologyExtract = ${JSON.stringify(extract, null, 2)};
`;
}

export function generate(): string {
  return render(extractMethodology(fs.readFileSync(path.join(root, SOURCE), 'utf8')));
}

if (require.main === module) {
  fs.writeFileSync(TARGET, generate());
  console.log(`Записано: ${path.relative(root, TARGET)}`);
}
