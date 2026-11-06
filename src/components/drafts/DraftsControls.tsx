/**
 * Шапка панели «Черновики»: фильтры типа, поиск, сортировка, кнопки вида.
 * Кнопки 24 px, шрифт 12 px, выбранное — нейтральная заливка fx-sel и вес 500
 * (01-design.md, раздел 3: зелёной заливки у выбранного нет).
 */
import React from 'react';
import { LayoutGrid, List, Search } from 'lucide-react';
import { KIND_FILTERS, SORT_CYCLE, SORT_LABEL, STATE_LABEL, STATE_ORDER, type DraftKindFilter } from '../../lib/draftsPanel';
import { StateDot } from './DraftTile';
import { useDraftsSettings } from '../../store/draftsSettingsStore';

export function KindChips({ short = false }: { short?: boolean }) {
  const kind = useDraftsSettings((s) => s.kind);
  const set = useDraftsSettings((s) => s.set);
  return <div role="group" aria-label="Тип" className="flex shrink-0 items-center gap-0.5">
    {KIND_FILTERS.map((k) => <Chip key={k.id} on={kind === k.id} onClick={() => set({ kind: k.id as DraftKindFilter })}>{short ? k.short : k.label}</Chip>)}
  </div>;
}

export function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return <button type="button" aria-pressed={on} title={title} onClick={onClick}
    className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs ${on ? 'fx-sel font-medium' : 'fx-hov text-[var(--flux-text-muted)]'}`}>{children}</button>;
}

export function SearchField({ value, onChange, width }: { value: string; onChange: (value: string) => void; width?: number }) {
  return <label className={`flex h-6 min-w-0 items-center gap-1.5 rounded border border-[var(--flux-line)] bg-[var(--flux-surface)] px-2 ${width ? '' : 'flex-1'}`} style={{ width }}>
    <Search size={12} className="shrink-0 text-[var(--flux-text-muted)]" aria-hidden="true" />
    <input aria-label="Поиск по черновикам" placeholder="Поиск" value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape' && value) { event.stopPropagation(); onChange(''); } }}
      className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--flux-text-muted)]" />
  </label>;
}

/** Щелчок перебирает ключ (Изменён, Размер, Имя, Тип, Проект), стрелка рядом меняет порядок. */
export function SortControl() {
  const sort = useDraftsSettings((s) => s.sort);
  const dir = useDraftsSettings((s) => s.dir);
  const set = useDraftsSettings((s) => s.set);
  const next = () => set({ sort: SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length] });
  return <div className="flex shrink-0 items-center">
    <button type="button" aria-label={`Сортировка: ${SORT_LABEL[sort]}`} title="Сменить порядок: Изменён, Размер, Имя, Тип, Проект" onClick={next}
      className="fx-hov h-6 whitespace-nowrap rounded px-2 text-xs">{SORT_LABEL[sort]}</button>
    <button type="button" aria-label={dir === 'desc' ? 'По убыванию' : 'По возрастанию'} onClick={() => set({ dir: dir === 'desc' ? 'asc' : 'desc' })}
      className="fx-hov h-6 w-6 rounded text-xs">{dir === 'desc' ? '↓' : '↑'}</button>
  </div>;
}

export function IconButton({ label, onClick, children, pressed }: { label: string; onClick: () => void; children: React.ReactNode; pressed?: boolean }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}
    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${pressed ? 'fx-sel' : 'fx-hov text-[var(--flux-text-muted)]'}`}>{children}</button>;
}

/** Состояние файла: «черновик», «правится», «не в проекте». Повторный щелчок снимает фильтр. */
export function StateChips() {
  const state = useDraftsSettings((s) => s.state);
  const set = useDraftsSettings((s) => s.set);
  return <div role="group" aria-label="Состояние" className="flex shrink-0 items-center gap-0.5">
    {STATE_ORDER.map((id) => <Chip key={id} on={state === id} onClick={() => set({ state: state === id ? null : id })}><StateDot state={id} />{STATE_LABEL[id]}</Chip>)}
  </div>;
}

/** «Плитки / Список» в шапке компактной панели. */
export function ModeToggle() {
  const mode = useDraftsSettings((s) => s.compactMode);
  const set = useDraftsSettings((s) => s.set);
  return <div role="group" aria-label="Вид" className="flex shrink-0 items-center gap-0.5">
    <Chip on={mode === 'grid'} onClick={() => set({ compactMode: 'grid' })}><LayoutGrid size={13} aria-hidden="true" />Плитки</Chip>
    <Chip on={mode === 'list'} onClick={() => set({ compactMode: 'list' })}><List size={13} aria-hidden="true" />Список</Chip>
  </div>;
}
