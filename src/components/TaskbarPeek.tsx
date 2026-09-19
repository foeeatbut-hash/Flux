/**
 * Окна одной программы при наведении на её кнопку.
 *
 * Как только окон становится больше, чем разделов, кнопка перестаёт отвечать
 * на вопрос «какое из них». Здесь она отвечает: список окон с именами
 * документов, наведение подсвечивает окно на столе, нажатие поднимает.
 *
 * Уменьшенного вида окна тут нет и он не нарисован «на будущее»: снимок живого
 * раздела потребовал бы отдельной библиотеки, а рамка с серыми полосками вместо
 * снимка обманывала бы. Пока имя документа и подсветка на столе — то, что
 * действительно есть.
 */
import React from 'react';
import { X, Plus } from 'lucide-react';
import { useWindowStore, windowsOf } from '../store/windowStore';
import { sectionForPath } from '../workspace/sections';

export default function TaskbarPeek({ path, left, onClose }: {
  path: string;
  /** Отступ слева в точках: панель встаёт над своей кнопкой */
  left: number;
  onClose: () => void;
}) {
  const windows = useWindowStore((s) => s.windows);
  const titles = useWindowStore((s) => s.titles);
  const focus = useWindowStore((s) => s.focus);
  const close = useWindowStore((s) => s.close);
  const openAnother = useWindowStore((s) => s.openAnother);
  const setPeeked = useWindowStore((s) => s.setPeeked);
  const desk = useWindowStore((s) => s.desk);
  const def = sectionForPath(path);
  // Список — про этот стол: на соседнем окна той же программы живут своей
  // жизнью, и мешать их в одну стопку значило бы поднимать невидимое
  const mine = windowsOf(windows, path, desk);

  // Подсветка на столе гаснет вместе с панелью: она принадлежит наведению,
  // а не окну
  React.useEffect(() => () => setPeeked(null), [setPeeked]);

  if (!mine.length) return null;

  return (
    <div
      className="absolute bottom-[56px] z-40 min-w-56 max-w-80 py-1.5 rounded-xl shadow-2xl
                 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
      style={{ left }}
      onMouseLeave={onClose}
    >
      {mine.map((w) => (
        <div key={w.id}
          onMouseEnter={() => setPeeked(w.id)}
          onClick={() => { focus(w.id); onClose(); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(w.id); } }}
          className="group flex items-center gap-2 px-3 py-1.5 cursor-pointer
                     hover:bg-slate-100 dark:hover:bg-slate-850"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-2xs font-semibold text-slate-700 dark:text-slate-300 truncate">
              {titles[w.id] || def.title}
            </span>
            {w.minimized && <span className="block text-2xs text-slate-400 dark:text-slate-455">свёрнуто</span>}
          </span>
          <button type="button" aria-label="Закрыть окно"
            onClick={(e) => { e.stopPropagation(); close(w.id); }}
            className="p-1 rounded-md text-slate-400 opacity-0 group-hover:opacity-100
                       hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      {def.multi && (
        <button type="button"
          onClick={() => { openAnother(mine[0].href); onClose(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-2xs font-semibold
                     text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40
                     cursor-pointer border-t border-slate-100 dark:border-slate-850 mt-1 pt-2">
          <Plus className="w-3 h-3" /> Ещё одно окно
        </button>
      )}
    </div>
  );
}
