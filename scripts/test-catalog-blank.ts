/**
 * Бланк: данные по листам, выражения полей, отрисовка шаблона в сетку.
 *
 * Главное, что здесь стережётся, — дефекты ручных бланков E06: колонки,
 * съезжающие между листами, номер б/з с соседнего листа, колонтитул прошлой
 * ревизии. По построению их быть не должно, и проверка это закрепляет.
 *
 * Запуск: npx tsx scripts/test-catalog-blank.ts
 */
import { seedCatalog } from '../catalog/seed';
import { evalExpr } from '../catalog/blank/expr';
import { buildBlankData } from '../catalog/blank/data';
import { renderBlank, fitSpans } from '../catalog/blank/render';
import { defaultBlankTemplate } from '../catalog/blank/defaults';
import type { SelectionItemData } from '../catalog/selection';
import type { SheetGrid } from '../catalog/blank/model';
import { sheetHtml, documentHtml } from '../src/lib/blankHtml';
import { templateProblem } from '../catalog/blank/safe';

let ok = 0;
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { ok++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, '— получили', JSON.stringify(got), 'ждали', JSON.stringify(want)); }
};
const yes = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { ok++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); }
};

console.log('1. Выражения');
const scope = { doc: { docNo: 'PDH2-E06-2002', rev: '3', date: '2025-10-22' }, n: 2, tags: ['A-DF-001', 'A-DF-002'], orderNo: '255000475', empty: '' };
eq('поле и текст вокруг', evalExpr('{orderNo}-{n}-КОМ', [scope], 'ru'), '255000475-2-КОМ');
eq('одно поле остаётся числом', evalExpr('{n}', [scope], 'ru'), 2);
eq('теги столбиком', evalExpr('{tags|lines}', [scope], 'ru'), 'A-DF-001\nA-DF-002');
eq('теги через пробел', evalExpr('{tags|join: }', [scope], 'ru'), 'A-DF-001 A-DF-002');
eq('пустое — значение по умолчанию', evalExpr('{empty|default:-}', [scope], 'ru'), '-');
eq('вложенное поле по умолчанию', String(evalExpr('{missing|default:{n}}', [scope], 'ru')), '2');
eq('дата по-русски', evalExpr('{doc.date|date}', [scope], 'ru'), '22.10.2025');
eq('префикс только при значении', [evalExpr('{doc.docNo}{doc.rev|prefix:_}', [scope], 'ru'), evalExpr('{empty|prefix:_}', [scope], 'ru')], ['PDH2-E06-2002_3', '']);
eq('подпись на двух языках', evalExpr('{t}', [{ t: { ru: 'Кол-во', en: 'Qty' } }], 'ru+en'), 'Кол-во / Qty');
eq('поиск по цепочке: строка → лист → документ', evalExpr('{n}/{doc.rev}', [{ n: 5 }, scope], 'ru'), '5/3');

console.log('2. Ширины колонок таблицы');
eq('недостающее отдаётся последней', fitSpans([1, 2, 1], 8), [1, 2, 5]);
eq('лишнее срезается с широких, сумма — ровно ширина листа', fitSpans([4, 4, 4], 8).reduce((a, b) => a + b, 0), 8);
yes('узкая колонка при срезании не пропадает', fitSpans([6, 1, 1, 1, 1, 1, 1, 1], 8).every((s) => s >= 1));

console.log('3. Ведомость → листы бланка');
const cat = seedCatalog();
const item = (id: string, familyId: string, values: Record<string, string | number>, tags: string[], qty = tags.length, sort = 0): SelectionItemData =>
  ({ id, classId: 'cls-valve', familyId, values, tags, qty, designation: '', status: 'matched', sort });
const items: SelectionItemData[] = [
  item('1', 'veza-kpu-1n', { purpose: 'О', exec: 'В', W: 2800, H: 1800, type: '2*ф', drive: 'ЭПВ24', terminals: 'КК' }, ['3700-B01-DF-001', '3700-B01-DF-002'], 2, 1),
  item('2', 'veza-kpu-1n', { purpose: 'О', exec: 'В', W: 900, H: 400, type: '2*ф', drive: 'ЭПВ24', terminals: 'КК' }, ['3700-B02-DF-001', '3700-B02-DF-004'], 2, 2),
  item('3', 'veza-kpu-1n', { purpose: 'О', exec: 'Н', D: 100, type: '2*ф', drive: 'MV24', terminals: 'КК' }, ['3700-C03-DF-001'], 1, 3),
  item('4', 'veza-germik-p', { H: 600, W: 1000, exec: 'Н', drive: 'РУЧКА', driveCount: 1 }, ['3700-C01-DV-001', '3700-C01-DV-002'], 2, 4),
  item('5', 'veza-tulpan-1', { H: 500, W: 800, exec: 'В' }, ['3700-B03-DN-001'], 1, 5),
];
const header = { docNo: 'PDH2.12953-3700-PEQ371-E06-2002', object: 'ДГП-2', customer: 'ООО «ЗАПСИБНЕФТЕХИМ»', executor: 'Раупов Х.Х.', date: '2025-10-22' };
const orderNos = { 'veza-kpu-1n|В': '255000475', 'veza-kpu-1n|Н': '255000474', 'veza-germik-p|Н': '255200652' };
const issue = { rev: '3', date: '2026-02-16', reason: 'Выпущено для строительства', prepared: 'Раупов Х.Х.' };
const data = buildBlankData({ catalog: cat, header, items, orderNos, issue, revisions: [issue] }, 'family-exec');
eq('листы по семейству и исполнению', data.groups.map((g) => `${g.family.code}${g.execSuffix}`), ['КПУ-1Н-В', 'КПУ-1Н-Н', 'ГЕРМИК-П-Н', 'ТЮЛЬПАН-1-В']);
const g1 = data.groups[0];
eq('номера строк б/з считаются по листу', g1.items.map((r) => r.orderLine), ['255000475-1-КОМ', '255000475-2-КОМ']);
eq('номер б/з своего листа, а не соседнего', data.groups[1].items[0].orderLine, '255000474-1-КОМ');
eq('обозначение собирается из параметров', g1.items[0].designation, 'КПУ-1Н-О-В-2800х1800-2*ф-ЭПВ24-СН-КК-0-0-0-0-0');
eq('теги приводов DF → DFD', g1.actuators[0].actuatorTags, ['3700-B01-DFD-001', '3700-B01-DFD-002']);
yes('у ручной заслонки привода нет', !data.groups[2].hasActuators);
yes('у взрывозащищённого листа признак Ex', g1.isEx && !data.groups[2].isEx);
eq('характеристика листа из Каталога', g1.spec.fire.value.ru, 'EI 90');
eq('взрывозащита по исполнению', [g1.spec.ex.value.ru, data.groups[1].spec.ex.value.ru], ['Взрывозащищённый', 'нет']);

console.log('4. Отрисовка шаблона «Бланк-заказ ВЕЗА»');
const t = defaultBlankTemplate();
const sheets = renderBlank(t, data, 'ru');
eq('титул, учёт ревизий и лист на каждый тип', sheets.map((s) => s.name), ['Титул', 'Учёт ревизий', 'КПУ-1Н-В', 'КПУ-1Н-Н', 'ГЕРМИК-П-Н', 'ТЮЛЬПАН-1-В']);
const headOf = (s: SheetGrid) => {
  const r = s.cells.find((c) => c.v === 'Номер б/з')?.r;
  return s.cells.filter((c) => c.r === r && c.s === 'head').map((c) => [c.c, c.v]);
};
const heads = sheets.slice(2).map(headOf);
yes('колонки позиций одинаковы на всех листах', heads.every((h) => JSON.stringify(h) === JSON.stringify(heads[0])), heads);
eq('порядок колонок позиций', heads[0].map((h) => h[1]), ['Номер б/з', 'Наименование', 'Ширина В, мм', 'Высота Н, мм', 'Диаметр D, мм', 'Кол-во', 'TAG номер']);
const kpu = sheets[2];
eq('колонтитул — номер документа и ревизия выпуска', kpu.footer.right, 'PDH2.12953-3700-PEQ371-E06-2002_3');
yes('номер страницы остаётся полем для Excel/PDF', kpu.footer.center.includes('{page}') && kpu.footer.center.includes('{pages}'), kpu.footer);
yes('блок приводов есть у КПУ', kpu.cells.some((c) => c.v === 'Информация по электроприводу'));
yes('блока приводов нет у ручной заслонки', !sheets[4].cells.some((c) => c.v === 'Информация по электроприводу'));
yes('разрыв страницы перед шильдом', kpu.breaks.length === 1, kpu.breaks);
yes('в шапке номер бланк-заказа листа', kpu.cells.some((c) => c.v === '255000475'));
yes('ни одна ячейка не выходит за ширину листа', sheets.every((s) => s.cells.every((c) => c.c + (c.cs || 1) - 1 <= s.columns.length)),
  sheets.flatMap((s) => s.cells.filter((c) => c.c + (c.cs || 1) - 1 > s.columns.length)));
const overlap = sheets.flatMap((s) => {
  const taken = new Set<string>();
  const bad: string[] = [];
  for (const c of s.cells) for (let dr = 0; dr < (c.rs || 1); dr++) for (let dc = 0; dc < (c.cs || 1); dc++) {
    const k = `${c.r + dr}:${c.c + dc}`;
    if (taken.has(k)) bad.push(`${s.name} ${k}`);
    taken.add(k);
  }
  return bad;
});
eq('объединения не перекрываются', overlap, []);
yes('выпадающий список назначения', kpu.cells.some((c) => c.options?.includes('нормально открытый')));
yes('ни одной ячейки «#REF!» или «undefined»', sheets.every((s) => s.cells.every((c) => !/#REF!|undefined|\[object/.test(String(c.v)))),
  sheets.flatMap((s) => s.cells.filter((c) => /#REF!|undefined|\[object/.test(String(c.v))).map((c) => c.v)));
const cover = sheets[0];
yes('на титуле состав комплекта', cover.cells.some((c) => c.v === 'КПУ-1Н') && cover.cells.some((c) => c.v === 'ТЮЛЬПАН-1'));

console.log('5. Язык выгрузки');
const en = renderBlank(t, data, 'en');
yes('английские подписи', en[2].cells.some((c) => c.v === 'Order line') && !en[2].cells.some((c) => c.v === 'Номер б/з'));
const both = renderBlank(t, data, 'ru+en');
yes('двуязычные подписи', both[2].cells.some((c) => c.v === 'Номер б/з / Order line'));
eq('обозначение не переводится', en[2].cells.find((c) => String(c.v).startsWith('КПУ-1Н-О-В-2800'))?.v, 'КПУ-1Н-О-В-2800х1800-2*ф-ЭПВ24-СН-КК-0-0-0-0-0');

console.log('Шаблон не вносит разметку в чужое окно');
{
  const evil = {
    ...t,
    style: { ...t.style, headFill: 'fff;"><img src=x onerror=alert(1)>', titleSize: '12pt;}</style><script>' as any },
    page: { ...t.page, margins: { top: '1mm;} body{display:none' as any, bottom: 15, left: 15, right: 10 } },
    assets: { logo: 'x" onerror="alert(1)' },
    sheets: t.sheets.map((sh) => ({ ...sh, blocks: sh.blocks.map((b) => (b.type === 'title' ? { ...b, logo: 'logo' } : b)) })),
  } as any;
  const g = renderBlank(evil, data, 'ru');
  const html = g.map((x) => sheetHtml(x)).join('') + documentHtml(g, 'x');
  yes('вредный цвет не выходит из атрибута', !html.includes('onerror') && !html.includes('<script'), html.slice(0, 200));
  yes('поля страницы — только числа', !html.includes('display:none'));
  yes('сервер не сохранит такой шаблон', templateProblem(evil) !== '', templateProblem(evil));
  eq('шаблон по умолчанию проходит', templateProblem(t), '');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  yes('встроенная PNG рисуется', sheetHtml(renderBlank({ ...evil, style: t.style, assets: { logo: png } }, data, 'ru')[0]).includes(png));
}

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
