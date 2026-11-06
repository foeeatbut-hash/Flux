/**
 * Вид 2 — компактная панель над кнопкой (лист «Compact»).
 *
 * Шапка 36, строка поиска и сортировки, фильтры типа и состояния, плитки
 * (3–6 столбцов) или строки по 28 px, низ 36: «Создать ▾», «Разобрать
 * старые», «В Проводнике». Отбор и порядок уже посчитаны слоем — здесь только
 * разметка, как и у полосы.
 */
import React from 'react';
import { ChevronDown, PanelBottom, Settings } from 'lucide-react';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { draftState, formatSize, shortWhen, type DraftProjectOf, type DraftsSection } from '../../lib/draftsPanel';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { DraftRow, DraftTile, type DraftItemHandlers } from './DraftTile';
import { IconButton, KindChips, ModeToggle, SearchField, SortControl, StateChips } from './DraftsControls';

export const COMPACT_H = 540;
/** Ширина растёт со столбцами: 4 столбца — 400 px, каждый следующий добавляет 80. */
export const COMPACT_W = { 3: 320, 4: 400, 5: 480, 6: 560 } as const;

export interface DraftsModel {
  sections: DraftsSection[]; shown: number; total: number;
  openDrafts: ReadonlySet<string>; now: number;
  projectOf: DraftProjectOf;
  projectNames: (entry: WindowsDraftEntry) => string[];
}

export default function DraftsCompact({ model, query, setQuery, selected, handlers, status, banner, bottom, onSettings }: {
  model: DraftsModel; query: string; setQuery: (value: string) => void; selected: string | null; handlers: DraftItemHandlers;
  status?: React.ReactNode; banner?: React.ReactNode; onSettings?: () => void;
  bottom: { createMenu: (anchor: DOMRect) => void; oldCount: number; reviewing: boolean; toggleReview: () => void; showInExplorer: () => void };
}) {
  const s = useDraftsSettings();
  const createButton = React.useRef<HTMLButtonElement>(null);
  const grid = s.compactMode === 'grid';
  const when = (entry: WindowsDraftEntry) => s.sort === 'size' ? formatSize(entry.size) : shortWhen(entry.modifiedAt, model.now);
  const item = (entry: WindowsDraftEntry) => {
    const state = draftState(entry, model.openDrafts, model.projectOf);
    const selectedHere = selected === entry.draftId;
    return grid
      ? <DraftTile key={entry.draftId} entry={entry} state={state} dot={s.dots} meta={when(entry)} size={s.icons} width="100%" selected={selectedHere} handlers={handlers} />
      : <DraftRow key={entry.draftId} entry={entry} state={state} dot={s.dots} meta="" selected={selectedHere} handlers={handlers}
        when={shortWhen(entry.modifiedAt, model.now)} size={entry.kind === 'directory' ? '—' : formatSize(entry.size)}
        title={model.projectNames(entry).join(', ') || 'Не в проекте'} />;
  };
  return <>
    <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--flux-line)] pl-2.5 pr-1.5">
      <h2 className="text-[13px] font-[600]">Черновики</h2>
      <span className="text-xs text-[var(--flux-text-muted)] tabular-nums" data-drafts-count>{model.shown} из {model.total}</span>
      <span className="flex-1" />
      <ModeToggle />
      <IconButton label="Полоса" onClick={() => s.set({ view: 'strip' })}><PanelBottom size={14} /></IconButton>
      {onSettings && <IconButton label="Настройки панели" onClick={onSettings}><Settings size={14} /></IconButton>}
    </header>
    <div className="flex h-9 shrink-0 items-center gap-1 px-2">
      <SearchField value={query} onChange={setQuery} />
      <SortControl />
    </div>
    <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-1">
      <KindChips short />
      <StateChips />
    </div>
    {banner}
    <div data-drafts-body className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--flux-line)] px-2 py-1 [scrollbar-width:thin]">
      {status}
      {model.sections.map((section) => <section key={section.key} data-drafts-group={section.key}>
        {section.label && s.groupLabels && <h3 className="flex h-6 items-center gap-1 px-1.5 text-xs font-medium text-[var(--flux-text-muted)]">{section.label}<span className="tabular-nums">{section.items.length}</span></h3>}
        {grid
          ? <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${s.columns}, minmax(0, 1fr))` }}>{section.items.map(item)}</div>
          : <div className="flex flex-col">{section.items.map(item)}</div>}
      </section>)}
    </div>
    <footer className="flex h-9 shrink-0 items-center gap-1 border-t border-[var(--flux-line)] px-2">
      <button ref={createButton} type="button" className="fx-btn fx-btn-sm" onClick={() => { if (createButton.current) bottom.createMenu(createButton.current.getBoundingClientRect()); }}>Создать<ChevronDown aria-hidden="true" style={{ width: 12, height: 12 }} /></button>
      <button type="button" aria-pressed={bottom.reviewing} disabled={!bottom.oldCount && !bottom.reviewing} className={`fx-btn fx-btn-sm fx-btn-quiet ${bottom.reviewing ? 'fx-sel' : ''}`} onClick={bottom.toggleReview}>
        <span className="tabular-nums">{bottom.oldCount > 0 ? `Разобрать старые · ${bottom.oldCount}` : 'Разобрать старые'}</span>
      </button>
      <span className="flex-1" />
      <button type="button" className="fx-btn fx-btn-sm fx-btn-quiet" onClick={bottom.showInExplorer}>В Проводнике</button>
    </footer>
  </>;
}
