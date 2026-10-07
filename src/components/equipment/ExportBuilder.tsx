import React from 'react';
import ExportWorkbook, { type ExportWorkbookHandle } from './ExportWorkbook';
import ExportE3Button from './ExportE3Button';
import { usePaneId } from '../../lib/paneTitle';
import { guardClose } from '../../lib/closeGuard';
import { useStore } from '../../store/store';
import { exportDraftKey, parseExportDraft, railWidth, saveAfterExportOperation } from '../../lib/exportWorkspace';
import { exportGrid } from '../../lib/exportGrid';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import {
  ArrowDown, ArrowUp, ChevronRight, ClipboardCopy, Download, FileSpreadsheet, GripVertical, Plus, Save, Search, Table2, X, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { classById, classOrder } from '../../../equipment/classes';
import { equipmentColumns, type ExchangeComponent } from '../../lib/equipmentExchange';
import { toCsv, toClipboard, fileName } from '../../lib/exchange';
import { saveNewFile, editorHref } from '../../lib/officeFiles';
import {
  SERVICE_COLUMNS, ORDER_TITLE, PRESETS, applyPreset, paramSections, defaultSpec, selectItems, specOf,
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
 * Рабочая книга открывается вместе с программой. Отбор отделён от обновления
 * ячеек, чтобы настройки не затирали ручные значения и формулы. Правила отбора
 * и структуры листа лежат в lib/exportSpec и lib/exportGrid.
 */

interface Scope { id: string; label: string; count: number }
interface SavedView { id: string; name: string; scope: string; role: string; fields: { group: string; key: string; unit: string }[]; spec?: unknown; hasWorkbook?: boolean }

interface Props {
  projectId: string;
  scopes: Scope[];
  /** Строки выбранного охвата — с типом и видом */
  rowsOf: (scopeId: string) => ExchangeComponent[];
  say: (text: string, kind?: 'success' | 'error' | 'info') => void;
  onClose: () => void;
  initialScope?: string;
  projectName?: string;
}


const download = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

export default function ExportBuilder({ projectId, scopes, rowsOf, say, onClose, initialScope, projectName }: Props) {
  const navigate = useNavigate();
  const workbook = React.useRef<ExportWorkbookHandle>(null);
  const pane = usePaneId();
  const viewPending = React.useRef<Promise<void> | null>(null);
  const saveWorkbook = async () => saveAfterExportOperation(viewPending.current, async () => !workbook.current || await workbook.current.save());
  const close = async () => { if (await saveWorkbook()) onClose(); else say('Книга не записана — окно остаётся открытым', 'error'); };
  React.useEffect(() => {
    if (!pane.startsWith('win:')) return;
    return guardClose(pane.slice(4), saveWorkbook);
  }, [pane]);
  const userId = useStore(s => s.user?.id || 'anonymous');
  const draftKey = exportDraftKey(projectId, userId);
  const last = React.useMemo(() => { try { return parseExportDraft(localStorage.getItem(draftKey)); } catch { return null; } }, [draftKey]);
  const [showFilters, setShowFilters] = React.useState(last?.railOpen ?? true);
  const [rail, setRail] = React.useState(last?.railWidth || 288);
  const [tab, setTab] = React.useState<'source' | 'columns' | 'group' | 'templates'>(last?.tab || 'source');
  const body = React.useRef<HTMLDivElement>(null);
  const [scope, setScope] = React.useState(() => scopes.some(s => s.id === initialScope) ? initialScope! : scopes.some(s => s.id === last?.scope) ? last!.scope : scopes[0]?.id || 'all');
  const [spec, setSpec] = React.useState<ExportSpec>(() => last?.spec ? specOf(last.spec) : defaultSpec());
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [viewId, setViewId] = React.useState('');
  const viewLoad = React.useRef(0);
  const viewBusyRef = React.useRef(false);
  const [viewBusy, setViewBusy] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [drag, setDrag] = React.useState<string | null>(null);
  const [saveName, setSaveName] = React.useState(last?.name || 'Выгрузка данных');
  const [personal, setPersonal] = React.useState(last?.personal ?? true);
  const [busy, setBusy] = React.useState(false);

  const loadViews = React.useCallback(() => {
    fetch('/api/equipment/view-templates').then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.views) setViews(d.views); }).catch(() => { /* полка шаблонов пуста */ });
  }, []);
  React.useEffect(loadViews, [loadViews]);
  React.useEffect(() => {
    if (viewId) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ scope, spec, name: saveName, personal, tab, railOpen: showFilters, railWidth: rail })); } catch { /* исходная книга сохраняется отдельно от черновика */ }
  }, [draftKey, scope, spec, saveName, personal, tab, showFilters, rail, viewId]);

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
  const grid = React.useMemo(() => exportGrid(items, spec, known, spec.grid), [items, spec, known]);
  const table = { headers: grid.headers, rows: grid.rows, count: grid.rows.length, groupRows: [], problems: [] as any[] };

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
    if (viewBusyRef.current) return;
    viewBusyRef.current = true;
    setViewBusy(true);
    const request = ++viewLoad.current;
    const previousViewId = viewId;
    const pending = (async () => {
      try {
        setViewId(id);
        const v = views.find((x) => x.id === id);
        if (!v) {
          let draft = null;
          try { draft = parseExportDraft(localStorage.getItem(draftKey)); } catch { /* если хранилище недоступно, остаётся текущая настройка */ }
          if (draft) {
            setSpec(draft.spec); setSaveName(draft.name || 'Выгрузка данных'); setPersonal(draft.personal);
            if (scopes.some((x) => x.id === draft.scope)) setScope(draft.scope);
            setTab(draft.tab);
          }
          return;
        }
        const next = specOf(v.spec, v);
        let workbookTemplate;
        try {
          if (v.hasWorkbook) {
            const response = await fetch(`/api/equipment/view-templates/${encodeURIComponent(id)}/workbook`);
            if (!response.ok) throw new Error('Не удалось прочитать книгу шаблона');
            const data = await response.json();
            workbookTemplate = data.workbookTemplate;
          }
        }
        catch (e: any) { setViewId(previousViewId); say(e.message, 'error'); return; }
        if (viewLoad.current !== request) return;
        try { if (workbookTemplate) await workbook.current?.applyTemplate(workbookTemplate); }
        catch (e: any) { setViewId(previousViewId); say(e.message, 'error'); return; }
        if (viewLoad.current !== request) return;
        setSpec(next);
        setSaveName(v.name);
      } finally {
        viewBusyRef.current = false;
        setViewBusy(false);
      }
    })();
    viewPending.current = pending;
    const clearPending = () => { if (viewPending.current === pending) viewPending.current = null; };
    void pending.then(clearPending, clearPending);
    return pending;
  };

  const saveView = async (overwrite: boolean) => {
    const name = saveName.trim();
    if (!name) { say('У шаблона должно быть имя', 'error'); return; }
    const fields = spec.columns.filter((c) => c.key.startsWith('param:')).map((c) => {
      const [group, key] = c.key.slice(6).split('|');
      return { group, key, unit: c.unit || '' };
    });
    let workbookTemplate;
    try { workbookTemplate = await workbook.current?.template(); }
    catch (e: any) { say(e.message, 'error'); return; }
    const savedSpec = { ...spec, workbookTemplate };
    const body = { name, scope: personal ? 'PERSONAL' : 'SHARED', role: spec.classes.length === 1 ? spec.classes[0] : '', fields, spec: savedSpec };
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
      if (workbook.current?.hasBook()) { await workbook.current.output(target); return; }
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
      const flat = table;
      const sheet = XLSX.utils.aoa_to_sheet([flat.headers, ...flat.rows]);
      grid.rows.forEach((row, i) => grid.formulas.forEach(j => { if (row[j]?.startsWith('=')) sheet[XLSX.utils.encode_cell({ r: i + 1, c: j })] = { t: 'n', f: row[j].slice(1) }; }));
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
      const made = await saveNewFile(out, fileName(saveName.trim() || 'Оборудование', 'xlsx'), 'exports', undefined, projectId);
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
  const label = 'text-xs font-medium text-slate-600 dark:text-slate-300';
  const chip = (on: boolean) => `px-2 py-0.5 rounded-full text-2xs font-semibold border cursor-pointer ${on
    ? 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`;

  return (
    <div aria-label="Выгрузка данных" className="@container flex h-full min-h-0 min-w-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <header className="fx-head flex-wrap gap-y-2 px-3 py-2" style={{ height: 'auto', minHeight: 44 }}>
        <span className="fx-head-title">Выгрузка данных</span>
        <span className="fx-head-count truncate" title={projectName}>{projectName || 'Оборудование проекта'}</span>
        <div className="fx-head-acts">
          <button type="button" disabled={viewBusy} className="fx-btn fx-btn-quiet" onClick={() => void close()}>К оборудованию</button>
          <button type="button" disabled={busy || !table.count || !spec.columns.length} onClick={() => run('xlsx')} className="fx-btn fx-btn-primary"><Download className="w-4 h-4" />Скачать Excel</button>
        </div>
      </header>
      <div className="fx-tools flex-wrap gap-2 px-3 py-2">
        <button type="button" className="fx-btn fx-btn-quiet" aria-expanded={showFilters} onClick={() => setShowFilters(v => !v)}>
          {showFilters ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}Параметры выгрузки
        </button>
        <select value={viewId} disabled={viewBusy} onChange={e => void pickView(e.target.value)} aria-label="Шаблон выгрузки" className="fx-input min-w-0 max-w-[260px]">
          <option value="">Текущий черновик</option>
          {views.map(v => <option key={v.id} value={v.id}>{v.name}{v.scope === 'PERSONAL' ? ' · личный' : ''}</option>)}
        </select>
        <span className="flex-1" />
        <button type="button" disabled={busy} onClick={() => run('clipboard')} className="fx-btn fx-btn-quiet"><ClipboardCopy className="w-4 h-4" />В буфер</button>
        <button type="button" disabled={busy} onClick={() => run('csv')} className="fx-btn fx-btn-quiet"><FileSpreadsheet className="w-4 h-4" />CSV</button>
        <button type="button" disabled={busy} onClick={() => run('office')} className="fx-btn"><Table2 className="w-4 h-4" />Сохранить книгу</button>
      </div>
      <div ref={body} className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        {showFilters && <>
        <aside aria-label="Параметры выгрузки" className="fx-side flex min-h-0 shrink-0 flex-col" style={{ width: `min(${rail}px, max(184px, 30cqw))` }}>
          <div role="tablist" aria-label="Шаги выгрузки" className="fx-tabs grid h-auto shrink-0 grid-cols-2 gap-1 px-2 py-1.5">
            {([['source', 'Данные', 'Данные'], ['columns', 'Столбцы', 'Столбцы'], ['group', 'Объединение', 'Группы'], ['templates', 'Шаблоны', 'Шаблоны']] as const).map(([id, title, shortTitle], index) => <button type="button" key={id} role="tab" aria-label={title} aria-selected={tab === id} className="fx-tab min-h-8 justify-center whitespace-nowrap" onClick={() => setTab(id)}><span aria-hidden="true" className="mr-1 tabular-nums text-slate-500 dark:text-slate-400">{index + 1}.</span>{shortTitle}</button>)}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {/* 1. Что */}
          <div hidden={tab !== 'source'} className="p-3 space-y-3">
            <div className={label}>Что выгружаем</div>
            <div className="flex flex-col gap-1">
              {scopes.map((s) => (
                <button key={s.id} type="button" onClick={() => setScope(s.id)}
                  className={`text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${scope === s.id ? 'bg-slate-100 dark:bg-slate-800 font-medium' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
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
                  <input type="radio" name={`export-order-${pane || projectId}`} className="accent-emerald-600" checked={spec.order === o} onChange={() => set({ order: o })} />
                  {ORDER_TITLE[o]}
                </label>
              ))}

            </div>

          </div>

            <section hidden={tab !== 'group'} className="p-3 space-y-2">
              <h2 className="fx-group-title">Повторы и объединение</h2>
              <label className="flex items-center gap-2 text-xs my-2"><input type="checkbox" checked={!!spec.grid?.deduplicate} onChange={e => set({ grid: { ...spec.grid, deduplicate: e.target.checked } })} />Убрать полностью одинаковые строки</label>
              <div className="text-xs text-slate-500 mb-2">Объединить по выбранным столбцам. Остальные значения сохраняются списком; отмеченные числовые поля складываются.</div>
              {spec.columns.filter(c => !c.key.startsWith('formula:')).map(c => <div key={c.key} className="flex items-center gap-2 text-xs py-1">
                <label className="flex-1"><input type="checkbox" checked={spec.grid?.groupBy?.includes(c.key) || false} onChange={() => set({ grid: { ...spec.grid, groupBy: toggleIn(spec.grid?.groupBy || [], c.key) } })} /> {c.label}</label>
                <label title="Сложить значения"><input type="checkbox" checked={spec.grid?.sums?.includes(c.key) || false} disabled={spec.grid?.groupBy?.includes(c.key)} onChange={() => set({ grid: { ...spec.grid, sums: toggleIn(spec.grid?.sums || [], c.key) } })} /> Σ</label>
              </div>)}
              <label className="flex items-center gap-2 text-xs my-2"><input type="checkbox" checked={spec.grid?.blankRepeats?.includes('parentTag') || false} onChange={e => set({ grid: { ...spec.grid, blankRepeats: e.target.checked ? ['parentTag', 'unitTag'] : [] } })} />Показать повторяющегося родителя один раз</label>
            </section>
          {/* 2. Столбцы */}
          <div className="flex flex-col" style={{ display: tab === 'columns' ? 'flex' : 'none' }}>
            <div className="p-3 space-y-1">
              <div className={label}>Быстрые наборы</div>
              <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => setSpec(s => ({ ...applyPreset(s, 'tree'), classes: ['КЛАПАН', 'ПРИВОД'], taggedOnly: false }))}>Клапаны и их приводы</button>
              <div className="flex flex-col items-stretch gap-1 pb-2">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" className={`${chip(false)} w-full text-left`} onClick={() => setSpec((s) => applyPreset(s, p.id))}
                    title="Поставить эти служебные столбцы; выбранные характеристики останутся">{p.title}</button>
                ))}
              </div>
              <ExportE3Button chosenClasses={spec.classes} scopeClasses={classCounts.map(([c]) => c)} say={say}
                onApply={(columns, order) => setSpec((s) => ({ ...s, columns, order }))} />
              <div className="flex items-center gap-2">
                <div className={`${label} flex-1`}>Столбцы</div>
                {spec.columns.length > 0 && (
                  <button type="button" onClick={() => set({ columns: [] })} className="text-2xs text-slate-400 hover:text-rose-500 cursor-pointer">очистить</button>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Перетаскивайте для изменения порядка.</p>
              {spec.columns.length === 0 && <div className="text-2xs text-slate-400 py-2">Выберите быстрый набор или добавьте столбцы ниже.</div>}
              {spec.columns.map((c) => (
                <div key={c.key} draggable onDragStart={() => setDrag(c.key)} onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => { if (drag && drag !== c.key) e.preventDefault(); }}
                  onDrop={() => { if (drag) moveCol(drag, c.key); setDrag(null); }}
                  className={`flex flex-wrap items-center gap-1 px-1.5 py-1 rounded-lg border ${drag === c.key ? 'border-emerald-400' : 'border-slate-150 dark:border-slate-800'}`}>
                  <div className="flex w-full min-w-0 items-center gap-1">
                  <GripVertical className="w-3.5 h-3.5 text-slate-300 cursor-grab shrink-0" aria-hidden />
                  <span className="flex-1 min-w-0">
                    <input value={c.label} onChange={(e) => rename(c.key, e.target.value)} aria-label="Заголовок столбца" title={c.label}
                      className="w-full min-w-0 bg-transparent text-xs outline-none focus:ring-1 focus:ring-emerald-400 rounded px-1" />
                  </span>
                  </div>
                  {c.key.startsWith('formula:') && <input aria-label="Формула столбца" className="fx-input order-last w-full text-xs" placeholder="=SUM(D{row}:F{row})" value={c.formula || ''} onChange={e => set({ columns: spec.columns.map(x => x.key === c.key ? { ...x, formula: e.target.value } : x) })} />}
                  <span className="min-w-0 flex-1 truncate pl-5 text-2xs text-slate-500 dark:text-slate-400" title={c.key.startsWith('param:') ? c.key.slice(6).split('|')[0] : undefined}>
                    {c.key.startsWith('param:') ? c.key.slice(6).split('|')[0] : ''}{c.unit ? ` · ${c.unit}` : ''}
                  </span>
                  <button type="button" onClick={() => stepCol(c.key, -1)} aria-label="Левее" className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:text-emerald-700 dark:text-slate-400 dark:hover:text-emerald-400 cursor-pointer"><ArrowUp className="w-3 h-3" /></button>
                  <button type="button" onClick={() => stepCol(c.key, 1)} aria-label="Правее" className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:text-emerald-700 dark:text-slate-400 dark:hover:text-emerald-400 cursor-pointer"><ArrowDown className="w-3 h-3" /></button>
                  <button type="button" onClick={() => dropCol(c.key)} aria-label="Убрать столбец" className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 cursor-pointer"><X className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
              <div className="border-t border-slate-100 dark:border-slate-800 p-3 space-y-2 ">
                <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => addCol({ key: `formula:${crypto.randomUUID()}`, label: 'Расчёт', formula: '=SUM(D{row}:F{row})' })}>+ Столбец с формулой</button>
              <details>
                <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">Служебные поля · {SERVICE_COLUMNS.length}</summary>
                <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                  {SERVICE_COLUMNS.map((c) => (
                    <button key={c.key} type="button" disabled={hasCol(c.key)} onClick={() => addCol({ ...c })}
                      className="flex min-h-8 w-full items-center gap-2 px-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-default">
                      <Plus className="w-3 h-3 shrink-0 text-emerald-700 dark:text-emerald-400" /><span className="min-w-0 flex-1 truncate">{c.label}</span>
                    </button>
                  ))}
                </div>
              </details>
              <div className={label}>Характеристики {spec.classes.length ? 'выбранных типов' : ''}</div>
              <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700">
                <Search className="w-3.5 h-3.5 text-slate-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Мощность, расход…" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
              </label>
              <div className="space-y-2">
                {sectionsShown.map((sec) => (
                  <details key={sec.title} className="group/section border-b border-slate-100 dark:border-slate-800" open={!!needle || undefined}>
                      <summary className="flex min-h-8 min-w-0 list-none items-center gap-2 px-1 cursor-pointer [&::-webkit-details-marker]:hidden">
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform group-open/section:rotate-90" />
                        <span className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-300 truncate" title={sec.title}>{sec.title}</span>
                        <span className="text-2xs text-slate-400 tabular-nums">{sec.params.length}</span>
                      </summary>
                      <button type="button" onClick={() => addSection(sec)} disabled={sec.params.every((x) => hasCol(x.key))}
                        className="shrink-0 text-2xs text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 cursor-pointer disabled:opacity-35 disabled:cursor-default">Добавить</button>
                    {sec.params.slice(0, 120).map((x) => (
                      <button key={x.key} type="button" disabled={hasCol(x.key)}
                        onClick={() => addCol({ key: x.key, label: x.label, unit: x.unit })}
                        className="w-full flex items-start gap-1.5 text-left px-2 py-1 rounded text-xs hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-35 disabled:cursor-default">
                        <Plus className="w-3 h-3 mt-0.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
                        <span className="flex-1 min-w-0 break-words">{x.label}{x.unit ? <span className="text-slate-500 dark:text-slate-400">, {x.unit}</span> : null}</span>
                        <span className="text-2xs text-slate-500 dark:text-slate-400 shrink-0 tabular-nums" title="У скольких позиций значение заполнено">{x.count}</span>
                      </button>
                    ))}
                  </details>
                ))}
                {sectionsShown.length === 0 && <div className="text-2xs text-slate-400">Нет характеристик{needle ? ' по запросу' : ''}.</div>}
              </div>
            </div>
          </div>
          <section hidden={tab !== 'templates'} className="p-3 space-y-3">
            <h2 className="fx-group-title">Сохранить состав выгрузки</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Шаблон запоминает отбор, столбцы, формулы и оформление рабочей книги. Черновик этого проекта сохраняется автоматически.</p>
          <input value={saveName} disabled={viewBusy} onChange={(e) => setSaveName(e.target.value)} placeholder="Имя книги и шаблона" aria-label="Имя книги и шаблона"
            className="px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-full" />
          <label className="flex items-center gap-1 text-2xs text-slate-500 cursor-pointer">
            <input type="checkbox" disabled={viewBusy} className="accent-emerald-600" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />личный
          </label>
          <button type="button" disabled={viewBusy} onClick={() => saveView(false)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 cursor-pointer hover:border-emerald-400">
            <Save className="w-3.5 h-3.5" />Сохранить шаблон
          </button>
          {viewId && (
            <button type="button" disabled={viewBusy} onClick={() => saveView(true)} className="px-2.5 py-1.5 rounded-lg text-xs text-slate-500 hover:text-emerald-600 cursor-pointer disabled:opacity-40">
              перезаписать выбранный
            </button>
          )}

          </section>
          </div>
        </aside>
        <div role="separator" aria-label="Ширина параметров" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={480} aria-valuenow={rail} tabIndex={0}
          className="w-1 shrink-0 cursor-col-resize touch-none bg-slate-200 hover:bg-slate-400 focus:bg-emerald-500 dark:bg-slate-800 dark:hover:bg-slate-600"
          onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setRail(railWidth(rail + (e.key === 'ArrowLeft' ? -16 : 16), body.current?.clientWidth || 1000)); } }}
          onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId) && body.current) setRail(railWidth(e.clientX - body.current.getBoundingClientRect().left, body.current.clientWidth)); }}
          onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} />
        </>}
        <main aria-label="Рабочая книга" className="flex min-h-0 min-w-0 flex-1">
          <ExportWorkbook ref={workbook} key={`${projectId}:${userId}`} projectId={projectId} grid={grid} name={saveName || 'Выгрузка данных'} say={say} />
        </main>
      </div>
      <footer className="fx-bar flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="tabular-nums">В листе: {table.count} строк · {grid.headers.length} столбцов</span>
        <span className="truncate">{scopes.find(s => s.id === scope)?.label}</span>
        <span className="ml-auto">Черновик сохраняется автоматически</span>
      </footer>
    </div>
  );
}
