import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Btn } from '../ui';
import OfficeAppEditor, { type OfficeAppEditorHandle } from '../office/OfficeAppEditor';
import { saveNewFile, type SavedFile } from '../../lib/officeFiles';
import { exportName, type ExportGrid } from '../../lib/exportGrid';
import { toCsv, toClipboard } from '../../lib/exchange';
import type { WorkbookTemplate } from '../../lib/exportSpec';

export interface ExportWorkbookHandle { hasBook: () => boolean; save: () => Promise<boolean>; output: (kind: 'xlsx' | 'csv' | 'clipboard' | 'office') => Promise<void>; template: () => Promise<WorkbookTemplate | undefined>; applyTemplate: (t: WorkbookTemplate) => Promise<void> }
interface Props { projectId: string; grid: ExportGrid; name: string; say: (text: string, kind?: 'success' | 'error' | 'info') => void }
interface Remembered { file: SavedFile; baseline: ExportGrid }

function bytesOf(grid: ExportGrid): ArrayBuffer {
  const identityCol = grid.headers.length;
  const sheet = XLSX.utils.aoa_to_sheet([[...grid.headers, 'Идентификатор строки Flux'], ...grid.rows.map((row, i) => [...row, grid.rowKeys[i]])]);
  const names: XLSX.DefinedName[] = [];
  [grid.headers, ...grid.rows].forEach((row, i) => row.forEach((v, j) => {
    const address = XLSX.utils.encode_cell({ r: i, c: j });
    if (i > 0 && grid.formulas.includes(j) && v.startsWith('=')) sheet[address] = { t: 'n', f: v.slice(1) };
    else if (i > 0 && /^[-+]?\d+(?:[.,]\d+)?$/.test(v) && !/^0\d/.test(v) && !['tag', 'parentTag', 'unitTag', 'model', 'itemCode'].includes(grid.columnKeys[j].split('::unit:')[0])) sheet[address] = { t: 'n', v: Number(v.replace(',', '.')) };
    names.push({ Name: exportName(i ? grid.rowKeys[i - 1] : '@header', grid.columnKeys[j]), Ref: `'Данные'!${XLSX.utils.encode_cell({ r: i, c: j }).replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2')}` });
  }));
  grid.rowKeys.forEach((key, i) => names.push({ Name: exportName(key, '@identity'), Ref: `'Данные'!$${XLSX.utils.encode_col(identityCol)}$${i + 2}` }));
  names.push({ Name: exportName('@header', '@identity'), Ref: `'Данные'!$${XLSX.utils.encode_col(identityCol)}$1` });
  sheet['!cols'] = [...grid.headers.map(h => ({ wch: Math.min(35, Math.max(15, h.length + 2)) })), { hidden: true }];
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Данные');
  book.Workbook = { Names: names };
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' });
}
const download = (bytes: Blob, name: string) => { const url = URL.createObjectURL(bytes); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); };

/** Настоящая книга хранится в Проводнике, а не в состоянии окна. */
const ExportWorkbook = forwardRef<ExportWorkbookHandle, Props>(function ExportWorkbook({ projectId, grid, name, say }, ref) {
  const editor = useRef<OfficeAppEditorHandle>(null);
  const storageKey = `flux_export_workbook:${projectId}`;
  const [remembered, setRemembered] = useState<Remembered | null>(() => { try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; } });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const valid = grid.headers.length > 0 && grid.rows.length * grid.headers.length <= 10000;
  const remember = (value: Remembered) => { setRemembered(value); try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* книга уже сохранена на диске */ } };
  const create = async () => {
    if (busy || !valid) return; setBusy(true); setError('');
    try { const file = await saveNewFile(bytesOf(grid), `${name.trim() || 'Выгрузка данных'}.xlsx`, 'exports'); remember({ file, baseline: grid }); }
    catch (err: any) { setError(err.message || 'Книга не создана'); }
    finally { setBusy(false); }
  };
  // Проверяем старую ссылку: удалённый файл не оставляет пустой редактор.
  useEffect(() => {
    if (!remembered) return;
    let live = true;
    fetch(`/api/office/files/${encodeURIComponent(remembered.file.id)}/meta`).then(r => {
      if (live && r.status === 404) { setRemembered(null); localStorage.removeItem(storageKey); }
    }).catch(() => undefined);
    return () => { live = false; };
  }, [remembered?.file.id, storageKey]);
  const save = async () => !remembered || !!(await editor.current?.save());
  const template = async (): Promise<WorkbookTemplate | undefined> => {
    if (!remembered) return undefined;
    if (!(await save())) throw new Error('Сначала дождитесь сохранения книги');
    const r = await fetch(`/api/office/files/${encodeURIComponent(remembered.file.id)}/open`);
    if (!r.ok) throw new Error('Не удалось прочитать книгу шаблона');
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 1500000) throw new Error('Книга шаблона больше 1,5 МБ. Сохраните её отдельным файлом или сократите оформление');
    let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
    return { base64: btoa(text), baseline: remembered.baseline };
  };
  const applyTemplate = async (t: WorkbookTemplate) => {
    if (!(await save())) throw new Error('Текущая книга не сохранена');
    const bytes = Uint8Array.from(atob(t.base64), c => c.charCodeAt(0));
    const file = await saveNewFile(bytes, `${name.trim() || 'Выгрузка данных'}.xlsx`, 'exports');
    remember({ file, baseline: t.baseline });
    say('Создана копия книги шаблона. Нажмите «Обновить данные в листе» для текущего отбора', 'info');
  };
  const refresh = async () => {
    if (!remembered) { await create(); return; }
    if (!valid) return;
    setBusy(true); setError('');
    try {
      const result = await editor.current?.command('flux:refresh-export', { grid, before: remembered.baseline });
      if (!result?.ok) throw new Error(result?.error || 'Редактор ещё загружает книгу');
      if (!(await save())) throw new Error('Обновление не сохранено. Дождитесь окончания загрузки и нажмите Ctrl+S');
      remember({ ...remembered, baseline: grid });
      say(`Обновлено ячеек: ${result.updated}. Сохранено ручных правок и формул: ${result.preserved}${result.retainedRows ? `. Старых строк оставлено: ${result.retainedRows}` : ''}`, 'success');
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };
  const output = async (kind: 'xlsx' | 'csv' | 'clipboard' | 'office') => {
    if (!remembered) { await create(); return; }
    if (!(await save())) throw new Error('Книга не сохранена — выгрузка остановлена');
    const r = await fetch(`/api/office/files/${encodeURIComponent(remembered.file.id)}/open`);
    if (!r.ok) throw new Error('Не удалось прочитать сохранённую книгу');
    const bytes = await r.arrayBuffer();
    if (kind === 'office') { say(`Книга «${remembered.file.name}» сохранена в Проводнике → Выгрузки`, 'success'); return; }
    if (kind === 'xlsx') download(new Blob([bytes]), `${name.trim() || 'Выгрузка данных'}.xlsx`);
    else {
      const book = XLSX.read(bytes, { type: 'array' }); const sheet = book.Sheets[book.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false });
      const identity = book.Workbook?.Names?.find(n => n.Name === exportName('@header', '@identity'))?.Ref.match(/!\$?([A-Z]+)\$?\d+$/i);
      if (identity) { const col = XLSX.utils.decode_col(identity[1]); rows.forEach(row => row.splice(col, 1)); }
      if (kind === 'csv') download(new Blob([toCsv(rows[0] || [], rows.slice(1))], { type: 'text/csv;charset=utf-8' }), `${name.trim() || 'Выгрузка данных'}.csv`);
      else await navigator.clipboard.writeText(toClipboard(rows[0] || [], rows.slice(1)));
    }
    say('Выгружена сохранённая книга с вашими правками', 'success');
  };
  useImperativeHandle(ref, () => ({ save, output, template, applyTemplate, hasBook: () => !!remembered }));
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="fx-bar flex flex-wrap items-center gap-2 px-3 py-2">
      <Btn size="sm" tone="primary" onClick={refresh} disabled={busy || !valid}>{busy ? 'Подготовка…' : remembered ? 'Обновить данные в листе' : 'Создать рабочую книгу'}</Btn>
      {remembered && <Btn size="sm" tone="ghost" onClick={async () => { if (await save()) { setRemembered(null); localStorage.removeItem(storageKey); } }} disabled={busy}>Новая книга</Btn>}
      <span className="text-xs text-slate-500">{grid.rows.length} строк · {grid.headers.length} столбцов</span>
    </div>
    {error && <p role="alert" className="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    {grid.warnings.length > 0 && <details className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300"><summary>Проверьте данные · {grid.warnings.length}</summary><ul className="list-disc pl-4">{grid.warnings.slice(0, 20).map(w => <li key={w}>{w}</li>)}</ul></details>}
    {!valid && <p className="p-3 text-xs text-amber-600">Выберите столбцы и сократите отбор до 10 000 ячеек за одно обновление. Полную выгрузку можно получить кнопкой Excel до создания книги.</p>}
    {remembered ? <div className="flex-1 min-h-0"><OfficeAppEditor key={remembered.file.id} ref={editor} app="sheets" fileId={remembered.file.id} embedded /></div> : <div className="flex-1 overflow-auto p-3">
      <p className="mb-3 text-xs text-slate-500">Создайте книгу, чтобы вводить формулы, добавлять строки и столбцы. Она сохранится в «Выгрузках», и работа продолжится после закрытия окна.</p>
      <table className="fx-table"><thead><tr>{grid.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{grid.rows.slice(0, 30).map((row, i) => <tr key={grid.rowKeys[i]}>{row.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table>
    </div>}
  </div>;
});
export default ExportWorkbook;
