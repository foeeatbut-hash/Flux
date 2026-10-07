import React from 'react';
import { ListFilter, Search, Square, X } from 'lucide-react';
import Popover from '../Popover';
import { dataService } from '../../services/dataService';
import { FONT_STACK, SIZE, X as T } from './explorerTheme';
import {
  DATE_LABELS, NO_FILTERS, SIZE_LABELS, TYPE_LABELS, activeFilters,
  type DateFilter, type SearchUi, type SizeFilter, type TypeFilter,
} from './searchFilters';
import type { ExplorerSearch } from './useExplorerSearch';

/**
 * Поле «Поиск в: <место>» справа от адреса — той же высоты, что поле адреса.
 *
 * Запрос уходит сам, когда человек перестал печатать (Enter — сразу). Esc
 * сначала останавливает идущий поиск, вторым нажатием очищает поле и
 * закрывает результаты — как в Проводнике. Фильтры лежат за воронкой: тип,
 * дата и размер — как в Windows, ниже свойства Flux (тег, проект, черновики).
 */
const TYPE_ORDER = Object.keys(TYPE_LABELS) as TypeFilter[];
const DATE_ORDER = Object.keys(DATE_LABELS) as DateFilter[];
const SIZE_ORDER = Object.keys(SIZE_LABELS) as SizeFilter[];
const TYPING_PAUSE = 450;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"><span className={T.muted}>{label}</span>{children}</label>;
}
const selectClass = `h-7 w-44 rounded border px-2 text-xs outline-none ${T.field} ${T.text} border-[#d6d6d6] dark:border-[#4a4a4a]`;

function FilterPanel({ ui, onChange }: { ui: SearchUi; onChange: (next: SearchUi) => void }) {
  const [projects, setProjects] = React.useState<{ id: string; name: string }[]>([]);
  // Список проектов нужен только панели, и только когда её открыли
  React.useEffect(() => {
    let active = true;
    dataService.getProjects().then((list) => { if (active) setProjects(list.map((item: any) => ({ id: String(item.id), name: String(item.name) }))); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const set = (patch: Partial<SearchUi>) => onChange({ ...ui, ...patch });
  return (
    <div className={`w-[340px] py-1 ${T.text}`} style={{ fontFamily: FONT_STACK }}>
      <Row label="Тип"><select aria-label="Тип" className={selectClass} value={ui.type} onChange={(e) => set({ type: e.target.value as TypeFilter })}>
        {TYPE_ORDER.map((key) => <option key={key} value={key}>{TYPE_LABELS[key]}</option>)}</select></Row>
      <Row label="Дата изменения"><select aria-label="Дата изменения" className={selectClass} value={ui.modified} onChange={(e) => set({ modified: e.target.value as DateFilter })}>
        {DATE_ORDER.map((key) => <option key={key} value={key}>{DATE_LABELS[key]}</option>)}</select></Row>
      <Row label="Размер"><select aria-label="Размер" className={selectClass} value={ui.size} onChange={(e) => set({ size: e.target.value as SizeFilter })}>
        {SIZE_ORDER.map((key) => <option key={key} value={key}>{SIZE_LABELS[key]}</option>)}</select></Row>
      <div className={`mx-3 my-1.5 border-t ${T.line}`} />
      <div className={`px-3 pb-1 pt-0.5 text-xs ${T.faint}`}>Flux</div>
      <Row label="Тег"><input aria-label="Тег" className={selectClass} value={ui.tag} placeholder="например, AHU-01" onChange={(e) => set({ tag: e.target.value })} /></Row>
      <Row label="Проект"><select aria-label="Проект" className={selectClass} value={ui.projectId} onChange={(e) => set({ projectId: e.target.value })}>
        <option value="">Любой</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Row>
      <label className="flex items-center gap-2 px-3 py-1.5 text-xs"><input type="checkbox" checked={ui.onlyDrafts} onChange={(e) => set({ onlyDrafts: e.target.checked })} /><span>Только черновики</span></label>
      <div className="flex justify-end px-3 pt-1">
        <button type="button" disabled={!activeFilters(ui).length} onClick={() => onChange(NO_FILTERS)}
          className="rounded px-2 py-1 text-xs text-[#0067c0] disabled:opacity-40 dark:text-[#4cc2ff]">Сбросить фильтры</button>
      </div>
    </div>
  );
}

export default function SearchBox({ search, placeName, focusToken = 0 }: {
  search: ExplorerSearch;
  /** Имя места для подсказки «Поиск в: …» */
  placeName: string;
  /** Растёт на единицу, когда клавиша просит поле (Ctrl+E, Ctrl+F, F3) */
  focusToken?: number;
}) {
  const { query, setQuery, ui, setUi, run, cancel, clear, results } = search;
  const input = React.useRef<HTMLInputElement>(null);
  const filterButton = React.useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => { if (focusToken) { input.current?.focus(); input.current?.select(); } }, [focusToken]);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const change = (text: string) => { setQuery(text); clearTimeout(timer.current); timer.current = setTimeout(() => run(text, ui), TYPING_PAUSE); };
  const filters = activeFilters(ui);
  const running = results.status === 'running';

  return (
    <div role="search" data-search-box style={{ height: SIZE.addressField, fontFamily: FONT_STACK }}
      className={`flex w-[295px] min-w-[160px] shrink items-center rounded-md ${T.field} ${T.fieldBorder} focus-within:border-b-2 focus-within:border-b-[#0067c0] dark:focus-within:border-b-[#4cc2ff]`}>
      <input ref={input} type="search" value={query} aria-label={`Поиск в: ${placeName}`} placeholder={`Поиск в: ${placeName}`}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { clearTimeout(timer.current); run(query, ui); }
          else if (e.key === 'Escape') {
            // preventDefault: у поля type="search" Chromium сам стирает текст по Esc, и тогда первое Esc
            // гасило бы запрос вместе с результатами, не дав остановить идущий поиск
            e.preventDefault(); e.stopPropagation(); clearTimeout(timer.current);
            // Первое Esc гасит идущий поиск, второе — само поле и результаты
            if (running) cancel(); else if (query || results.active || filters.length) clear(); else input.current?.blur();
          }
        }}
        className={`min-w-0 flex-1 bg-transparent px-3 text-[14px] outline-none placeholder:text-[#707070] dark:placeholder:text-[#a0a0a0] ${T.text} [&::-webkit-search-cancel-button]:hidden`} />
      {running && <button type="button" aria-label="Остановить поиск" title="Остановить поиск (Esc)" onClick={cancel} className={`flex h-7 w-7 items-center justify-center rounded ${T.iconButton}`}><Square width={12} height={12} /></button>}
      {!running && (query || results.active) && <button type="button" aria-label="Очистить поиск" onClick={clear} className={`flex h-7 w-7 items-center justify-center rounded ${T.iconButton}`}><X width={14} height={14} /></button>}
      <button ref={filterButton} type="button" aria-label="Фильтры поиска" aria-expanded={panel} title={filters.length ? filters.join(' · ') : 'Фильтры поиска'}
        onClick={() => setPanel((open) => !open)} className={`relative flex h-7 w-7 items-center justify-center rounded ${T.iconButton}`}>
        <ListFilter width={14} height={14} />
        {filters.length > 0 && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#0067c0] dark:bg-[#4cc2ff]" />}
      </button>
      <span aria-hidden className={`flex h-7 w-8 items-center justify-center ${T.muted}`}><Search width={14} height={14} /></span>
      {panel && (
        <Popover anchor={filterButton.current} align="right" label="Фильтры поиска" onClose={() => setPanel(false)}>
          <FilterPanel ui={ui} onChange={(next) => { setUi(next); run(query, next); }} />
        </Popover>
      )}
    </div>
  );
}
