import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { exportName } from '../src/lib/exportGrid';

// Исполняется настоящий обработчик редактора, а не его повторная реализация.
const source = fs.readFileSync('tools/genoffice/inject/sheets-collab.ts', 'utf8');
const snippet = source.slice(source.indexOf('async function exportCommands()'));
const listeners = new Map<string, Function>(); let result: any;
const cells = new Map<string, { v?: any; f?: string }>();
const defs = new Map<string, string>();
const letters = (col: number) => String.fromCharCode(65 + col);
const put = (r: number, c: number, v: any) => cells.set(`${r},${c}`, { v });
const named = (row: string, col: string, r: number, c: number) => defs.set(exportName(row, col), `'Данные'!$${letters(c)}$${r + 1}`);
const sheet: any = {
  getSheetId: () => 'sheet', getSheetName: () => 'Данные',
  getLastRow: () => Math.max(...[...cells.keys()].map(k => Number(k.split(',')[0]))),
  getLastColumn: () => Math.max(...[...cells.keys()].map(k => Number(k.split(',')[1]))),
  getRange: (r: number, c: number) => ({
    getValues: () => [[cells.get(`${r},${c}`)?.v]], getFormulas: () => [[cells.get(`${r},${c}`)?.f]],
    setValues: (rows: any[][]) => cells.set(`${r},${c}`, rows[0][0]),
  }),
};
const wb = { getSheets: () => [sheet], getActiveSheet: () => sheet, getDefinedNames: () => [...defs].map(([name, ref]) => ({ getName: () => name, getFormulaOrRefString: () => ref })), insertDefinedName: (name: string, ref: string) => defs.set(name, ref) };
const context = vm.createContext({
  ipc: () => ({ on: (channel: string, handler: Function) => listeners.set(channel, handler), send: (_channel: string, data: any) => { result = data; } }),
  workbook: () => wb, setTimeout, Map, String, Number, Array, Math, Error,
});
vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const before: any = { headers: ['Название', 'Число'], columnKeys: ['name', 'count'], rowKeys: ['r1', 'r2'], rows: [['Первый', '10'], ['Второй', '20']], formulas: [] };
before.headers.forEach((h: string, c: number) => { put(0, c, h); named('@header', before.columnKeys[c], 0, c); });
put(0, 2, 'identity'); named('@header', '@identity', 0, 2);
before.rows.forEach((row: string[], r: number) => { row.forEach((v, c) => { put(r + 1, c, v); named(before.rowKeys[r], before.columnKeys[c], r + 1, c); }); put(r + 1, 2, before.rowKeys[r]); named(before.rowKeys[r], '@identity', r + 1, 2); });
put(1, 0, 'Ручное название'); cells.set('1,1', { f: '=5+5' });
const grid: any = { ...before, columnKeys: ['name', 'count', 'formula:sum'], headers: ['Название', 'Количество', 'Итог'], rowKeys: ['r1', 'r2', 'r3'], rows: [['Первый новый', '11', '=SUM(A2:B2)'], ['Второй', '21', '=SUM(A3:B3)'], ['Третий', '30', '=SUM(A4:B4)']], formulas: [2], formulaTemplates: { 2: '=SUM(A{row}:B{row})' } };
const refresh = (g: any, b: any) => { result = undefined; listeners.get('flux:refresh-export')!(null, { id: 'test', payload: { grid: g, before: b } }); return result; };
assert.equal(refresh(grid, before).ok, true);
assert.equal(cells.get('1,0')?.v, 'Ручное название', 'ручное название сохранено');
assert.equal(cells.get('1,1')?.f, '=5+5', 'ручная формула сохранена');
assert.equal(cells.get('2,1')?.v, '21', 'нетронутое значение обновлено');
assert.equal(cells.get('3,3')?.f, '=SUM(A4:B4)', 'новая строка ссылается на фактический номер');
// Пользователь вставил строку перед данными; имена диапазонов Excel следуют вставке.
for (const [key, cell] of [...cells].reverse()) { const [r, c] = key.split(',').map(Number); if (r) { cells.delete(key); cells.set(`${r + 1},${c}`, cell); } }
for (const [name, ref] of defs) defs.set(name, ref.replace(/\$(\d+)$/, (_, n) => `$${Number(n) > 1 ? Number(n) + 1 : n}`));
const next = { ...grid, rowKeys: [...grid.rowKeys, 'r4'], rows: [...grid.rows, ['Четвёртый', '40', '=SUM(A5:B5)']] };
assert.equal(refresh(next, grid).ok, true);
assert.equal(cells.get('5,3')?.f, '=SUM(A6:B6)', 'вставленная строка учтена при создании новой формулы');
// Сортировка переносит значения, но адреса имён могут остаться прежними.
for (let c = 0; c < 4; c++) { const a = cells.get(`2,${c}`); const b = cells.get(`3,${c}`); if (a) cells.set(`3,${c}`, a); if (b) cells.set(`2,${c}`, b); }
const sorted = JSON.stringify([...cells]);
const outcome = refresh(next, next);
assert.ok(outcome.preserved >= 6, 'несовпавшие идентификаторы не обновляются');
assert.equal(JSON.stringify([...cells]), sorted, 'сортировка не подменяет позиции');
defs.delete(exportName('@header', '@identity')); const untouched = JSON.stringify([...cells]);
assert.equal(refresh(next, next).ok, false);
assert.equal(JSON.stringify([...cells]), untouched, 'несовместимая книга отклоняется до первой записи');
console.log('10 проверок обновления рабочей книги пройдено');
