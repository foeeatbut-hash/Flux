import React from 'react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import {
  ArrowDown, ArrowUp, ClipboardCopy, Download, FileSpreadsheet, GripVertical, Plus, Save, Search, Table2, X,
} from 'lucide-react';
import { classById, classOrder } from '../../../equipment/classes';
import { equipmentColumns, type ExchangeComponent } from '../../lib/equipmentExchange';
import { toCsv, toClipboard, fileName } from '../../lib/exchange';
import { saveNewFile, editorHref } from '../../lib/officeFiles';
import {
  SERVICE_COLUMNS, ORDER_TITLE, PRESETS, applyPreset, paramSections, defaultSpec, exportTable, selectItems, specOf,
  type ExportColumn, type ExportOrder, type ExportSpec,
} from '../../lib/exportSpec';

/**
 * Выгрузка оборудования по шаблону — одно окно на четыре вопроса.
 *
 *   1. ЧТО: установка, категория или весь проект; типы и виды галочками со
 *      счётчиками; «только с тегом».
 *   2. СТОЛБЦЫ: шаблон или свои — служебные (тег, тег родителя, тип, вид,
 *      модель…) и характеристики выбранных типов; порядок перетаскиванием,
 *      заголовок правится прямо в строке.
 *   3. ПОРЯДОК: по тегу, «тип → тег» с заголовками групп, «установка → тег».
 *   4. КУДА: Excel, CSV, буфер обмена или таблица Flux Office — она остаётся
 *      связанной с проектом, и «Собрать» на листе потом обновляет значения.
 *
 * Живой предпросмотр — первые двадцать строк: результат виден до файла, а не
 * после. Правила (отбор, порядок, заголовки групп, разметка листа) — в
 * lib/exportSpec и проверяются scripts/test-export-builder.ts.
 */

interface Scope { id: string; label: string; count: number }
interface SavedView { id: string; name: string; scope: string; role: string; fields: { group: string; key: string; unit: string }[]; spec?: unknown }

interface Props {
  projectId: string;
  scopes: Scope[];
  /** Строки выбранного охвата — с типом и видом */
  rowsOf: (scopeId: string) => ExchangeComponent[];
  say: (text: string, kind?: 'success' | 'error' | 'info') => void;
  onClose: () => void;
}

const LAST_KEY = 'flux_export_last';

const download = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

export default function ExportBuilder({ projectId, scopes, rowsOf, say, onClose }: Props) {
  const navigate = useNavigate();
  // Прошлая выгрузка помнится у человека: обычно выгружают одно и то же, и
  // собирать столбцы заново каждый раз — та самая возня
  const last = React.useMemo(() => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (_) { return null; } }, []);
  const [scope, setScope] = React.useState(scopes.some((s) => s.id === last?.scope) ? last.scope : (scopes[0]?.id || 'all'));
  const [spec, setSpec] = React.useState<ExportSpec>(() => (last?.spec ? specOf(last.spec) : defaultSpec()));
  React.useEffect(() => {
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ scope, spec })); } catch (_) { /* приватный режим */ }
  }, [scope, spec]);
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [viewId, setViewId] = React.useState('');
  const [q, setQ] = React.useState('');
  const [drag, setDrag] = React.useState<string | null>(null);
  const [saveName, setSaveName] = React.useState('');
  const [personal, setPersonal] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const loadViews = React.useCallback(() => {
    fetch('/api/equipment/view-templates').then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.views) setViews(d.views); }).catch(() => { /* полка шаблонов пуста */ });
  }, []);
  React.useEffect(loadViews, [loadViews]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = React.useMemo(() => rowsOf(scope), [rowsOf, scope]);
  // Счётчики типов и видов — по охвату, без учёта уже выбранного отбора:
  // иначе, отметив приводы, человек не увидел бы, сколько там вентиляторов
  const classCounts = React.useMemo(() => {
    const m = new Map<string, { n: number; kinds: Map<string, number> }>();
    for (const it of items) {
      const c = String(it.cls || 'ПРОЧЕЕ');
      const x = m.get(c) || { n: 0, kinds: new Map() };
      x.n++;
      if (it.kind) x.kinds.set(it.kind, (x.kinds.get(it.kind) || 0) + 1);
      m.set(c, x);
    }
    return [...m.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0]));
  }, [items]);
  const inScope = React.useMemo(() => selectItems(items, { ...spec, columns: [] }), [items, spec]);
  // Характеристики — только выбранных типов: у привода нет «Расхода воздуха»
  const known = React.useMemo(() => equipmentColumns(inScope).filter((c) => c.key.startsWith('param:')), [inScope]);
  const table = React.useMemo(() => exportTable(items, spec, known), [items, spec, known]);

  const set = (patch: Partial<ExportSpec>) => { setSpec((s) => ({ ...s, ...patch })); };
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hasCol = (key: string) => spec.columns.some((c) => c.key === key);
  const addCol = (c: ExportColumn) => { if (!hasCol(c.key)) set({ columns: [...spec.columns, c] }); };
  const dropCol = (key: string) => set({ columns: spec.columns.filter((c) => c.key !== key) });
  const moveCol = (from: string, to: string) => {
    const list = spec.columns.filter((c) => c.key !== from);
    const at = list.findIndex((c) => c.key === to);
    const it = spec.columns.find((c) => c.key === from);
    if (at < 0 || !it) return;
    const down = spec.columns.findIndex((c) => c.key === from) < spec.columns.findIndex((c) => c.key === to);
    list.splice(down ? at + 1 : at, 0, it);
    set({ columns: list });
  };
  const stepCol = (key: string, dir: -1 | 1) => {
    const i = spec.columns.findIndex((c) => c.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= spec.columns.length) return;
    const list = [...spec.columns];
    [list[i], list[j]] = [list[j], list[i]];
    set({ columns: list });
  };
  const rename = (key: string, label: string) => set({ columns: spec.columns.map((c) => (c.key === key ? { ...c, label } : c)) });

  const pickView = (id: string) => {
    setViewId(id);
    const v = views.find((x) => x.id === id);
    if (!v) { setSpec(defaultSpec()); return; }
    setSpec(specOf(v.spec, v));
    setSaveName(v.name);
  };

  const saveView = async (overwrite: boolean) => {
    const name = saveName.trim();
    if (!name) { say('У шаблона должно быть имя', 'error'); return; }
    const fields = spec.columns.filter((c) => c.key.startsWith('param:')).map((c) => {
      const [group, key] = c.key.slice(6).split('|');
      return { group, key, unit: c.unit || '' };
    });
    const body = { name, scope: personal ? 'PERSONAL' : 'SHARED', role: spec.classes.length === 1 ? spec.classes[0] : '', fields, spec };
    const res = await fetch(overwrite && viewId ? `/api/equipment/view-templates/${viewId}` : '/api/equipment/view-templates', {
      method: overwrite && viewId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) { say(data?.error || 'Не удалось сохранить шаблон', 'error'); return; }
    if (data?.view?.id) setViewId(data.view.id);
    loadViews();
    say(`Шаблон «${name}» сохранён — он есть и в Таблице, полка «Шаблоны вида»`, 'success');
  };

  const run = async (target: 'xlsx' | 'csv' | 'clipboard' | 'office') => {
    if (!table.count) { say('Не попала ни одна строка — снимите часть отбора', 'error'); return; }
    if (!spec.columns.length) { say('Выберите хотя бы один столбец', 'error'); return; }
    setBusy(true);
    try {
      if (target === 'clipboard') {
        await navigator.clipboard.writeText(toClipboard(table.headers, table.rows));
        say(`Скопировано строк: ${table.count}`, 'success');
        return;
      }
      if (target === 'csv') {
        download(new Blob([toCsv(table.headers, table.rows)], { type: 'text/csv;charset=utf-8;' }), fileName(saveName.trim() || 'Оборудование', 'csv'));
        say('Выгружено в CSV', 'success');
        return;
      }
      // В Таблицу — без заголовков групп: собранный лист пишет строки подряд
      const flat = target === 'office' ? exportTable(items, { ...spec, groupHeaders: false }, known) : table;
      const sheet = XLSX.utils.aoa_to_sheet([flat.headers, ...flat.rows]);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Оборудование');
      const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      if (target === 'xlsx') {
        download(new Blob([out], { type: 'application/octet-stream' }), fileName(saveName.trim() || 'Оборудование', 'xlsx'));
        say(`Выгружено строк: ${flat.count}`, 'success');
        return;
      }
      // В Таблицу Flux Office — настоящий .xlsx в «Выгрузках» на своём столе:
      // тот же файл откроет и Excel. Раньше здесь заводилась запись
      // Конструктора, которую вне Flux открыть было нечем
      const made = await saveNewFile(out, fileName(saveName.trim() || 'Оборудование', 'xlsx'), 'exports');
      say(`Выгружено строк: ${flat.count} — файл «${made.name}» в «Выгрузках»`, 'success');
      onClose();
      navigate(editorHref(made));
    } catch (e: any) {
      say(`Не удалось выгрузить: ${e?.message || e}`, 'error');
    } finally { setBusy(false); }
  };

  const needle = q.trim().toLowerCase();
  // Характеристики по разделам карточки, с числом позиций, у которых они заполнены
  const sections = React.useMemo(() => paramSections(inScope, known), [inScope, known]);
  const sectionsShown = sections
    .map((sec) => ({ ...sec, params: sec.params.filter((x) => !needle || x.label.toLowerCase().includes(needle) || sec.title.toLowerCase().includes(needle)) }))
    .filter((sec) => sec.params.length);
  const addSection = (sec: typeof sections[number]) =>
    set({ columns: [...spec.columns, ...sec.params.filter((x) => !hasCol(x.key)).map((x) => ({ key: x.key, label: x.label, unit: x.unit }))] });
  const label = 'text-2xs font-semibold text-slate-400';
  const chip = (on: boolean) => `px-2 py-0.5 rounded-full text-2xs font-semibold border cursor-pointer ${on
    ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 fx-backdrop" onMouseDown={onClose}>
      <div role="dialog" aria-label="Выгрузка оборудования по шаблону" onMouseDown={(e) => e.stopPropagation()}
        className="fx-dialog @container w-full max-w-6xl h-[min(780px,92vh)] flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Download className="w-4 h-4 text-emerald-600" />
          <b className="text-sm">Выгрузка оборудования</b>
          <select value={viewId} onChange={(e) => pickView(e.target.value)} aria-label="Шаблон"
            className="ml-2 px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 max-w-[260px]">
            <option value="">Без шаблона — свои столбцы</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}{v.scope === 'PERSONAL' ? ' · личный' : ''}</option>)}
          </select>
          <span className="flex-1" />
          <span className="text-2xs text-slate-400 tabular-nums">{table.count} строк · {spec.columns.length} столбцов</span>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="p-1 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>

        {/* В узком окне три колонки встают друг под другом и листаются целиком,
            а не сжимаются до нечитаемых полосок */}
        <div className="flex-1 min-h-0 overflow-y-auto @[980px]:overflow-hidden grid grid-cols-1 @[980px]:grid-cols-[230px_300px_1fr] @[980px]:grid-rows-[minmax(0,1fr)]">
          {/* 1. Что */}
          <div className="border-b @[980px]:border-b-0 @[980px]:border-r border-slate-100 dark:border-slate-800 @[980px]:overflow-y-auto p-3 space-y-3">
            <div className={label}>Что выгружаем</div>
            <div className="flex flex-col gap-1">
              {scopes.map((s) => (
                <button key={s.id} type="button" onClick={() => setScope(s.id)}
                  className={`text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${scope === s.id ? 'bg-emerald-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {s.label} <span className="opacity-70 tabular-nums">({s.count})</span>
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" className="accent-emerald-600" checked={spec.taggedOnly} onChange={(e) => set({ taggedOnly: e.target.checked })} />
              только позиции с тегом
            </label>
            <div className={label}>Типы {spec.classes.length ? '' : '· все'}</div>
            <div className="space-y-1.5">
              {classCounts.map(([cls, x]) => (
                <div key={cls}>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" className="accent-emerald-600" checked={spec.classes.includes(cls)}
                      onChange={() => set({ classes: toggleIn(spec.classes, cls), kinds: spec.classes.includes(cls) ? spec.kinds.filter((k) => !x.kinds.has(k)) : spec.kinds })} />
                    <span className="flex-1">{classById(cls).plural}</span>
                    <span className="text-2xs text-slate-400 tabular-nums">{x.n}</span>
                  </label>
                  {spec.classes.includes(cls) && x.kinds.size > 0 && (
                    <div className="ml-5 mt-1 flex flex-wrap gap-1">
                      {[...x.kinds.entries()].map(([k, n]) => (
                        <button key={k} type="button" className={chip(spec.kinds.includes(k))} onClick={() => set({ kinds: toggleIn(spec.kinds, k) })}>
                          {k} <span className="opacity-70">{n}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className={label}>Порядок строк</div>
            <div className="flex flex-col gap-1">
              {(Object.keys(ORDER_TITLE) as ExportOrder[]).map((o) => (
                <label key={o} className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="radio" name="export-order" className="accent-emerald-600" checked={spec.order === o} onChange={() => set({ order: o })} />
                  {ORDER_TITLE[o]}
                </label>
              ))}
              <label className={`flex items-center gap-2 text-xs cursor-pointer ${spec.order === 'class-tag' ? '' : 'opacity-40'}`}>
                <input type="checkbox" className="accent-emerald-600" disabled={spec.order !== 'class-tag'} checked={spec.groupHeaders}
                  onChange={(e) => set({ groupHeaders: e.target.checked })} />
                строка-заголовок у каждого типа
              </label>
            </div>
          </div>

          {/* 2. Столбцы */}
          <div className="border-b @[980px]:border-b-0 @[980px]:border-r border-slate-100 dark:border-slate-800 flex flex-col @[980px]:min-h-0">
            <div className="p-3 space-y-1 overflow-y-auto flex-1 min-h-0">
              <div className={label}>Быстрые наборы</div>
              <div className="flex flex-wrap gap-1 pb-2">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" className={chip(false)} onClick={() => setSpec((s) => applyPreset(s, p.id))}
                    title="Поставить эти служебные столбцы; выбранные характеристики останутся">{p.title}</button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <div className={`${label} flex-1`}>Столбцы — порядок перетаскиванием</div>
                {spec.columns.length > 0 && (
                  <button type="button" onClick={() => set({ columns: [] })} className="text-2xs text-slate-400 hover:text-rose-500 cursor-pointer">очистить</button>
                )}
              </div>
              {spec.columns.length === 0 && <div className="text-2xs text-slate-400 py-2">Выберите быстрый набор или добавьте столбцы ниже.</div>}
              {spec.columns.map((c) => (
                <div key={c.key} draggable onDragStart={() => setDrag(c.key)} onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => { if (drag && drag !== c.key) e.preventDefault(); }}
                  onDrop={() => { if (drag) moveCol(drag, c.key); setDrag(null); }}
                  className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border ${drag === c.key ? 'border-emerald-400' : 'border-slate-150 dark:border-slate-800'}`}>
                  <GripVertical className="w-3.5 h-3.5 text-slate-300 cursor-grab shrink-0" aria-hidden />
                  <span className="flex-1 min-w-0">
                    <input value={c.label} onChange={(e) => rename(c.key, e.target.value)} aria-label="Заголовок столбца"
                      className="w-full bg-transparent text-xs outline-none focus:ring-1 focus:ring-emerald-400 rounded px-1" />
                    {c.key.startsWith('param:') && <span className="block px-1 text-2xs text-slate-400 truncate">{c.key.slice(6).split('|')[0]}</span>}
                  </span>
                  {c.unit ? <span className="text-2xs text-slate-400 shrink-0">{c.unit}</span> : null}
                  <button type="button" onClick={() => stepCol(c.key, -1)} aria-label="Левее" className="p-0.5 text-slate-400 hover:text-emerald-600 cursor-pointer"><ArrowUp className="w-3 h-3" /></button>
                  <button type="button" onClick={() => stepCol(c.key, 1)} aria-label="Правее" className="p-0.5 text-slate-400 hover:text-emerald-600 cursor-pointer"><ArrowDown className="w-3 h-3" /></button>
                  <button type="button" onClick={() => dropCol(c.key)} aria-label="Убрать столбец" className="p-0.5 text-slate-400 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
            <div className="border-t border-slate-100 dark:border-slate-800 p-3 space-y-2 max-h-[45%] overflow-y-auto">
              <div className={label}>Служебные</div>
              <div className="flex flex-wrap gap-1">
                {SERVICE_COLUMNS.map((c) => (
                  <button key={c.key} type="button" disabled={hasCol(c.key)} onClick={() => addCol({ ...c })}
                    className={`${chip(false)} disabled:opacity-35 disabled:cursor-default`}>
                    <Plus className="inline w-2.5 h-2.5" /> {c.label}
                  </button>
                ))}
              </div>
              <div className={label}>Характеристики {spec.classes.length ? 'выбранных типов' : ''}</div>
              <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700">
                <Search className="w-3.5 h-3.5 text-slate-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Мощность, расход…" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
              </label>
              <div className="space-y-2">
                {sectionsShown.map((sec) => (
                  <div key={sec.title}>
                    <div className="flex items-center gap-2 px-1">
                      <span className="flex-1 min-w-0 text-xs font-medium text-slate-500 dark:text-slate-400 break-words">{sec.title}</span>
                      <button type="button" onClick={() => addSection(sec)} disabled={sec.params.every((x) => hasCol(x.key))}
                        className="shrink-0 text-2xs text-emerald-600 hover:text-emerald-700 cursor-pointer disabled:opacity-35 disabled:cursor-default">+ весь раздел</button>
                    </div>
                    {sec.params.slice(0, 120).map((x) => (
                      <button key={x.key} type="button" disabled={hasCol(x.key)}
                        onClick={() => addCol({ key: x.key, label: x.label, unit: x.unit })}
                        className="w-full flex items-start gap-1.5 text-left px-2 py-1 rounded-lg text-xs hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer disabled:opacity-35 disabled:cursor-default">
                        <Plus className="w-3 h-3 mt-0.5 text-emerald-600 shrink-0" />
                        <span className="flex-1 min-w-0 break-words">{x.label}{x.unit ? <span className="text-slate-400">, {x.unit}</span> : null}</span>
                        <span className="text-2xs text-slate-400 shrink-0 tabular-nums" title="У скольких позиций значение заполнено">у {x.count}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {sectionsShown.length === 0 && <div className="text-2xs text-slate-400">Нет характеристик{needle ? ' по запросу' : ''}.</div>}
              </div>
            </div>
          </div>

          {/* 3. Предпросмотр */}
          <div className="flex flex-col min-w-0 min-h-[320px] @[980px]:min-h-0">
            <div className="px-3 py-2 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800">
              <span className={label}>Предпросмотр</span>
              <span className="text-2xs text-slate-400">первые 20 строк из {table.count}</span>
              {table.problems.length > 0 && (
                <span className="text-2xs text-amber-600 dark:text-amber-400" title={table.problems.slice(0, 5).map((p) => `${p.tag}: ${p.column} — ${p.why}`).join('\n')}>
                  · значений не приведено к единице: {table.problems.length}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              <table className="text-xs border-collapse">
                <thead className="sticky top-0 bg-white dark:bg-slate-950">
                  <tr>{table.headers.map((h, i) => <th key={i} className="px-2 py-1.5 text-left border-b border-slate-200 dark:border-slate-800 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, 20).map((r, i) => (
                    table.groupRows.includes(i)
                      ? <tr key={i}><td colSpan={Math.max(1, table.headers.length)} className="px-2 pt-2 pb-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">{r[0]}</td></tr>
                      : <tr key={i} className="border-b border-slate-100 dark:border-slate-850">{r.map((v, j) => <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[240px] truncate">{v}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {table.count === 0 && <div className="text-xs text-slate-400 text-center py-8">Не попала ни одна строка — снимите часть отбора.</div>}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
          <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Имя шаблона"
            className="px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-48" />
          <label className="flex items-center gap-1 text-2xs text-slate-500 cursor-pointer">
            <input type="checkbox" className="accent-emerald-600" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />личный
          </label>
          <button type="button" onClick={() => saveView(false)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-emerald-400">
            <Save className="w-3.5 h-3.5" />Сохранить шаблон
          </button>
          {viewId && (
            <button type="button" onClick={() => saveView(true)} className="px-2.5 py-1.5 rounded-lg text-xs text-slate-500 hover:text-emerald-600 cursor-pointer">
              перезаписать выбранный
            </button>
          )}
          <span className="flex-1" />
          <button type="button" disabled={busy} onClick={() => run('clipboard')} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 cursor-pointer disabled:opacity-50"><ClipboardCopy className="w-3.5 h-3.5" />В буфер</button>
          <button type="button" disabled={busy} onClick={() => run('csv')} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 cursor-pointer disabled:opacity-50"><FileSpreadsheet className="w-3.5 h-3.5" />CSV</button>
          <button type="button" disabled={busy} onClick={() => run('office')} title="Файл .xlsx в «Выгрузках» на вашем столе — сразу откроется Таблицей Flux Office"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 cursor-pointer disabled:opacity-50"><Table2 className="w-3.5 h-3.5" />В таблицу Flux Office</button>
          <button type="button" disabled={busy} onClick={() => run('xlsx')} className="fx-btn fx-btn-primary fx-btn-sm"><Download className="w-3.5 h-3.5" />Excel</button>
        </div>
      </div>
    </div>
  );
}
