/**
 * Импорт MTO и спецификаций: шапка, строки систем, фильтр класса, план.
 *
 * Фикстура повторяет строение настоящего MTO PDH2.12953-3700 (шапка «Item /
 * Поз.», строки систем A01/B01, мультитеги, решётки DA). Если задан путь к
 * настоящему файлу (FLUX_MTO), проверяется и он: 156 строк клапанов на 264 шт.
 *
 * Запуск: npx tsx scripts/test-catalog-import.ts
 *         FLUX_MTO="…/MTO-0001_3_AN3.xlsx" npx tsx scripts/test-catalog-import.ts
 */
import { readFileSync, existsSync } from 'fs';
import * as XLSX from 'xlsx';
import { seedCatalog, detectorsFor } from '../catalog/seed';
import { guessHeader, readRows, planSheetImport, textForMatch } from '../catalog/sheetImport';
import { describe } from '../catalog/describe';
import { matchDescription, confidenceLevel } from '../catalog/match';
import type { SelectionItemData } from '../catalog/selection';

let ok = 0;
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { ok++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, '— получили', JSON.stringify(got), 'ждали', JSON.stringify(want)); }
};
const yes = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { ok++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); }
};

const cat = seedCatalog();
const det = detectorsFor('valve');

console.log('1. Шапка и строки в форме MTO');
const FIX: string[][] = [
  ['Item / Поз.', '', 'Name and technical characteristics / Наименование и техническая характеристика', 'Type, package, reference to document, data sheet / Тип,марка, обозначение документа, опросного листа', 'Product Code / Код продукции', 'Supplier / Поставщик', 'Unit of measure/ Ед. изме- рения', 'Qty / Кол.', 'Weight, kg. / Масса 1 ед., кг', 'Note / Примечание'],
  ['', '', '', '', '', '', '', '', '', ''],
  ['', '', 'Ventilation system / Система вентиляции', '', '', '', '', '', '', ''],
  ['', '', 'A01', '', '', '', '', '', '', ''],
  ['3700-A01-DV-001', '3', 'Damper, rectangular section 700x600 with manual control ; - / Заслонка с прямоугольным сечением 700x600 с ручным управлением; -', '', 'VFLA1000318', '', 'pcs. / шт.', '1', '12', '0,546 м² 3700-A01-DV-001'],
  ['3700-A01-DA-001', '4', 'Grille / Решётка 300x150', '', 'VGRIL00001', '', 'pcs. / шт.', '4', '1', ''],
  ['', '', 'B01', '', '', '', '', '', '', ''],
  ['3700-B01-DN-001A, 3700-B01-DN-001B', '1', 'Check channel valve; petal; 1800(h)x1370; Execution - explosion-proof', '', 'VNRTO00001', '', 'pcs. / шт.', '2', '80', ''],
  ['3700-B01-DF-001, 3700-B01-DF-002', '2', 'Fire damper, rectangular cross-section;2800x1800(h); Fire resistance - EI 60. Function - normally open. Design - explosion proof; spring return actuator. Rated voltage - 24 V (DC). Junction box with a terminal strip - yes', '', 'VVFIP009760', '', 'pcs. / шт.', '2', '300', ''],
];
const guess = guessHeader(FIX)!;
eq('шапка найдена в первой строке', guess.headerRow, 0);
eq('колонки по заголовкам', [guess.columns.tag, guess.columns.description, guess.columns.type, guess.columns.code, guess.columns.qty, guess.columns.note], [0, 2, 3, 4, 7, 9]);
const rows = readRows(FIX, guess, cat.tagRules);
eq('строки систем не становятся позициями', rows.map((r) => r.system), ['A01', 'A01', 'B01', 'B01']);
eq('решётки DA пропущены', rows.map((r) => !!r.skip), [false, true, false, false]);
eq('мультитег разобран', rows[2].tags, ['3700-B01-DN-001A', '3700-B01-DN-001B']);
eq('количество и номер строки Excel', [rows[3].qty, rows[3].row], [2, 9]);
yes('код продукции попадает в текст подбора', textForMatch(rows[0]).includes('E=VFLA1000318'));

console.log('2. План импорта по тегам');
const existing: SelectionItemData[] = [
  { id: 'i1', classId: 'cls-valve', tags: ['3700-A01-DV-001'], qty: 1, familyId: 'veza-germik-p', values: { H: 600, W: 700 }, designation: 'x', status: 'matched', sort: 1, sourceText: 'old' },
  { id: 'i2', classId: 'cls-valve', tags: ['3700-B01-DF-001'], qty: 1, values: {}, designation: '', status: 'draft', sort: 2, overrides: ['qty'] },
  { id: 'i3', classId: 'cls-valve', tags: ['3700-Z99-DF-001'], qty: 1, values: {}, designation: '', status: 'draft', sort: 3 },
];
const propose = (r: typeof rows[number]) => ({ tags: r.tags, qty: r.qty, sourceText: r.description });
const plan = planSheetImport(existing, rows, propose, { fullDocument: true });
eq('действия по строкам', plan.entries.map((e) => e.action), ['update', 'skip', 'new', 'update']);
const upd = plan.entries[3];
yes('ручная правка количества отмечена', upd.changes.some((c) => c.field === 'qty' && c.overridden), upd.changes);
yes('новый тег у позиции — изменение тегов', upd.changes.some((c) => c.field === 'tags'), upd.changes);
eq('пропавшая из полного файла позиция предложена к снятию', plan.missing.map((m) => m.id), ['i3']);
eq('фрагмент документа ничего не снимает', planSheetImport(existing, rows, propose).missing, []);
{
  const split = planSheetImport([
    { id: 'a', classId: 'cls-valve', tags: ['3700-B01-DN-001A'], qty: 1, values: {}, designation: '', status: 'draft', sort: 1 },
    { id: 'b', classId: 'cls-valve', tags: ['3700-B01-DN-001B'], qty: 1, values: {}, designation: '', status: 'draft', sort: 2 },
  ], rows, propose);
  eq('теги строки в двух позициях — конфликт', split.entries[2].action, 'conflict');
}

const real = process.env.FLUX_MTO;
if (real && existsSync(real)) {
  console.log('3. Настоящий MTO');
  const wb = XLSX.read(readFileSync(real), { type: 'buffer' });
  const name = wb.SheetNames.find((n) => /specification|спецификац/i.test(n)) || wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' }) as string[][];
  const g = guessHeader(aoa)!;
  yes('шапка найдена', !!g && g.columns.tag === 0 && g.columns.description === 2, g);
  const all = readRows(aoa, g, cat.tagRules, { onlyTagged: true });
  const valves = all.filter((r) => !r.skip);
  eq('строк клапанов', valves.length, 156);
  eq('штук клапанов', valves.reduce((a, r) => a + r.qty, 0), 264);
  const levels = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  const byFamily = new Map<string, number>();
  const weak: string[] = [];
  for (const r of valves) {
    const d = describe(textForMatch(r), det, { tags: r.tags });
    const top = matchDescription(cat, d)[0];
    const lvl = confidenceLevel(top.confidence);
    levels[lvl]++;
    const code = cat.families.find((f) => f.id === top.familyId)!.code;
    byFamily.set(code, (byFamily.get(code) || 0) + 1);
    if (lvl === 'low') weak.push(`${r.row}: ${r.tags[0]} → ${code} (${top.confidence})`);
  }
  console.log('     уверенность:', JSON.stringify(levels));
  console.log('     семейства:', JSON.stringify([...byFamily.entries()].sort((a, b) => b[1] - a[1])));
  if (weak.length) console.log('     слабые:', weak.slice(0, 12).join('; '));
  yes('подобрано с уверенностью не ниже средней больше 80% строк', (levels.high + levels.medium) / valves.length > 0.8, levels);
} else {
  console.log('3. Настоящий MTO — пропущено (задайте FLUX_MTO)');
}

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
