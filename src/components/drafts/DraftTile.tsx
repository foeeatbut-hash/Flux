/**
 * Плитка и строка черновика — общие для полосы и компактной панели.
 *
 * Значок — лист с меткой типа (XLSX, DOCX, PDF…) или папка: панель показывает
 * черновики Flux, которых в Windows ещё нет, поэтому системный значок Windows
 * здесь не спрашивается — его не у кого спросить без лишнего обхода моста.
 */
import React from 'react';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { draftKind, extLabel, STATE_LABEL, type DraftState } from '../../lib/draftsPanel';

/** Цвет метки типа — из смысловых ступеней палитры (01-design.md, раздел 3), без синих и фиолетовых. */
const EXT_TONE: Record<string, string> = {
  table: 'bg-emerald-700', doc: 'bg-sky-700', drawing: 'bg-rose-700', other: 'bg-slate-500',
};
const DOT: Record<DraftState, string> = { draft: 'bg-slate-400', editing: 'bg-amber-500', unsent: 'bg-sky-500' };

export const ICON_PX = { S: 28, M: 36, L: 44 } as const;
export const TILE_W = { S: 72, M: 84, L: 96 } as const;

export function StateDot({ state }: { state: DraftState }) {
  return <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state]}`} />;
}

export function DraftIcon({ entry, size }: { entry: WindowsDraftEntry; size: number }) {
  if (entry.kind === 'directory') {
    return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path d="M5 12a3 3 0 0 1 3-3h10l4 4h18a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" className="fill-amber-600" />
      <path d="M5 18h38v18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" className="fill-amber-400" />
    </svg>;
  }
  const kind = draftKind(entry);
  const tone = draftExtTone(entry, kind);
  const label = extLabel(entry);
  return <span className="relative shrink-0" style={{ width: size, height: size }} aria-hidden="true">
    <svg width={size} height={size} viewBox="0 0 48 48">
      <path d="M12 4h17l9 9v29a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" className="fill-slate-100 stroke-slate-300 dark:fill-slate-200 dark:stroke-slate-400" strokeWidth="1" />
      <path d="M29 4v9h9" className="fill-slate-300 dark:fill-slate-400" />
    </svg>
    {label && <span data-draft-ext className={`absolute bottom-[12%] left-0 rounded-sm px-[3px] font-semibold leading-3 text-white ${tone}`} style={{ fontSize: Math.max(8, Math.round(size / 4.5)) }}>{label}</span>}
  </span>;
}

function draftExtTone(entry: WindowsDraftEntry, kind: ReturnType<typeof draftKind>) {
  // DWG — чертёж, но не PDF: тёплый тон отличает его от PDF в одной группе.
  if (extLabel(entry) === 'DWG' || extLabel(entry) === 'DXF') return 'bg-amber-700';
  if (extLabel(entry) === 'TXT' || extLabel(entry) === 'MD') return 'bg-slate-500';
  return EXT_TONE[kind] || EXT_TONE.other;
}

export interface DraftItemHandlers {
  open: (entry: WindowsDraftEntry) => void;
  menu: (entry: WindowsDraftEntry, x: number, y: number) => void;
  key: (entry: WindowsDraftEntry, event: React.KeyboardEvent) => void;
  dragStart: (entry: WindowsDraftEntry, event: React.DragEvent) => void;
  hover: (entry: WindowsDraftEntry | null, rect?: DOMRect) => void;
  select: (entry: WindowsDraftEntry) => void;
}

interface ItemProps {
  entry: WindowsDraftEntry; state: DraftState; dot: boolean; meta: string;
  selected: boolean; handlers: DraftItemHandlers; title?: string;
}

function common({ entry, selected, handlers }: ItemProps) {
  return {
    'data-draft-id': entry.draftId, 'aria-selected': selected, draggable: true,
    onClick: () => handlers.select(entry),
    onDoubleClick: () => handlers.open(entry),
    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); handlers.select(entry); handlers.menu(entry, event.clientX, event.clientY); },
    onKeyDown: (event: React.KeyboardEvent) => handlers.key(entry, event),
    onDragStart: (event: React.DragEvent) => { handlers.hover(null); handlers.dragStart(entry, event); },
    onPointerEnter: (event: React.PointerEvent) => handlers.hover(entry, event.currentTarget.getBoundingClientRect()),
    onPointerLeave: () => handlers.hover(null),
  };
}

export function DraftTile(props: ItemProps & { size: 'S' | 'M' | 'L'; width?: number }) {
  const { entry, state, dot, meta, selected, size } = props;
  return <button type="button" {...common(props)} aria-label={`${entry.name}, ${STATE_LABEL[state]}`}
    style={{ width: props.width ?? TILE_W[size] }}
    className={`flex shrink-0 flex-col items-center gap-[3px] rounded px-1 pb-1 pt-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--flux-focus)] ${selected ? 'fx-sel' : 'fx-hov'}`}>
    <DraftIcon entry={entry} size={ICON_PX[size]} />
    <span className="line-clamp-2 w-full break-words text-xs leading-[15px]">{entry.name}</span>
    <span className="flex max-w-full items-center gap-1 whitespace-nowrap text-xs leading-[14px] text-[var(--flux-text-muted)]">
      {dot && <StateDot state={state} />}<span className="truncate tabular-nums">{meta}</span>
    </span>
  </button>;
}

/** Строка списка — 28 px: значок типа, имя, точка состояния, «Изменён», «Размер»; проект — в подсказке. */
export function DraftRow(props: ItemProps & { when: string; size: string }) {
  const { entry, state, dot, selected, when, size, title } = props;
  return <button type="button" {...common(props)} title={title} aria-label={`${entry.name}, ${STATE_LABEL[state]}`}
    className={`grid h-7 w-full grid-cols-[minmax(0,1fr)_76px_62px] items-center gap-x-1.5 rounded px-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--flux-focus)] ${selected ? 'fx-sel' : 'fx-hov'}`}>
    <span className="flex min-w-0 items-center gap-1.5">
      <DraftIcon entry={entry} size={16} />
      <span className="truncate">{entry.name}</span>
      {dot && <StateDot state={state} />}
    </span>
    <span className="truncate text-[var(--flux-text-muted)] tabular-nums">{when}</span>
    <span className="text-right text-[var(--flux-text-muted)] tabular-nums">{size}</span>
  </button>;
}
