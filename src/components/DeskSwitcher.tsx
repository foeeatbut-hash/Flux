/**
 * Рабочие столы: переключатель в трее и обзор всех столов.
 *
 * Стол — это набор окон, а не второй экран и не второе хранилище. Значки,
 * корзина, папки и сами документы общие; расходится только то, какие окна
 * показаны. Поэтому «перенести окно на соседний стол» ничего не копирует и не
 * пересохраняет — меняется одно число у окна.
 *
 * Окна на карточке нарисованы по своим настоящим местам и размерам, уменьшенным
 * заодно со столом. Это не снимок содержимого: снимка у нас нет, и рисовать
 * вместо него серые полоски значило бы обманывать. Зато расположение — правда,
 * и по нему стол узнают с одного взгляда.
 */
import React from 'react';
import { Plus, X, Monitor } from 'lucide-react';
import { useWindowStore } from '../store/windowStore';
import { sectionForPath } from '../workspace/sections';
import type { WinState } from '../lib/windows';

/** Карточка стола: 132 × 74 — те же пропорции, что у стола, и читаемо в трее */
const CARD_W = 132;
const CARD_H = 74;

/** Окно на карточке: настоящее место, уменьшенное вместе со столом */
function miniStyle(w: WinState, area: { w: number; h: number }): React.CSSProperties {
  const kx = CARD_W / Math.max(1, area.w);
  const ky = CARD_H / Math.max(1, area.h);
  return {
    left: Math.round(w.x * kx),
    top: Math.round(w.y * ky),
    // Не меньше трёх точек: узкое окно иначе исчезает с карточки совсем
    width: Math.max(3, Math.round(w.w * kx)),
    height: Math.max(3, Math.round(w.h * ky)),
  };
}

function DeskCard({ index, dragging, onPick, onDrop }: {
  index: number;
  /** Окно, которое тащат прямо сейчас: карточка-цель подсвечивается */
  dragging: string | null;
  /** Потащили окно с этой карточки */
  onPick: (id: string) => void;
  /** Отпустили окно над этой карточкой */
  onDrop: (desk: number) => void;
}) {
  const desks = useWindowStore((s) => s.desks);
  const desk = useWindowStore((s) => s.desk);
  const windows = useWindowStore((s) => s.windows);
  const area = useWindowStore((s) => s.area);
  const titles = useWindowStore((s) => s.titles);
  const [over, setOver] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const here = index === desk;
  const mine = windows.filter((w) => w.desk === index);

  return (
    <div className="shrink-0">
      <div
        onClick={() => useWindowStore.getState().goToDesk(index)}
        onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(index); }}
        style={{ width: CARD_W, height: CARD_H }}
        className={`relative rounded-lg overflow-hidden cursor-pointer transition-colors border-2 ${
          over
            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
            : here
              ? 'border-emerald-500 bg-slate-100 dark:bg-slate-850'
              : 'border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-bg hover:border-slate-300 dark:hover:border-slate-700'
        }`}
      >
        {mine.filter((w) => !w.minimized).map((w) => (
          <span
            key={w.id}
            draggable
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); onPick(w.id); }}
            title={titles[w.id] || sectionForPath(w.path).title}
            style={miniStyle(w, area)}
            className="absolute rounded-[2px] bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
          />
        ))}
        {!mine.length && (
          <span className="absolute inset-0 flex items-center justify-center text-2xs text-slate-400 dark:text-slate-455">
            пусто
          </span>
        )}
        {desks.length > 1 && (
          <button type="button" aria-label={`Убрать ${desks[index]}`}
            onClick={(e) => { e.stopPropagation(); useWindowStore.getState().removeDesk(index); }}
            title="Убрать стол — окна переедут на соседний"
            className="absolute top-0.5 right-0.5 w-4 h-4 rounded flex items-center justify-center
                       text-slate-400 hover:bg-rose-600 hover:text-white cursor-pointer">
            <X className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
      {editing ? (
        <input
          autoFocus
          defaultValue={desks[index]}
          onBlur={(e) => { useWindowStore.getState().renameDesk(index, e.target.value); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="mt-1 w-full px-1 text-2xs rounded border border-emerald-500 bg-white dark:bg-slate-900
                     text-slate-700 dark:text-slate-300"
        />
      ) : (
        <div
          onDoubleClick={() => setEditing(true)}
          title="Двойное нажатие — переименовать"
          className={`mt-1 px-1 text-2xs truncate cursor-pointer ${
            here ? 'font-semibold text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {desks[index]}
        </div>
      )}
    </div>
  );
}

export default function DeskSwitcher() {
  const desks = useWindowStore((s) => s.desks);
  const desk = useWindowStore((s) => s.desk);
  const [open, setOpen] = React.useState(false);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open]);

  // Что именно тащат, помним здесь: у карточки-цели этих сведений нет, а через
  // dataTransfer их не прочитать до отпускания — подсветить цель заранее не
  // вышло бы
  const drop = React.useCallback((to: number) => {
    setDragging((id) => {
      if (id) useWindowStore.getState().moveToDesk(id, to);
      return null;
    });
  }, []);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${desks[desk] || 'Стол'} — рабочие столы (Ctrl+Alt+←/→)`}
        className={`h-9 px-2.5 rounded-lg cursor-pointer flex items-center gap-1.5 text-xs font-medium
                    transition-colors ${
          open
            ? 'bg-slate-200/70 dark:bg-slate-800 text-slate-900 dark:text-white'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'
        }`}
      >
        <Monitor className="w-[17px] h-[17px]" />
        <span className="tabular-nums">{desk + 1}/{desks.length}</span>
      </button>

      {open && (
        <div
          role="group"
          aria-label="Рабочие столы"
          onDragEnd={() => setDragging(null)}
          className="fx-pop absolute bottom-[46px] right-0 z-40 !p-2.5 flex items-end gap-2.5"
        >
          {desks.map((_, i) => (
            <DeskCard key={i} index={i} dragging={dragging} onPick={setDragging} onDrop={drop} />
          ))}
          <button
            type="button"
            onClick={() => useWindowStore.getState().addDesk()}
            title="Ещё один стол"
            style={{ width: 44, height: CARD_H }}
            className="shrink-0 rounded-lg cursor-pointer flex items-center justify-center
                       border-2 border-dashed border-slate-200 dark:border-dark-border
                       text-slate-400 hover:border-emerald-500 hover:text-emerald-600 transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
