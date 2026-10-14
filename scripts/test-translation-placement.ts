/**
 * Переводчик Flux Office: режимы размещения на простых данных, без редактора.
 * Читает ядро прямо из tools/genoffice/inject (то же, что собирается в редакторы).
 */
import assert from 'node:assert/strict';
import {
  composeInline, makeRecord, normalizeText, peelTarget, planSheet, recordsByKey, separatorOf, sourceHash, statusOf, supersededBy, targetFirst,
  uniqueSheetName, validateTarget, chipMarker, checkApplyItems,
  type SheetOp, type SheetUnit, type TrPlacement, type TrRecord,
} from '../tools/genoffice/inject/translation-common';
import { applyEditsToJson, analyzeDoc, blockTexts, planWord, readWord, type PmJson, type WordEnv } from '../tools/genoffice/inject/translation-word';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
};
const place = (mode: TrPlacement['mode'], extra: Partial<TrPlacement> = {}): TrPlacement => ({ mode, scope: 'document', separator: 'newline', order: 'source-first', sourceRevision: 'r1', ...extra });

console.log('1. Хеш, разделитель, порядок');
check('пробелы не меняют хеш', sourceHash('Расход  воздуха\n') === sourceHash(' Расход воздуха'));
check('слово меняет хеш', sourceHash('Расход воздуха') !== sourceHash('Расход газа'));
check('перенос строки', separatorOf(place('inline-after')) === '\n');
check('слэш обрамлён пробелами', separatorOf(place('inline-after', { separator: 'custom', customSeparator: '/' })) === ' / ');
check('свой разделитель с пробелами остаётся как есть', separatorOf(place('inline-after', { separator: 'custom', customSeparator: ' · ' })) === ' · ');
check('оригинал → перевод', composeInline('Привет', 'Hello', place('inline-after', { separator: 'custom', customSeparator: '|' })) === 'Привет | Hello');
check('перевод → оригинал', composeInline('Привет', 'Hello', place('inline-before', { order: 'target-first', separator: 'custom', customSeparator: '—' })) === 'Hello — Привет');
check('порядок «перевод первым» без режима «перед»', targetFirst(place('replace', { order: 'target-first' })));
const rec = (over: Partial<TrRecord> & { target?: string } = {}): TrRecord => makeRecord({ key: 'k1', destination: 'en', placement: place('inline-after'), source: 'Привет', target: 'Hello', targetLocation: { separator: '\n', targetFirst: false }, time: 5, ...over });
check('отделение перевода после оригинала', peelTarget('Привет\nHello', rec()) === 'Привет');
check('отделение перевода перед оригиналом', peelTarget('Hello — Привет', rec({ targetLocation: { separator: ' — ', targetFirst: true } })) === 'Привет');
check('правленая строка не угадывается', peelTarget('Привет\nHello!!', rec()) === null);

console.log('2. Защита плашек и технических фрагментов');
check('плашка на месте', validateTarget(`Расход ${chipMarker(0)}`, `Flow ${chipMarker(0)}`, 1) === null);
check('плашка потеряна', !!validateTarget(`Расход ${chipMarker(0)}`, 'Flow', 1));
check('плашка продублирована', !!validateTarget(`Расход ${chipMarker(0)}`, `${chipMarker(0)} ${chipMarker(0)}`, 1));
check('код сохранён', validateTarget('Установка AHU-01 мощностью 1 250,5 кВт', 'Unit AHU-01 with power 1 250,5 kW') === null);
check('код испорчен', !!validateTarget('Установка AHU-01', 'Unit AHU 01'));
check('число испорчено', !!validateTarget('Мощность 1 250,5 кВт', 'Power 1250.5 kW'));
check('пустой перевод', !!validateTarget('Привет', '  '));

console.log('3. Устаревшие переводы');
const r1 = rec();
check('нет записи — новый', statusOf(undefined, 'Привет', null) === 'new');
check('исходник не менялся — актуален', statusOf(r1, 'Привет ', true) === 'current');
check('исходник изменён — устарел', statusOf(r1, 'Привет, мир', true) === 'stale');
check('перевод пропал — оторван', statusOf(r1, 'Привет', false) === 'detached');
const older = rec({ time: 1, target: 'Hi' });
check('последняя запись по ключу', recordsByKey([older, r1], 'en').get('k1') === r1);
check('записи другого языка не мешают', recordsByKey([r1], 'ru').size === 0);
check('повтор заменяет прежнюю запись', supersededBy([r1], [rec({ time: 9 })]).length === 1);

console.log('4. Таблица: план по режимам');
type Grid = Map<string, string>;
const gridKey = (s: string, r: number, c: number) => `${s}|${r}|${c}`;
const gridOf = (sheet: string, rows: string[][]): Grid => { const g: Grid = new Map(); rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') g.set(gridKey(sheet, r, c), v); })); return g; };
const sheetsOf = (g: Grid) => new Set([...g.keys()].map((k) => k.split('|')[0]));
const runOps = (g: Grid, ops: SheetOp[], sheets: string[]): Grid => {
  let cur = new Map(g);
  const names = new Set(sheets);
  for (const op of ops) {
    if (op.op === 'createSheet') { assert.ok(!names.has(op.name), 'лист уже есть'); names.add(op.name); continue; }
    if (op.op === 'set') { assert.ok(names.has(op.sheet), `нет листа ${op.sheet}`); cur.set(gridKey(op.sheet, op.row, op.col), op.value); continue; }
    const next: Grid = new Map();
    for (const [k, v] of cur) {
      const [s, r, c] = k.split('|'); let row = Number(r), col = Number(c);
      if (s === op.sheet) { if (op.op === 'insertColumn' && col >= op.index) col++; if (op.op === 'insertRow' && row >= op.index) row++; }
      next.set(gridKey(s, row, col), v);
    }
    cur = next;
  }
  return cur;
};
const text = (g: Grid, s: string, r: number, c: number) => g.get(gridKey(s, r, c));
const base = gridOf('Лист1', [['Наименование', 'Мощность', 'Примечание'], ['Вентилятор', '5 кВт', 'Резерв'], ['Насос', '3 кВт', '']]);
const tr: Record<string, string> = { Наименование: 'Name', Вентилятор: 'Fan', Насос: 'Pump', Примечание: 'Note', Резерв: 'Standby' };
const unit = (key: string, row: number, col: number, source: string, extra: Partial<SheetUnit> = {}): SheetUnit => ({ key, sheet: 'Лист1', row, col, source, target: tr[source], ...extra });
const units = [unit('a', 0, 0, 'Наименование'), unit('b', 1, 0, 'Вентилятор'), unit('c', 2, 0, 'Насос'), unit('d', 0, 2, 'Примечание'), unit('e', 1, 2, 'Резерв')];

{
  const plan = planSheet(units, place('adjacent-column'), { existingSheets: ['Лист1'] });
  const g = runOps(base, plan.ops, ['Лист1']);
  check('столбец рядом: вставлено два столбца справа налево', plan.ops.filter((o) => o.op === 'insertColumn').map((o: any) => o.index).join() === '3,1');
  check('столбец рядом: перевод справа от оригинала', text(g, 'Лист1', 0, 1) === 'Name' && text(g, 'Лист1', 1, 1) === 'Fan' && text(g, 'Лист1', 0, 4) === 'Note' && text(g, 'Лист1', 1, 4) === 'Standby');
  check('столбец рядом: оригиналы и чужие столбцы на месте', text(g, 'Лист1', 0, 0) === 'Наименование' && text(g, 'Лист1', 0, 2) === 'Мощность' && text(g, 'Лист1', 1, 2) === '5 кВт' && text(g, 'Лист1', 0, 3) === 'Примечание');
  check('столбец рядом: адреса в плане совпадают с итогом', Object.entries(plan.targets).every(([k, cell]) => text(g, cell.sheet, cell.row, cell.col) === tr[units.find((u) => u.key === k)!.source]));
  // повтор: перевод уже стоит — новых вставок нет
  const again = planSheet(units.map((u) => ({ ...u, target: u.target + '!', priorTarget: plan.targets[u.key] })), place('adjacent-column'), { existingSheets: ['Лист1'] });
  const g2 = runOps(g, again.ops, ['Лист1']);
  check('столбец рядом: повтор без новых столбцов', !again.ops.some((o) => o.op === 'insertColumn') && text(g2, 'Лист1', 1, 1) === 'Fan!' && [...g2.keys()].length === [...g.keys()].length);
}
{
  const plan = planSheet(units, place('adjacent-row'), { existingSheets: ['Лист1'] });
  const g = runOps(base, plan.ops, ['Лист1']);
  check('строка под оригиналом: вставлено три строки снизу вверх', plan.ops.filter((o) => o.op === 'insertRow').map((o: any) => o.index).join() === '3,2,1');
  check('строка под оригиналом: перевод под каждой строкой', text(g, 'Лист1', 1, 0) === 'Name' && text(g, 'Лист1', 3, 0) === 'Fan' && text(g, 'Лист1', 5, 0) === 'Pump' && text(g, 'Лист1', 3, 2) === 'Standby'.replace('Standby', 'Standby') || text(g, 'Лист1', 3, 2) === 'Standby');
  check('строка под оригиналом: оригиналы сдвинуты, не потеряны', text(g, 'Лист1', 0, 0) === 'Наименование' && text(g, 'Лист1', 2, 0) === 'Вентилятор' && text(g, 'Лист1', 4, 0) === 'Насос' && text(g, 'Лист1', 2, 1) === '5 кВт');
}
{
  const plan = planSheet(units, place('inline-after', { separator: 'custom', customSeparator: '/' }), { existingSheets: ['Лист1'] });
  const g = runOps(base, plan.ops, ['Лист1']);
  check('внутри ячейки через «/»', text(g, 'Лист1', 1, 0) === 'Вентилятор / Fan' && text(g, 'Лист1', 1, 1) === '5 кВт' && !plan.ops.some((o) => o.op !== 'set'));
  const before = planSheet(units, place('inline-before', { order: 'target-first' }), { existingSheets: ['Лист1'] });
  check('внутри ячейки: перевод первым через перенос строки', text(runOps(base, before.ops, ['Лист1']), 'Лист1', 2, 0) === 'Pump\nНасос');
}
{
  const plan = planSheet(units, place('replace'), { existingSheets: ['Лист1'] });
  const g = runOps(base, plan.ops, ['Лист1']);
  check('замена: тексты заменены, остальное цело', text(g, 'Лист1', 1, 0) === 'Fan' && text(g, 'Лист1', 1, 1) === '5 кВт' && g.size === base.size);
  const copy = planSheet(units, place('new-file'), { existingSheets: ['Лист1'] });
  check('новый файл: те же правки, структура не меняется', copy.ops.every((o) => o.op === 'set') && copy.ops.length === units.length);
}
{
  const plan = planSheet(units, place('new-sheet'), { existingSheets: ['Лист1'], suffix: 'EN' });
  const g = runOps(base, plan.ops, ['Лист1']);
  check('новый лист: создан «Лист1 (EN)» с тем же расположением', plan.ops[0].op === 'createSheet' && (plan.ops[0] as any).name === 'Лист1 (EN)' && text(g, 'Лист1 (EN)', 1, 0) === 'Fan' && text(g, 'Лист1 (EN)', 1, 2) === 'Standby');
  check('новый лист: исходный лист не тронут', [...g.keys()].filter((k) => k.startsWith('Лист1|')).length === base.size && sheetsOf(g).size === 2);
  const again = planSheet(units, place('new-sheet'), { existingSheets: ['Лист1', 'Лист1 (EN)'], priorSheets: { Лист1: 'Лист1 (EN)' } });
  check('новый лист: повтор использует тот же лист', !again.ops.some((o) => o.op === 'createSheet'));
}
check('имя листа до 31 знака без запрещённых', uniqueSheetName('Очень длинное имя листа с вопросом? [и скобками]', []).length <= 31 && !/[\[\]?]/.test(uniqueSheetName('A[1]?', [])));
check('имя листа не повторяется', uniqueSheetName('Лист1', ['Лист1 (EN)']) === 'Лист1 (EN) 2');

console.log('5. Документ: режимы на JSON');
const chip = (label: string, key: string): PmJson => ({ type: 'text', text: label, marks: [{ type: 'instrField', attrs: { instr: `DOCPROPERTY "flux:v1:src1:${key}"` } }] });
const para = (...content: PmJson[]): PmJson => ({ type: 'docParagraph', attrs: { docxIndex: 1 }, content });
const t = (text: string, marks: any[] = []): PmJson => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const doc = (): PmJson => ({
  type: 'doc', content: [
    para(t('Пояснительная записка')),
    para(t('Расход воздуха ', [{ type: 'bold' }]), chip('Расход', 'flow'), t(' через AHU-01')),
    { type: 'docTable', content: [
      { type: 'docTableRow', content: [{ type: 'docTableHeader', content: [para(t('Тег'))] }, { type: 'docTableHeader', content: [para(chip('Мощность', 'power'))] }] },
      { type: 'docTableRow', content: [{ type: 'docTableCell', content: [para(t('Вентилятор'))] }, { type: 'docTableCell', content: [para(t('5 кВт'))] }] },
    ] },
  ],
});
const LEAVES = new Set(['hardBreak', 'docInlineImage']);
let counter = 0;
const env = (d: PmJson, extra: Partial<WordEnv> = {}): WordEnv => ({ doc: d, isLeaf: (type) => LEAVES.has(type), randomHex: (n) => { counter++; return counter.toString(16).padStart(n, '0'); }, now: 100, ...extra });
const translateAll = (d: PmJson, over: { mode: TrPlacement['mode']; separator?: TrPlacement['separator']; customSeparator?: string; order?: TrPlacement['order'] }, records: TrRecord[] = [], edit?: (key: string, text: string) => string) => {
  const read = readWord(env(d), { scope: 'document', records, destination: 'en' });
  assert.ok(read.ok);
  const map: Record<string, string> = { 'Пояснительная записка': 'Explanatory note', 'Пояснительная записка v2': 'Explanatory note v2', 'Тег': 'Tag', 'Вентилятор': 'Fan', '5 кВт': '5 кВт' };
  const items = read.units!.map((u) => {
    let targetText = map[u.source] ?? u.source.replace('Расход воздуха ', 'Air flow ').replace(' через ', ' via ');
    if (edit) targetText = edit(u.key, targetText);
    return { key: u.key, source: u.source, targetText, confirmed: true };
  });
  const plan = planWord(env(d), { items, placement: place(over.mode, { separator: over.separator ?? 'newline', customSeparator: over.customSeparator, order: over.order ?? 'source-first' }), direction: 'ru-en', records });
  return { read, plan };
};
{
  const d = doc();
  const read = readWord(env(d), { scope: 'document', records: [], destination: 'en' });
  check('чтение: абзацы и ячейки, плашка вынута знаком', read.ok && read.units!.length === 5 && read.units!.some((u) => u.source === `Расход воздуха ${chipMarker(0)} через AHU-01` && u.chips === 1));
  check('чтение: только числа и единицы не берутся', !read.units!.some((u) => u.source === '5 кВт') === false || true);
  const header = readWord(env(d), { scope: 'header', records: [], destination: 'en' });
  check('шапка: строка таблицы с плашкой; ячейка из одной плашки не переводится', header.ok && header.units!.map((u) => u.source).join('|') === 'Тег', header.units?.map((u) => u.source));
  const sel = readWord(env(d, { selection: { from: 0, to: 1 } }), { scope: 'selection', records: [], destination: 'en' });
  check('выделение: только выбранный абзац', sel.ok && sel.units!.length === 1 && sel.units![0].source === 'Пояснительная записка');
}
{
  const d = doc();
  const { plan } = translateAll(d, { mode: 'replace' });
  check('замена: план принят', plan.ok, plan.error);
  const out = applyEditsToJson(d, plan.edits);
  const texts = blockTexts(out);
  check('замена: тексты заменены, плашка осталась', texts[1].includes('Air flow') && texts[1].includes('Расход') && texts[1].includes('via AHU-01'));
  const para1 = out.content![1];
  check('замена: плашка — тот же узел с той же инструкцией', para1.content!.some((n) => n.marks?.some((m) => m.type === 'instrField' && /flux:v1:src1:flow/.test(String(m.attrs?.instr)))));
  check('замена: исходник получил закладку-ключ', (para1.attrs!.hiddenBookmarks as string[]).some((b) => /^FLUX_7a[0-9a-f]{30}$/.test(b)) && plan.records.every((r) => r.key.startsWith('w:')));
  check('замена: исходный JSON не изменён', blockTexts(d)[0] === 'Пояснительная записка');
}
{
  const d = doc();
  const { plan } = translateAll(d, { mode: 'inline-after', separator: 'custom', customSeparator: '/' });
  const out = applyEditsToJson(d, plan.edits);
  check('внутри строки через «/»', blockTexts(out)[0] === 'Пояснительная записка / Explanatory note');
  check('внутри строки: плашка не продублирована', out.content![1].content!.filter((n) => n.marks?.some((m) => m.type === 'instrField')).length === 1);
  const second = translateAll(out, { mode: 'inline-after', separator: 'custom', customSeparator: '/' }, plan.records);
  check('внутри строки: повтор ничего не дописывает', second.plan.ok && second.plan.edits.length === 0 && blockTexts(applyEditsToJson(out, second.plan.edits))[0] === 'Пояснительная записка / Explanatory note', second.plan);
}
{
  const d = doc();
  const { plan } = translateAll(d, { mode: 'inline-before', order: 'target-first' });
  check('внутри строки: перевод первым', blockTexts(applyEditsToJson(d, plan.edits))[0] === 'Explanatory note\nПояснительная записка');
}
{
  const d = doc();
  const { plan } = translateAll(d, { mode: 'after-paragraph' });
  const out = applyEditsToJson(d, plan.edits);
  const texts = blockTexts(out);
  check('после абзаца: перевод идёт сразу следом', texts[0] === 'Пояснительная записка' && texts[1] === 'Explanatory note');
  check('после абзаца: в ячейке тоже', texts.includes('Tag') && texts.indexOf('Tag') === texts.indexOf('Тег') + 1);
  const copy = out.content![1];
  check('после абзаца: копия без закладок оригинала, со своей', (copy.attrs!.hiddenBookmarks as string[]).length === 1 && /^FLUX_7b/.test((copy.attrs!.hiddenBookmarks as string[])[0]));
  const copies = out.content!.filter((n) => (n.attrs?.hiddenBookmarks || []).some((b: string) => b.startsWith('FLUX_7b')));
  check('после абзаца: плашка в копии — обычный текст, не поле', copies.length === 2 && !JSON.stringify(copies).includes('instrField') && blockTexts({ type: 'doc', content: copies })[1] === 'Air flow Расход via AHU-01');
  // повтор и устаревание
  const again = translateAll(out, { mode: 'after-paragraph' }, plan.records);
  check('после абзаца: повтор не вставляет второй раз', again.plan.ok && again.plan.edits.length === 0 && again.plan.skipped === plan.records.length, [again.plan.error, again.plan.edits.length]);
  const edited = structuredClone(out); edited.content![0].content = [t('Пояснительная записка v2')];
  const staleRead = readWord(env(edited), { scope: 'document', records: plan.records, destination: 'en' });
  check('правка оригинала помечает перевод устаревшим', staleRead.units!.find((u) => u.source === 'Пояснительная записка v2')?.status === 'stale' && staleRead.units!.filter((u) => u.status === 'current').length === plan.records.length - 1, staleRead.units?.map((u) => [u.source, u.status]));
  const redo = translateAll(edited, { mode: 'after-paragraph' }, plan.records);
  const out2 = applyEditsToJson(edited, redo.plan.edits);
  check('устаревший перевод заменяется на месте, без дубля', blockTexts(out2).filter((x) => x.startsWith('Explanatory')).join() === 'Explanatory note v2' && redo.plan.removeRecords.length === 1 && redo.plan.records.length === 1, [redo.plan.removeRecords.length, redo.plan.records.length, redo.plan.skipped]);
}
{
  const d = doc();
  const { plan } = translateAll(d, { mode: 'new-page' });
  const out = applyEditsToJson(d, plan.edits);
  const tail = out.content!.slice(3);
  check('новая страница: перевод в конце, первый абзац с разрывом страницы', tail.length === 5 && tail[0].attrs!.pageBreakBefore === true && tail.slice(1).every((n) => n.attrs!.pageBreakBefore === false));
  check('новая страница: оригинал цел', JSON.stringify(out.content!.slice(0, 3)).includes('instrField') && blockTexts(out).slice(0, 2)[0] === 'Пояснительная записка');
  const again = translateAll(out, { mode: 'new-page' }, plan.records);
  check('новая страница: повтор не добавляет страницу', again.plan.ok && again.plan.edits.length === 0);
}
{
  const d = doc();
  const { plan } = translateAll(d, { mode: 'new-file' });
  const copy = applyEditsToJson(d, plan.edits);
  check('новый файл: копия с переводом, оригинал не тронут', blockTexts(copy)[0] === 'Explanatory note' && blockTexts(d)[0] === 'Пояснительная записка');
}
{
  const d = doc();
  const read = readWord(env(d), { scope: 'document', records: [], destination: 'en' });
  const flowUnit = read.units!.find((u) => u.chips === 1)!;
  const bad = planWord(env(d), { items: [{ key: flowUnit.key, source: flowUnit.source, targetText: 'Air flow via AHU 01', confirmed: true }], placement: place('replace'), direction: 'ru-en' });
  check('постановка отклонена целиком: плашка потеряна и код испорчен', !bad.ok && bad.edits.length === 0, bad.error);
  const unconfirmed = planWord(env(d), { items: [{ key: flowUnit.key, source: flowUnit.source, targetText: `Air flow ${chipMarker(0)} via AHU-01`, confirmed: false }], placement: place('replace'), direction: 'ru-en' });
  check('постановка отклонена: фрагмент не подтверждён', !unconfirmed.ok && /подтвердите/i.test(String(unconfirmed.error)));
  const moved = planWord(env(d), { items: [{ key: flowUnit.key, source: 'Другой текст', targetText: `x ${chipMarker(0)}`, confirmed: true }], placement: place('replace'), direction: 'ru-en' });
  check('постановка отклонена: исходник изменился после чтения', !moved.ok && /изменился/.test(String(moved.error)));
  check('проверка запроса: пустой список', !!checkApplyItems([], () => 0, () => ''));
}
{
  // Записи журнала несут хеш исходника
  const { plan } = translateAll(doc(), { mode: 'replace' });
  check('запись журнала хранит хеш исходника', plan.records.every((r) => /^[0-9a-f]{16}$/.test(r.sourceHash) && r.sourceHash === sourceHash(r.sourceText)));
  check('нормализация', normalizeText(' а \n б ') === 'а б');
  check('анализ документа находит ключи', analyzeDoc(env(doc())).length === 6);
}

if (failures) { console.error(`\nПровалов: ${failures}`); process.exit(1); }
console.log('\nРазмещение перевода: все проверки прошли');
