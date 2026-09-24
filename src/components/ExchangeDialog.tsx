/**
 * Экспорт и импорт — одно окно на всю программу.
 *
 * Заменяет полосы «Экспорт и импорт», где все варианты разложены сразу и
 * занимают экран целиком: «слишком много места, чтобы что-то найти, нужно
 * постоянно двигать мышкой вниз» — дословная просьба владельца.
 *
 * Вопросов на самом деле три: что выгружаем, куда и какие столбцы. Они
 * помещаются в одно окно без прокрутки. Четвёртая строка — сколько получится —
 * не украшение: без неё человек нажимает «Выгрузить» и узнаёт результат из
 * файла, а если результат не тот, повторяет всё заново.
 *
 * Разделы дают окну только свои столбцы и способ собрать строки. Само окно про
 * теги, оборудование и справочник ничего не знает — иначе оно превратилось бы
 * в третье место, где описан каждый раздел.
 */
import React from 'react';
import { Download, Upload, ClipboardCopy, X, Loader2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useToastStore } from '../store/toastStore';
import {
  summary, blocker, toCsv, toClipboard, fileName, pickColumns,
  TARGET_LABEL, type Target, type Scope, type Column,
} from '../lib/exchange';

export interface ExchangeProps {
  /** Раздел — им подписано окно и назван файл */
  section: string;
  scopes: Scope[];
  columns: Column[];
  /** Столбцы, отмеченные при открытии; пусто — все */
  defaultColumns?: string[];
  /** Собрать строки: раздел знает, откуда их взять */
  build: (scopeId: string, columns: Column[]) => { headers: string[]; rows: (string | number)[][] };
  /** Разбор входящего файла остаётся у раздела: там сверка и предпросмотр */
  onImport?: () => void;
  importHint?: string;
  onClose: () => void;
}

export default function ExchangeDialog(p: ExchangeProps) {
  const { addToast } = useToastStore();
  const [scope, setScope] = React.useState(p.scopes[0]?.id || '');
  const [target, setTarget] = React.useState<Target>('xlsx');
  const [chosen, setChosen] = React.useState<string[]>(
    p.defaultColumns?.length ? p.defaultColumns : p.columns.map((c) => c.key),
  );
  const [busy, setBusy] = React.useState(false);
  const [colsOpen, setColsOpen] = React.useState(false);

  const rows = p.scopes.find((s) => s.id === scope)?.count ?? 0;
  const cols = pickColumns(p.columns, chosen);
  const stop = blocker(rows, cols.length);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  const toggleCol = (key: string) =>
    setChosen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const run = async () => {
    if (stop) { addToast(stop, 'error'); return; }
    setBusy(true);
    try {
      const table = p.build(scope, cols);
      if (target === 'clipboard') {
        await navigator.clipboard.writeText(toClipboard(table.headers, table.rows));
        addToast(`Скопировано: ${table.rows.length} строк`, 'success');
        p.onClose();
        return;
      }
      const name = fileName(p.section, target);
      if (target === 'csv') {
        download(new Blob([toCsv(table.headers, table.rows)], { type: 'text/csv;charset=utf-8;' }), name);
      } else {
        const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, p.section.slice(0, 28) || 'Данные');
        const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
        download(new Blob([out], { type: 'application/octet-stream' }), name);
      }
      addToast(`Выгружено: ${name}`, 'success');
      p.onClose();
    } catch (err: any) {
      addToast(`Не удалось выгрузить: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/50 p-4"
      onMouseDown={p.onClose}>
      <div
        role="dialog"
        aria-label={`Экспорт · ${p.section}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-950 border border-slate-200
                   dark:border-slate-800 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Download className="w-4 h-4 text-emerald-600" />
          <b className="text-sm font-bold text-slate-800 dark:text-white">Экспорт · {p.section}</b>
          <span className="flex-1" />
          <button type="button" onClick={p.onClose} aria-label="Закрыть"
            className="p-1 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Что */}
          <div className="flex items-start gap-3">
            <span className="w-20 shrink-0 pt-1.5 text-2xs font-bold text-slate-400">Что</span>
            <div className="flex-1 flex flex-wrap gap-1.5">
              {p.scopes.map((s) => (
                <button key={s.id} type="button" onClick={() => setScope(s.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-2xs font-bold cursor-pointer border transition-ui ${
                    scope === s.id
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                  }`}>
                  {s.label} <span className="opacity-70 tabular-nums">({s.count})</span>
                </button>
              ))}
            </div>
          </div>

          {/* Куда */}
          <div className="flex items-start gap-3">
            <span className="w-20 shrink-0 pt-1.5 text-2xs font-bold text-slate-400">Куда</span>
            <div className="flex-1 flex flex-wrap gap-1.5">
              {(['xlsx', 'csv', 'clipboard'] as Target[]).map((t) => (
                <button key={t} type="button" onClick={() => setTarget(t)}
                  className={`px-2.5 py-1.5 rounded-lg text-2xs font-bold cursor-pointer border transition-ui ${
                    target === t
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                  }`}>
                  {TARGET_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Столбцы — свёрнуты: их много, а меняют их редко */}
          <div className="flex items-start gap-3">
            <span className="w-20 shrink-0 pt-1.5 text-2xs font-bold text-slate-400">Столбцы</span>
            <div className="flex-1 min-w-0">
              <button type="button" onClick={() => setColsOpen((v) => !v)}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-2xs bg-slate-50 dark:bg-slate-900
                           border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-150
                           cursor-pointer truncate">
                {cols.length ? cols.map((c) => c.label).join(' · ') : 'ни одного'}
              </button>
              {colsOpen && (
                <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-slate-200
                                dark:border-slate-800 p-1.5 grid grid-cols-2 gap-0.5">
                  {p.columns.map((c) => (
                    <label key={c.key}
                      className="flex items-center gap-1.5 px-1.5 py-1 rounded text-2xs cursor-pointer
                                 text-slate-700 dark:text-slate-150 hover:bg-slate-100 dark:hover:bg-slate-850">
                      <input type="checkbox" checked={chosen.includes(c.key)} onChange={() => toggleCol(c.key)}
                        className="accent-emerald-600 cursor-pointer" />
                      <span className="truncate">{c.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Сколько получится — до нажатия, а не после */}
          <p className="pt-1 border-t border-slate-100 dark:border-slate-850 text-2xs font-semibold
                        text-slate-500 dark:text-slate-400">
            {summary(rows, cols.length)}
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800
                        bg-slate-50 dark:bg-slate-900">
          {p.onImport && (
            <button type="button" onClick={() => { p.onClose(); p.onImport?.(); }}
              title={p.importHint || 'Загрузить данные из файла'}
              className="px-3 py-1.5 rounded-lg text-2xs font-bold border border-slate-200 dark:border-slate-800
                         text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-850
                         cursor-pointer flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Загрузить из файла
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={p.onClose}
            className="px-3 py-1.5 rounded-lg text-2xs font-bold text-slate-500 hover:bg-white
                       dark:hover:bg-slate-850 cursor-pointer">
            Отмена
          </button>
          <button type="button" onClick={run} disabled={!!stop || busy}
            title={stop || undefined}
            className="px-4 py-1.5 rounded-lg text-2xs font-bold bg-emerald-600 hover:bg-emerald-500
                       text-white disabled:opacity-50 cursor-pointer flex items-center gap-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : target === 'clipboard' ? <ClipboardCopy className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
            {target === 'clipboard' ? 'Скопировать' : 'Выгрузить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
