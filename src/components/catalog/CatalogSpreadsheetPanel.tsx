import React, { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { Download, FileSpreadsheet, RotateCcw, Upload } from 'lucide-react';
import type { Catalog } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { saveBytes } from '../../lib/saveToWindows';
import { Btn, Chip } from './ui';

type Role = 'model' | 'manufacturer' | 'type' | 'name' | 'key' | 'source' | 'edition' | 'ignore' | 'param' | 'parameter' | 'value' | 'unit' | 'class' | 'family' | 'pages';
type Policy = 'add' | 'fill' | 'update';
type SheetInput = { name: string; rows: unknown[][] };
type PlanRow = {
  row: number; sheet: string; code?: string; manufacturer?: string;
  action: 'new' | 'update' | 'same' | 'conflict' | 'error';
  changes: Array<{ field: string; before: unknown; after: unknown }>; error?: string;
};
type Plan = { planId: string; rows: PlanRow[]; counts: Record<string, number> };

const ROLES: Array<{ value: Role; label: string }> = [
  { value: 'model', label: 'Модель' }, { value: 'manufacturer', label: 'Изготовитель' },
  { value: 'type', label: 'Тип' }, { value: 'name', label: 'Наименование' },
  { value: 'key', label: 'Ключ' }, { value: 'source', label: 'Источник' },
  { value: 'edition', label: 'Редакция' }, { value: 'param', label: 'Характеристика' },
  { value: 'parameter', label: 'Название параметра' }, { value: 'value', label: 'Значение параметра' },
  { value: 'unit', label: 'Единица измерения' }, { value: 'class', label: 'Тип оборудования (ID)' },
  { value: 'family', label: 'Модель (ID)' }, { value: 'pages', label: 'Страницы источника' },
  { value: 'ignore', label: 'Не загружать' },
];
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'Каталог';
const splitParamHeader = (header: string) => {
  const m = /^(.*?)\s*(?:\[([^\]]+)\]|,\s*([^,]+))$/.exec(header.trim());
  return { label: m ? m[1].trim() : header.trim(), unit: m ? (m[2] || m[3]).trim() : '' };
};

async function api<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let value: any;
  try { value = await res.json(); } catch { value = undefined; }
  if (!res.ok) throw new Error(value?.error || value?.message || `Сервер ответил ${res.status}`);
  if (value?.error) throw new Error(value.error);
  return value as T;
}

function csvRows(source: string): unknown[][] {
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const delimiterCounts = new Map([[',', 0], [';', 0], ['\t', 0]]);
  let sniffQuoted = false;
  for (let i = 0; i < firstLine.length; i++) {
    if (firstLine[i] === '"' && firstLine[i + 1] === '"' && sniffQuoted) { i++; continue; }
    if (firstLine[i] === '"') sniffQuoted = !sniffQuoted;
    else if (!sniffQuoted && delimiterCounts.has(firstLine[i])) delimiterCounts.set(firstLine[i], delimiterCounts.get(firstLine[i])! + 1);
  }
  const delimiter = [...delimiterCounts].sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [[]];
  let field = ''; let quoted = false;
  const pushField = () => { if (field.length > 1_000_000) throw new Error('Ячейка CSV превышает 1 МБ'); rows[rows.length - 1].push(field); field = ''; };
  const pushRow = () => {
    pushField();
    if (rows[rows.length - 1].length > 100) throw new Error('В CSV допускается не более 100 столбцов');
    if (rows.length > 50_000) throw new Error('В CSV допускается не более 50 000 строк');
    rows.push([]);
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === delimiter) pushField();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') field += ch;
  }
  if (quoted) throw new Error('В CSV не закрыты кавычки');
  if (field || rows[rows.length - 1].length) pushRow();
  if (!rows[rows.length - 1].length) rows.pop();
  return rows;
}

function excelCellValue(raw: ExcelJS.CellValue): unknown {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw !== 'object') return raw;
  if ('formula' in raw || 'sharedFormula' in raw) {
    const result = 'result' in raw ? raw.result : undefined;
    return result === undefined ? '__FORMULA_NO_RESULT__' : excelCellValue(result as ExcelJS.CellValue);
  }
  if ('richText' in raw) return raw.richText.map((part) => part.text).join('');
  if ('text' in raw && typeof raw.text === 'string') return raw.text;
  return String(raw);
}

async function xlsxSheets(file: File): Promise<SheetInput[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  if (workbook.worksheets.length > 50) throw new Error('Допускается не более 50 листов');
  let totalRows = 0;
  return workbook.worksheets.map((worksheet) => {
    const rowCount = worksheet.rowCount;
    const columnCount = worksheet.columnCount;
    if (rowCount > 50_000) throw new Error(`Лист «${worksheet.name}»: более 50 000 строк`);
    if (columnCount > 100) throw new Error(`Лист «${worksheet.name}»: более 100 столбцов`);
    totalRows += rowCount;
    if (totalRows > 50_000) throw new Error('Во всём файле допускается до 50 000 строк');
    const rows: unknown[][] = [];
    for (let r = 1; r <= rowCount; r++) {
      const row = worksheet.getRow(r);
      rows.push(Array.from({ length: columnCount }, (_, c) => excelCellValue(row.getCell(c + 1).value)));
    }
    return { name: worksheet.name, rows };
  });
}

function templateBytes(catalog: Catalog): Uint8Array {
  const classId = catalog.classes[0]?.id || '';
  const familyId = catalog.families.find((f) => f.classId === classId)?.id || '';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Ключ модели', 'Тип', 'Изготовитель', 'Модель', 'Наименование', 'Источник', 'Редакция'],
    ['EXAMPLE-001', 'Привод', 'Пример', 'Модель привода', 'Наименование модели', 'Каталог производителя', '2026'],
  ]), 'Модели');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Ключ модели', 'Параметр', 'Значение', 'Единица'], ['EXAMPLE-001', 'Напряжение', '24', 'В'],
  ]), 'Характеристики');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Ключ комплектующего', 'Тип оборудования', 'Модель'], ['EXAMPLE-001', classId, familyId],
  ]), 'Применяемость');
  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
}

function exportBytes(catalog: Catalog, classId: string): Uint8Array {
  const list = catalog.components.filter((c) => c.classId === classId || c.classIds?.includes(classId));
  const wb = XLSX.utils.book_new();
  const models: unknown[][] = [['Ключ модели', 'Тип', 'Изготовитель', 'Модель', 'Наименование', 'Источник', 'Редакция']];
  const params: unknown[][] = [['Ключ модели', 'Параметр', 'Значение', 'Единица']];
  const uses: unknown[][] = [['Ключ комплектующего', 'Тип оборудования', 'Модель']];
  for (const c of list) {
    // The external key joins all three sheets; model codes can collide across
    // manufacturers, while the component id remains unique across the catalog.
    const key = c.id;
    const ref = c.catalog;
    models.push([key, c.equipmentType || c.kind, c.manufacturer || catalog.manufacturers.find((m) => m.id === c.manufacturerId)?.name || '', c.code, textOf(c.title), ref?.file || '', ref?.edition || '']);
    for (const s of c.specs || []) params.push([key, textOf(s.label), s.value, s.unit || '']);
    const classIds = [...new Set([c.classId, ...(c.classIds || [])])];
    if (c.familyIds?.length) {
      for (const cid of classIds) for (const fid of c.familyIds) uses.push([key, cid, fid]);
    } else {
      for (const cid of classIds) uses.push([key, cid, '']);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(models), 'Модели');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(params), 'Характеристики');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(uses), 'Применяемость');
  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
}

export default function CatalogSpreadsheetPanel({ catalog, classId, canEdit }: { catalog: Catalog; classId: string; canEdit: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sheets, setSheets] = useState<SheetInput[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [paramNames, setParamNames] = useState<Record<string, { label: string; unit: string }>>({});
  const [policy, setPolicy] = useState<Policy>('add');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [batchId, setBatchId] = useState('');

  const headers = useMemo(() => {
    const out: string[] = [];
    for (const sh of sheets.filter((s) => chosen.includes(s.name))) for (const h of sh.rows[0] || []) {
      const name = String(h ?? '').trim(); if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }, [sheets, chosen]);
  const eligible = useMemo(() => plan?.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.action === 'new' || r.action === 'update') || [], [plan]);

  const readFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(''); setMessage(''); setPlan(null); setBatchId('');
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('Файл больше 15 МБ. Разделите таблицу на несколько файлов.');
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (!['xlsx', 'csv'].includes(ext || '')) throw new Error('Поддерживаются .xlsx и .csv. Сохраните книгу .xls в формате .xlsx.');
      const parsed = ext === 'csv' ? [{ name: file.name, rows: csvRows(await file.text()) }] : await xlsxSheets(file);
      for (const sh of parsed) {
        const width = sh.rows.reduce((n, row) => Math.max(n, row.length), 0);
        const height = sh.rows.length;
        if (width > 100) throw new Error(`Лист «${sh.name}»: ${width} столбцов. Допускается не более 100.`);
        if (height > 50000) throw new Error(`Лист «${sh.name}»: ${height} строк. Допускается не более 50 000.`);
      }
      setSheets(parsed); setChosen(parsed.map((s) => s.name));
      const header = parsed[0]?.rows[0] || [];
      const guess: Record<string, string> = {};
      const names: Record<string, { label: string; unit: string }> = {};
      for (const raw of header) {
        const h = String(raw || '').trim(); if (!h) continue;
        const lower = h.toLocaleLowerCase('ru');
        const param = splitParamHeader(h);
        guess[h] = lower.includes('изготов') || lower.includes('производ') ? 'manufacturer'
          : lower.includes('ключ') ? 'key' : lower.includes('модель') && lower.includes('id') ? 'family' : lower === 'тип' ? 'type'
          : lower.includes('модель') || lower.includes('код') ? 'model'
          : lower.includes('наимен') ? 'name' : lower.includes('источник') ? 'source'
          : lower.includes('редак') ? 'edition'
          : lower === 'параметр' ? 'parameter' : lower === 'значение' ? 'value'
          : lower.includes('единиц') ? 'unit' : lower.includes('класс оборудования') ? 'class'
          : lower.includes('семейств') ? 'family' : lower.includes('страниц') ? 'pages' : 'param';
        names[h] = param;
      }
      setMapping(guess);
      setParamNames(names);
      setMessage(`Файл «${file.name}»: листов ${parsed.length}. Выберите листы и сопоставьте заголовки.`);
    } catch (e: any) { setError(e?.message || 'Не удалось прочитать Excel'); setSheets([]); setChosen([]); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const makePlan = async () => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const chosenSheets = sheets.filter((s) => chosen.includes(s.name));
      const rowsCount = chosenSheets.reduce((n, s) => n + s.rows.length, 0);
      const columns = chosenSheets.reduce((n, s) => Math.max(n, ...s.rows.map((r) => r.length)), 0);
      if (!chosenSheets.length) throw new Error('Выберите хотя бы один лист');
      if (rowsCount > 50000) throw new Error(`Выбрано ${rowsCount} строк. Допускается не более 50 000.`);
      if (columns > 100) throw new Error(`В данных ${columns} столбцов. Допускается не более 100.`);
      const mappedSheets = chosenSheets.map((sheet) => ({ ...sheet, rows: sheet.rows.map((row) => [...row]) }));
      const mappingForPlan = { ...mapping };
      for (const sheet of mappedSheets) {
        const headerRow = sheet.rows[0];
        if (!headerRow) continue;
        headerRow.forEach((raw, col) => {
          const h = String(raw ?? '').trim();
          if (!h || mapping[h] !== 'param') return;
          const def = paramNames[h];
          if (def?.label) {
            headerRow[col] = def.unit ? `${def.label} [${def.unit}]` : def.label;
            mappingForPlan[String(headerRow[col])] = 'param';
          }
        });
      }
      const result = await api<Plan>('/api/catalog/spreadsheet/plan', { sheets: mappedSheets, classId, policy, mapping: mappingForPlan });
      setPlan(result);
      setSelected(result.rows.map((r, i) => r.action === 'new' || r.action === 'update' ? i : -1).filter((i) => i >= 0));
      setMessage(`Проверено строк: ${result.rows.length}. Отметьте строки для загрузки.`);
    } catch (e: any) { setError(e?.message || 'Не удалось проверить данные'); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!plan || busy || !selected.length) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ batchId: string; count: number }>('/api/catalog/spreadsheet/apply', { planId: plan.planId, indices: selected });
      setBatchId(result.batchId); setMessage(`Создан черновик для ${result.count} моделей. Опубликованные данные пока не изменены.`);
    } catch (e: any) { setError(e?.message || 'Не удалось загрузить данные'); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!batchId || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ undoneDrafts?: number }>('/api/catalog/spreadsheet/undo', { batchId });
      setBatchId('');
      setMessage(`Черновик отменён. Отменено записей: ${result.undoneDrafts || 0}. Опубликованный каталог не затронут.`);
    }
    catch (e: any) { setError(e?.message || 'Не удалось отменить загрузку'); }
    finally { setBusy(false); }
  };

  const download = async (kind: 'template' | 'export') => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const bytes = kind === 'template' ? templateBytes(catalog) : exportBytes(catalog, classId);
      const saved = await saveBytes(kind === 'template' ? 'Шаблон-каталога.xlsx' : `${safeName('Каталог')}.xlsx`, bytes);
      if (saved.ok) setMessage(saved.path ? `Сохранено: ${saved.path}` : 'Файл сохранён');
      else if (!saved.canceled) throw new Error(saved.error || 'Не удалось сохранить файл');
    } catch (e: any) { setError(e?.message || 'Не удалось собрать Excel'); }
    finally { setBusy(false); }
  };

  const allSelected = !!eligible.length && eligible.every(({ i }) => selected.includes(i));
  const conflicts = plan?.rows.filter((r) => r.action === 'conflict').length || 0;
  const unchanged = plan?.rows.filter((r) => r.action === 'same').length || 0;
  return <section className="flex h-full min-h-0 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-emerald-600" /><b className="text-sm">Обмен с Excel</b></div>
      <Btn tone="ghost" disabled={busy} onClick={() => void download('template')}><Download className="h-3.5 w-3.5" /> Скачать шаблон</Btn>
      <Btn tone="ghost" disabled={busy} onClick={() => void download('export')}><Download className="h-3.5 w-3.5" /> Выгрузить Excel</Btn>
      {canEdit && <><input ref={inputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
        <Btn disabled={busy} onClick={() => inputRef.current?.click()}><Upload className="h-3.5 w-3.5" /> Загрузить Excel</Btn></>}
    </div>
    <div className="text-xs text-slate-500 dark:text-slate-400">Тип оборудования: <span className="font-medium text-slate-700 dark:text-slate-300">{textOf(catalog.classes.find((c) => c.id === classId)?.title) || classId || 'не выбран'}</span></div>
    <div className="text-xs text-slate-500 dark:text-slate-400">Импорт создаёт черновики компонентов и изготовителей. В общий Каталог они попадут только после публикации.</div>
    {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error}</div>}
    {message && <div role="status" className="rounded-md bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{message}</div>}
    {sheets.length > 0 && canEdit && <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <b>Листы</b>{sheets.map((s) => <label key={s.name} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={chosen.includes(s.name)} disabled={busy} onChange={(e) => setChosen((old) => e.target.checked ? [...old, s.name] : old.filter((n) => n !== s.name))} />{s.name}<span className="text-slate-400">({Math.max(0, s.rows.length - 1)})</span></label>)}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <b>Режим</b>{([{ value: 'add', label: 'Добавить' }, { value: 'fill', label: 'Заполнить пустые' }, { value: 'update', label: 'Обновить' }] as const).map((x) => <label key={x.value} className="inline-flex items-center gap-1.5"><input type="radio" name="catalog-spreadsheet-policy" checked={policy === x.value} disabled={busy} onChange={() => setPolicy(x.value)} />{x.label}</label>)}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {headers.map((h) => <div key={h} className="flex min-w-0 flex-col gap-1.5 rounded-md bg-slate-50 p-2 dark:bg-slate-800/60">
          <label className="flex min-w-0 items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate" title={h}>{h}</span><select value={mapping[h] || 'ignore'} disabled={busy} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))} className="max-w-[170px] rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800">{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
          {mapping[h] === 'param' && <div className="flex items-center gap-1.5"><input aria-label={`Название характеристики для ${h}`} value={paramNames[h]?.label || ''} disabled={busy} onChange={(e) => setParamNames((old) => ({ ...old, [h]: { label: e.target.value, unit: old[h]?.unit || '' } }))} placeholder="Название характеристики" className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-2xs dark:border-slate-700 dark:bg-slate-800" /><input aria-label={`Единица измерения для ${h}`} value={paramNames[h]?.unit || ''} disabled={busy} onChange={(e) => setParamNames((old) => ({ ...old, [h]: { label: old[h]?.label || h, unit: e.target.value } }))} placeholder="Единица" className="w-20 rounded border border-slate-200 bg-white px-1.5 py-1 text-2xs dark:border-slate-700 dark:bg-slate-800" /></div>}
        </div>)}
      </div>
      <div className="flex items-center gap-2"><Btn disabled={busy || !headers.length} onClick={() => void makePlan()}>{busy ? 'Проверяю…' : 'Проверить и показать план'}</Btn><span className="text-2xs text-slate-400">До 50 000 строк и 100 столбцов. Формулы не вычисляются.</span></div>
    </div>}
    {plan && <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs"><b>Предпросмотр</b><Chip tone="emerald">Выбрано: {selected.length}</Chip><Chip tone={conflicts ? 'rose' : 'slate'}>Конфликтов: {conflicts}</Chip><Chip>Без изменений: {unchanged}</Chip>{Object.entries(plan.counts || {}).map(([k, v]) => <Chip key={k} tone={k === 'error' || k === 'conflict' ? 'rose' : 'slate'}>{k}: {v}</Chip>)}<span className="flex-1" /><label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={allSelected} disabled={!eligible.length || busy} onChange={() => setSelected(allSelected ? [] : eligible.map(({ i }) => i))} />Выбрать допустимые ({eligible.length})</label></div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full min-w-[850px] border-collapse text-left text-xs"><thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><tr><th className="p-2">Загрузка</th><th className="p-2">Лист / строка</th><th className="p-2">Ключ / изготовитель</th><th className="p-2">Действие</th><th className="p-2">Изменение · было → станет</th><th className="p-2">Ошибка</th></tr></thead><tbody>
          {plan.rows.map((r, i) => <tr key={`${r.sheet}-${r.row}-${i}`} className="border-t border-slate-100 align-top dark:border-slate-800"><td className="p-2"><input type="checkbox" checked={selected.includes(i)} disabled={busy || (r.action !== 'new' && r.action !== 'update')} onChange={(e) => setSelected((old) => e.target.checked ? [...old, i] : old.filter((n) => n !== i))} aria-label={`Загрузить строку ${r.row}`} /></td><td className="p-2 whitespace-nowrap">{r.sheet} · {r.row}</td><td className="p-2">{r.code || '—'}<div className="text-slate-400">{r.manufacturer || ''}</div></td><td className="p-2">{r.action}</td><td className="p-2">{r.changes?.length ? r.changes.map((c, j) => <div key={j} className="mb-1"><span className="text-slate-500">{c.field}: </span><span className="text-slate-400">{String(c.before ?? '—')}</span> <span className="text-slate-400">→</span> <span>{String(c.after ?? '—')}</span></div>) : '—'}</td><td className="p-2 text-rose-600 dark:text-rose-400">{r.error || (r.action === 'conflict' ? 'Конфликт — исправьте исходные данные' : '')}</td></tr>)}
          {!plan.rows.length && <tr><td colSpan={6} className="p-5 text-center text-slate-400">Строк для проверки нет</td></tr>}
        </tbody></table>
      </div>
      <div className="flex flex-wrap items-center gap-2"><Btn disabled={busy || !selected.length || !canEdit} onClick={() => void apply()}>{busy ? 'Создаю черновик…' : `Создать черновик (${selected.length})`}</Btn>{batchId && <Btn tone="ghost" disabled={busy} onClick={() => void undo()}><RotateCcw className="h-3.5 w-3.5" /> Отменить черновик</Btn>}</div>
    </div>}
  </section>;
}
