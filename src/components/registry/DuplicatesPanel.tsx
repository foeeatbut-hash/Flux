/**
 * Панель дублей: позиции с одинаковым кодом тега.
 *
 * Дубль в реестре — не мелочь: две карточки с одним кодом значат, что в
 * спецификацию попадёт либо не та позиция, либо обе. Найти их глазами на
 * холсте нельзя — они как раз и выглядят одинаково, — поэтому панель ведёт по
 * ним по одному, подводя холст к каждому.
 *
 * Наведение равносильно нажатию: пока листаешь список, холст едет за курсором.
 * Так дубли и разбирают — не «выбрать и посмотреть», а «пробежать глазами».
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { X, Eye } from 'lucide-react';

export interface DupItem {
  id: string;
  code: string;
  /** Наименование и отдел — по ним и отличают, какой из дублей нужный */
  name: string;
  department: string;
}

export interface DuplicatesPanelProps {
  code: string;
  items: DupItem[];
  activeIdx: number;
  /** Колесо мыши над панелью листает дубли — ссылка нужна самому реестру */
  panelRef: React.RefObject<HTMLDivElement>;
  onGo: (index: number) => void;
  onClose: () => void;
}

export default function DuplicatesPanel({ code, items, activeIdx, panelRef, onGo, onClose }: DuplicatesPanelProps) {
  return createPortal(
    <div
      ref={panelRef}
      className="fixed right-4 top-28 z-[118] w-72 bg-white/97 dark:bg-slate-950/97 backdrop-blur-md
                 border border-rose-200 dark:border-rose-900 rounded-lg shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 bg-rose-50/80 dark:bg-rose-950/30
                      border-b border-rose-100 dark:border-rose-900/60">
        <div className="min-w-0">
          <div className="text-xs font-medium text-rose-700 dark:text-rose-300 truncate">Дубли: {code}</div>
          <div className="text-2xs text-slate-400">колесо мыши — листать · Esc — закрыть</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs font-mono font-medium text-rose-600 dark:text-rose-400 tabular-nums">
            {activeIdx + 1} / {items.length}
          </span>
          <button type="button" onClick={onClose}
            className="p-1 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-950/50 text-slate-400 cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto p-1.5 space-y-0.5">
        {items.map((d, i) => {
          const active = i === activeIdx;
          return (
            <button type="button"
              key={d.id}
              onClick={() => onGo(i)}
              onMouseEnter={() => { if (!active) onGo(i); }}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors cursor-pointer border ${
                active
                  ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800'
                  : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-900'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-medium text-slate-800 dark:text-slate-100">{i + 1}. {d.code}</span>
                {active && <Eye className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
              </div>
              <div className="text-2xs text-slate-400 truncate mt-0.5">
                {d.name || 'Без наименования'} · {d.department || '—'}
              </div>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
