/**
 * Вид 1 — полоса во всю длину монитора над панелью задач (лист «Main»).
 *
 * Ряд плиток листается вбок, и колесо мыши листает его влево-вправо: другой
 * прокрутки у полосы нет, а искать горизонтальное колесо или Shift человек не
 * станет. Прокрутка без инерции и сглаживания (01-design.md, раздел 7).
 */
import React from 'react';
import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { draftState, shortWhen, formatSize, type DraftsSection, type DraftState } from '../../lib/draftsPanel';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { DraftTile, TILE_W, type DraftItemHandlers } from './DraftTile';
import { IconButton, KindChips, SearchField, SortControl } from './DraftsControls';

export const STRIP_H = { 1: 150, 2: 260 } as const;

export default function DraftsStrip({ sections, shown, total, query, setQuery, openDrafts, selected, handlers, now, status }: {
  sections: DraftsSection[]; shown: number; total: number; query: string; setQuery: (value: string) => void;
  openDrafts: ReadonlySet<string>; selected: string | null; handlers: DraftItemHandlers; now: number; status?: React.ReactNode;
}) {
  const s = useDraftsSettings();
  const scroller = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setEdges((prev) => prev.left === next.left && prev.right === next.right ? prev : next);
  }, []);
  React.useLayoutEffect(measure);
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  // Колесо: вертикальный ход становится горизонтальным. Слушатель не пассивный,
  // иначе страница позади полосы получила бы ту же прокрутку.
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      event.preventDefault();
      el.scrollLeft += event.deltaMode === 1 ? delta * 40 : delta;
      measure();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [measure]);
  const page = (sign: 1 | -1) => { const el = scroller.current; if (el) { el.scrollLeft += sign * Math.max(TILE_W[s.icons], el.clientWidth - 80); measure(); } };
  const meta = (entry: WindowsDraftEntry) => s.sort === 'size' ? formatSize(entry.size) : shortWhen(entry.modifiedAt, now);
  const rows = s.rows;

  return <>
    <header className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-[var(--flux-line)] pl-2.5 pr-1.5">
      <h2 className="text-[13px] font-semibold">Черновики</h2>
      <span className="text-xs text-[var(--flux-text-muted)] tabular-nums" data-drafts-count>{shown} из {total}</span>
      <span className="mx-1 h-4 w-px bg-[var(--flux-line)]" aria-hidden="true" />
      <KindChips />
      <span className="flex-1" />
      <SearchField value={query} onChange={setQuery} width={170} />
      <SortControl />
      <IconButton label="Компактный вид" onClick={() => s.set({ view: 'compact' })}><LayoutGrid size={14} /></IconButton>
    </header>
    <div className="relative min-h-0 flex-1">
      {status}
      <div ref={scroller} data-drafts-strip onScroll={measure}
        className="absolute inset-0 grid auto-cols-max grid-flow-col content-start items-start gap-0.5 overflow-x-auto overflow-y-hidden px-1.5 py-1 [scrollbar-width:thin]"
        style={{ gridTemplateRows: `repeat(${rows}, auto)` }}>
        {sections.map((section, index) => <React.Fragment key={section.key}>
          {section.label && s.groupLabels && <div data-drafts-group={section.key} style={{ gridRow: '1 / -1' }}
            className={`flex h-full w-4 items-center justify-center ${index ? 'border-l border-[var(--flux-line)]' : ''}`}>
            <span className="text-xs text-[var(--flux-text-muted)] [transform:rotate(180deg)] [writing-mode:vertical-rl]">{section.label}</span>
          </div>}
          {section.items.map((entry) => {
            const state: DraftState = draftState(entry, openDrafts);
            return <DraftTile key={entry.draftId} entry={entry} state={state} dot={s.dots} meta={meta(entry)} size={s.icons}
              selected={selected === entry.draftId} handlers={handlers} />;
          })}
        </React.Fragment>)}
      </div>
      {edges.left && <>
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[var(--flux-surface)] to-transparent" />
        <button type="button" aria-label="Прокрутить влево" onClick={() => page(-1)} className="fx-pop absolute left-1 top-1/2 -mt-3 flex h-6 w-6 items-center justify-center rounded border border-[var(--flux-line)]"><ChevronLeft size={12} /></button>
      </>}
      {edges.right && <>
        <div aria-hidden="true" data-drafts-fade className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--flux-surface)] to-transparent" />
        <button type="button" aria-label="Прокрутить вправо" onClick={() => page(1)} className="fx-pop absolute right-1 top-1/2 -mt-3 flex h-6 w-6 items-center justify-center rounded border border-[var(--flux-line)]"><ChevronRight size={12} /></button>
      </>}
    </div>
  </>;
}
