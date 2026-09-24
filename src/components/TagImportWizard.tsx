import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import {
  X, FileSpreadsheet, Download, ClipboardPaste, Folder as FolderIcon,
  ArrowLeft, Upload, Check, AlertTriangle, Loader2, Table2, Copy, GitMerge,
} from 'lucide-react';
import { dataService } from '../services/dataService';
import { useToastStore } from '../store/toastStore';
import { countOf } from '../lib/plural';
import { FIELDS, FIELD_LABEL, detectField, FieldKey as SharedFieldKey } from '../capture/fields';
import { useEscapeClose } from '../lib/useDismiss';

// Поля и угадывание колонок — общий модуль: тем же словарём разбирает
// таблицу захват с экрана (src/capture)
type FieldKey = SharedFieldKey;

interface Sheet { name: string; rows: string[][]; totalRows: number; }
interface Props {
  projectId: string;
  existingCodes: Set<string>;
  onClose: () => void;
  onImported: () => void;
}

export default function TagImportWizard({ projectId, existingCodes, onClose, onImported }: Props) {
  // Во время загрузки окно не закрываем: импорт уже идёт
  useEscapeClose(true, () => { if (!importing) onClose(); });

  const { addToast } = useToastStore();
  const [step, setStep] = useState<'source' | 'map'>('source');
  const [excelFiles, setExcelFiles] = useState<{ id: string; name: string; folder?: string }[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [headerRows, setHeaderRows] = useState<Record<number, number>>({});
  const [mappings, setMappings] = useState<Record<number, Record<number, FieldKey | ''>>>({});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importing, setImporting] = useState(false);
  const [dupDialog, setDupDialog] = useState<{ codes: string[] } | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; duplicates: string[] } | null>(null);

  // Список Excel-файлов из Проводника
  useEffect(() => {
    setLoadingFiles(true);
    (dataService.getFolders(projectId) as any)
      .then((res: any) => {
        const out: { id: string; name: string; folder?: string }[] = [];
        const isXls = (n: string) => /\.(xlsx|xls|csv)$/i.test(n || '');
        (res?.rootFiles || []).forEach((f: any) => { if (isXls(f.name)) out.push({ id: f.id, name: f.name }); });
        (res?.folders || []).forEach((fl: any) => (fl.files || []).forEach((f: any) => { if (isXls(f.name)) out.push({ id: f.id, name: f.name, folder: fl.name }); }));
        setExcelFiles(out);
      })
      .catch(() => setExcelFiles([]))
      .finally(() => setLoadingFiles(false));
  }, [projectId]);

  const autoDetectFor = (sheetList: Sheet[]) => {
    const maps: Record<number, Record<number, FieldKey | ''>> = {};
    const hdrs: Record<number, number> = {};
    sheetList.forEach((s, si) => {
      hdrs[si] = 0;
      const header = s.rows[0] || [];
      const m: Record<number, FieldKey | ''> = {};
      const used = new Set<FieldKey>();
      header.forEach((cell, ci) => {
        const f = detectField(cell);
        if (f && !used.has(f)) { m[ci] = f; used.add(f); } else m[ci] = '';
      });
      maps[si] = m;
    });
    return { maps, hdrs };
  };

  const openSheets = (sheetList: Sheet[], name: string) => {
    const { maps, hdrs } = autoDetectFor(sheetList);
    setSheets(sheetList);
    setMappings(maps);
    setHeaderRows(hdrs);
    setActiveSheet(0);
    setFileName(name);
    setResult(null);
    setStep('map');
  };

  const handlePickFile = async (fileId: string) => {
    setParsing(true);
    try {
      const res = await dataService.parseExcelSheets(fileId);
      if (!res.sheets?.length) { addToast('В файле нет данных', 'error'); return; }
      openSheets(res.sheets, res.fileName);
    } catch (e: any) {
      addToast(e?.message || 'Не удалось прочитать файл', 'error');
    } finally { setParsing(false); }
  };

  const handlePaste = () => {
    const text = pasteText.replace(/\r/g, '');
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (!lines.length) { addToast('Вставьте данные таблицы', 'error'); return; }
    const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',');
    const rows = lines.map(l => l.split(delim).map(c => c.trim()));
    openSheets([{ name: 'Вставка', rows, totalRows: rows.length }], 'Вставленные данные');
    setPasteOpen(false);
    setPasteText('');
  };

  const downloadTemplate = () => {
    const header = FIELDS.map(f => f.label);
    const example = ['В01-AHU-001', 'КЦКП-10', 'Приточная установка', 'ОВ', 'Воздух', '1.2.3', '', 'Актуально'];
    const child = ['В01-AHU-001-FAN', 'ВКР-4', 'Вентилятор', 'ОВ', 'Воздух', '1.2.3.1', 'В01-AHU-001', 'Актуально'];
    const ws = XLSX.utils.aoa_to_sheet([header, example, child]);
    ws['!cols'] = header.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Шаблон тегов');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Шаблон-импорта-тегов.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const sheet = sheets[activeSheet];
  const headerIdx = headerRows[activeSheet] ?? 0;
  const map = mappings[activeSheet] || {};
  const colCount = useMemo(() => sheet ? Math.max(0, ...sheet.rows.map(r => r.length)) : 0, [sheet]);

  const setColField = (col: number, field: FieldKey | '') => {
    setMappings(prev => {
      const cur = { ...(prev[activeSheet] || {}) };
      // одно поле — одна колонка: снимаем это поле с других колонок
      if (field) Object.keys(cur).forEach(k => { if (cur[+k] === field) cur[+k] = ''; });
      cur[col] = field;
      return { ...prev, [activeSheet]: cur };
    });
  };

  const buildRows = () => {
    if (!sheet) return [] as any[];
    const dataRows = sheet.rows.slice(headerIdx + 1);
    const built = dataRows.map(r => {
      const obj: any = {};
      Object.entries(map).forEach(([col, field]) => { if (field) obj[field] = (r[+col] ?? '').toString().trim(); });
      return obj;
    }).filter(o => (o.identifier || '').trim());
    return built;
  };

  const hasIdentifier = Object.values(map).includes('identifier');
  const previewRows = buildRows();

  const runImport = async (mode: 'add' | 'update') => {
    const rows = buildRows();
    if (!rows.length) { addToast('Нет строк для импорта (укажите колонку «Код тега»)', 'error'); return; }
    setImporting(true);
    setDupDialog(null);
    try {
      const res = await dataService.bulkImportTags(projectId, rows, mode);
      setResult(res);
      onImported();
      addToast(`Импортировано: создано ${res.created}, обновлено ${res.updated}`, 'success');
    } catch (e: any) {
      addToast(e?.message || 'Ошибка импорта', 'error');
    } finally { setImporting(false); }
  };

  const handleImportClick = () => {
    const rows = buildRows();
    if (!rows.length) { addToast('Нет строк для импорта (укажите колонку «Код тега»)', 'error'); return; }
    const codes = rows.map(r => (r.identifier || '').trim());
    const collisions = [...new Set(codes.filter(c => existingCodes.has(c)))];
    if (collisions.length) { setDupDialog({ codes: collisions }); return; }
    runImport('add');
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-hidden" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-950/55 backdrop-blur-md" onClick={() => !importing && onClose()} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          className="relative w-full max-w-5xl h-[88vh] flex flex-col rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden"
        >
          {/* HEADER */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {step === 'map' && (
                <button type="button" onClick={() => setStep('source')} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer">
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-slate-900 dark:text-white truncate">Импорт тегов из таблицы</h3>
                <p className="text-xs text-slate-500 truncate">{step === 'source' ? 'Выберите источник данных' : fileName}</p>
              </div>
            </div>
            <button type="button" onClick={() => !importing && onClose()} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* BODY */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {step === 'source' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <button type="button" onClick={() => setPasteOpen(true)} className="flex flex-col items-start gap-2 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 hover:border-emerald-400 dark:hover:border-emerald-600 transition-colors text-left cursor-pointer">
                    <ClipboardPaste className="w-5 h-5 text-emerald-600" />
                    <span className="text-sm font-bold text-slate-800 dark:text-white">Вставить из буфера</span>
                    <span className="text-xs text-slate-500">Скопируйте диапазон в Excel и вставьте сюда</span>
                  </button>
                  <button type="button" onClick={downloadTemplate} className="flex flex-col items-start gap-2 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 hover:border-emerald-400 dark:hover:border-emerald-600 transition-colors text-left cursor-pointer">
                    <Download className="w-5 h-5 text-emerald-600" />
                    <span className="text-sm font-bold text-slate-800 dark:text-white">Скачать шаблон</span>
                    <span className="text-xs text-slate-500">Готовый .xlsx с нужными колонками</span>
                  </button>
                  <div className="flex flex-col items-start gap-2 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-left">
                    <Table2 className="w-5 h-5 text-emerald-600" />
                    <span className="text-sm font-bold text-slate-800 dark:text-white">Файл из Проводника</span>
                    <span className="text-xs text-slate-500">Выберите загруженную таблицу ниже</span>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-bold text-slate-400 mb-2">Таблицы в Проводнике ({excelFiles.length})</div>
                  {loadingFiles ? (
                    <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Загрузка списка…</div>
                  ) : excelFiles.length === 0 ? (
                    <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                      Нет таблиц .xlsx / .xls / .csv в Проводнике.<br />Загрузите файл в раздел «Проводник» или вставьте данные из буфера.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {excelFiles.map(f => (
                        <button type="button" key={f.id} disabled={parsing} onClick={() => handlePickFile(f.id)} className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 hover:border-emerald-400 dark:hover:border-emerald-600 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20 transition-colors text-left cursor-pointer disabled:opacity-50">
                          <FileSpreadsheet className="w-5 h-5 text-emerald-600 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-800 dark:text-white truncate">{f.name}</div>
                            {f.folder && <div className="text-xs text-slate-400 flex items-center gap-1 min-w-0"><FolderIcon className="w-3 h-3 shrink-0" /> <span className="flex-1 min-w-0 truncate">{f.folder}</span></div>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {parsing && <div className="flex items-center gap-2 text-emerald-600 text-sm mt-3 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Чтение файла…</div>}
                </div>
              </div>
            )}

            {step === 'map' && sheet && (
              <>
                {/* CONTROLS */}
                <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-3 shrink-0 bg-slate-50/60 dark:bg-slate-950/40">
                  <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-semibold">Строка заголовков:</span>
                    <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                      <button type="button" onClick={() => setHeaderRows(p => ({ ...p, [activeSheet]: Math.max(0, headerIdx - 1) }))} className="px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">−</button>
                      <span className="px-2 font-mono font-bold">{headerIdx + 1}</span>
                      <button type="button" onClick={() => setHeaderRows(p => ({ ...p, [activeSheet]: Math.min(sheet.rows.length - 1, headerIdx + 1) }))} className="px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">+</button>
                    </div>
                  </div>
                  <button type="button"
                    onClick={() => {
                      const header = sheet.rows[headerIdx] || [];
                      const m: Record<number, FieldKey | ''> = {}; const used = new Set<FieldKey>();
                      header.forEach((cell, ci) => { const f = detectField(cell); if (f && !used.has(f)) { m[ci] = f; used.add(f); } else m[ci] = ''; });
                      setMappings(prev => ({ ...prev, [activeSheet]: m }));
                    }}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >Авто-определение колонок</button>
                  <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
                    {hasIdentifier
                      ? <span className="flex items-center gap-1 text-emerald-600"><Check className="w-3.5 h-3.5" /> Готово к импорту: {countOf(previewRows.length, 'строка')}</span>
                      : <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="w-3.5 h-3.5" /> Отметьте колонку «Код тега»</span>}
                  </div>
                </div>

                {/* GRID */}
                <div className="flex-1 min-h-0 overflow-auto">
                  <table className="text-xs border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr>
                        <th className="sticky left-0 z-20 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-1 text-slate-400 font-mono w-10">#</th>
                        {Array.from({ length: colCount }).map((_, ci) => {
                          const field = map[ci] || '';
                          return (
                            <th key={ci} className={`border border-slate-200 dark:border-slate-700 px-2 py-1.5 min-w-[150px] align-top ${field ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'bg-slate-50 dark:bg-slate-900'}`}>
                              <select
                                value={field}
                                onChange={(e) => setColField(ci, e.target.value as FieldKey | '')}
                                className={`w-full text-xs rounded-md px-1.5 py-1 border cursor-pointer focus:outline-none ${field ? 'border-emerald-400 dark:border-emerald-600 text-emerald-700 dark:text-emerald-300 font-bold bg-white dark:bg-slate-950' : 'border-slate-200 dark:border-slate-700 text-slate-400 bg-white dark:bg-slate-950'}`}
                              >
                                <option value="">— не импортировать —</option>
                                {FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                              </select>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(0, 60).map((row, ri) => {
                        const isHeader = ri === headerIdx;
                        const isBelow = ri > headerIdx;
                        return (
                          <tr key={ri} className={isHeader ? 'bg-amber-50 dark:bg-amber-950/20' : (isBelow ? '' : 'opacity-40')}>
                            <td onClick={() => setHeaderRows(p => ({ ...p, [activeSheet]: ri }))} title="Сделать строкой заголовков" className="sticky left-0 z-10 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2 py-1 text-slate-400 font-mono text-center cursor-pointer hover:text-emerald-600">{ri + 1}</td>
                            {Array.from({ length: colCount }).map((_, ci) => {
                              const field = map[ci] || '';
                              return (
                                <td key={ci} className={`border border-slate-100 dark:border-slate-800 px-2 py-1 max-w-[260px] truncate ${field && isBelow ? 'text-slate-800 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'} ${isHeader ? 'font-bold' : ''}`} title={row[ci]}>
                                  {row[ci]}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* SHEET TABS (как в Excel) */}
                {sheets.length > 1 && (
                  <div className="flex items-stretch gap-0.5 px-3 pt-1.5 border-t border-slate-100 dark:border-slate-800 overflow-x-auto shrink-0 bg-slate-100/60 dark:bg-slate-950/60">
                    {sheets.map((s, si) => (
                      <button type="button" key={si} onClick={() => setActiveSheet(si)} className={`px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap rounded-t-lg border-t border-x transition-colors cursor-pointer ${si === activeSheet ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-emerald-700 dark:text-emerald-300 -mb-px' : 'bg-transparent border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
                        {s.name} <span className="text-slate-400 font-normal">({Math.max(0, s.totalRows - 1)})</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* FOOTER */}
                <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
                  <div className="text-xs text-slate-500">
                    Лист «{sheet.name}» · колонок: {colCount} · строк данных: {Math.max(0, sheet.totalRows - 1)}
                  </div>
                  <button type="button"
                    onClick={handleImportClick}
                    disabled={importing || !hasIdentifier || previewRows.length === 0}
                    className="px-5 py-2.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 cursor-pointer"
                  >
                    {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    Импортировать {previewRows.length ? `(${previewRows.length})` : ''}
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>

      {/* PASTE MODAL */}
      <AnimatePresence>
        {pasteOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={() => setPasteOpen(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} className="relative w-full max-w-2xl bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2"><ClipboardPaste className="w-4 h-4 text-emerald-600" /> Вставка из буфера</h4>
                <button type="button" onClick={() => setPasteOpen(false)} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 cursor-pointer"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-slate-500 mb-2">Выделите диапазон ячеек в Excel, скопируйте (Ctrl+C) и вставьте сюда. Первая строка может быть заголовком.</p>
              <textarea autoFocus value={pasteText} onChange={e => setPasteText(e.target.value)} rows={10} placeholder={'Код тега\tМарка\tНаименование\nВ01-AHU-001\tКЦКП-10\tПриточная установка'} className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-mono text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500 resize-none" />
              <div className="flex justify-end gap-2 mt-3">
                <button type="button" onClick={() => setPasteOpen(false)} className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-sm font-semibold cursor-pointer">Отмена</button>
                <button type="button" onClick={handlePaste} className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-sm font-semibold cursor-pointer">Разобрать</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* DUPLICATE DIALOG */}
      <AnimatePresence>
        {dupDialog && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={() => setDupDialog(null)} />
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-5">
              <div className="flex items-center gap-2 mb-2 text-amber-600">
                <AlertTriangle className="w-5 h-5" />
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">Такие теги уже есть</h4>
              </div>
              <p className="text-xs text-slate-500 mb-2">Найдено совпадений по коду: <strong className="text-slate-700 dark:text-slate-300">{dupDialog.codes.length}</strong>. Что сделать с уже существующими тегами?</p>
              <div className="max-h-24 overflow-y-auto text-xs font-mono text-slate-500 bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 rounded-lg p-2 mb-4">
                {dupDialog.codes.slice(0, 30).join(', ')}{dupDialog.codes.length > 30 ? ' …' : ''}
              </div>
              <div className="space-y-2">
                <button type="button" onClick={() => runImport('update')} className="w-full flex items-center gap-2.5 px-4 py-3 rounded-xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 text-left cursor-pointer">
                  <GitMerge className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div><div className="text-sm font-bold text-slate-800 dark:text-white">Объединить</div><div className="text-xs text-slate-500">Обновить данные существующих тегов</div></div>
                </button>
                <button type="button" onClick={() => runImport('add')} className="w-full flex items-center gap-2.5 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800 text-left cursor-pointer">
                  <Copy className="w-5 h-5 text-slate-500 shrink-0" />
                  <div><div className="text-sm font-bold text-slate-800 dark:text-white">Задублировать</div><div className="text-xs text-slate-500">Добавить копии (будут выделены как дубли)</div></div>
                </button>
                <button type="button" onClick={() => setDupDialog(null)} className="w-full px-4 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-sm font-semibold cursor-pointer">Отмена</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* RESULT TOAST CARD */}
      <AnimatePresence>
        {result && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} className="relative w-full max-w-sm bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-600 mx-auto mb-3"><Check className="w-6 h-6" /></div>
              <h4 className="text-base font-bold text-slate-900 dark:text-white mb-1">Импорт завершён</h4>
              <p className="text-sm text-slate-500 mb-1">Создано: <strong className="text-emerald-600">{result.created}</strong> · Обновлено: <strong className="text-emerald-600">{result.updated}</strong></p>
              {result.duplicates.length > 0 && <p className="text-xs text-rose-500 mb-3">Дубли добавлены: {result.duplicates.length} (выделены в списках и дереве)</p>}
              <button type="button" onClick={onClose} className="mt-3 w-full px-4 py-2.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl text-sm font-bold cursor-pointer">Готово</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>,
    document.body
  );
}
