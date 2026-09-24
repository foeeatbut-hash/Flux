/**
 * Панель по нажатию на часы — как в системе.
 *
 * Часы в трее человек нажимает не чтобы узнать время (оно и так написано), а
 * чтобы посмотреть, что сегодня. Раньше нажатие не делало ничего, и ответа на
 * этот вопрос в оболочке не было вовсе.
 *
 * Панель всплывает поверх стола и ничего не двигает — как остальные панели
 * трея (docs/os-design.md §2.5).
 */
import React from 'react';
import { useOverlay } from '../../store/overlayStore';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Plus, Maximize2, Video } from 'lucide-react';
import { useStore } from '../../store/store';
import { useCalendarStore } from '../../store/calendarStore';
import { rememberSectionUse } from '../../store/workspaceStore';
import { openLink } from '../../lib/openLink';
import { BAR_H } from '../../lib/metrics';
import { Z } from '../../lib/layers';
import {
  monthGrid, occurrences, dayOccurrences, startOfMonth, startOfDay, monthLabel,
  timeLabel, untilLabel, sameDay, inMonth, WEEKDAYS, DAY,
} from '../../lib/calendar';

export default function ClockPanel({ onClose }: { onClose: () => void }) {
  // Пока это открыто, страница браузера уступает место: родной слой Chromium
  // выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(true);
  const navigate = useNavigate();
  const projectId = useStore((s) => s.activeProject?.id) || '';
  const st = useCalendarStore();
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [month, setMonth] = React.useState(() => Date.now());

  React.useEffect(() => { void st.load(projectId); }, [projectId]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  const grid = monthGrid(month);
  const list = occurrences(st.visible(), grid[0], grid[41] + DAY);
  const today = dayOccurrences(list, Date.now());

  const go = () => { rememberSectionUse('/calendar'); navigate('/calendar'); onClose(); };

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Календарь"
      style={{ right: 8, bottom: BAR_H + 6, zIndex: Z.tray, width: 300 }}
      className="fx-dialog fixed dark:border-dark-border dark:bg-dark-surface overflow-hidden"
    >
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <button type="button"
          onClick={() => { const d = new Date(month); d.setMonth(d.getMonth() - 1); setMonth(d.getTime()); }}
          aria-label="Прошлый месяц"
          className="w-6 h-6 rounded-lg cursor-pointer text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850">‹</button>
        <span className="flex-1 text-center text-xs font-medium text-slate-800 dark:text-slate-100">{monthLabel(month)}</span>
        <button type="button"
          onClick={() => { const d = new Date(month); d.setMonth(d.getMonth() + 1); setMonth(d.getTime()); }}
          aria-label="Следующий месяц"
          className="w-6 h-6 rounded-lg cursor-pointer text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850">›</button>
      </div>

      <div className="px-2 py-2">
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS.map((d) => (
            <span key={d} className="text-center text-2xs text-slate-400">{d}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {grid.map((day) => {
            const has = dayOccurrences(list, day).length > 0;
            const now = sameDay(day, Date.now());
            const other = !inMonth(day, startOfMonth(month));
            return (
              <button key={day} type="button" onClick={go}
                className={`relative h-7 rounded-lg text-2xs cursor-pointer
                            ${now ? 'bg-emerald-600 text-white font-semibold'
                              : other ? 'text-slate-300 dark:text-slate-500'
                                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
                {new Date(day).getDate()}
                {has && !now && (
                  <span aria-hidden className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-emerald-500" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-3 py-2 border-t border-slate-200 dark:border-dark-border max-h-48 overflow-y-auto">
        <p className="text-xs font-medium text-slate-400 mb-1.5">Сегодня</p>
        {today.length === 0 && <p className="text-2xs text-slate-400 pb-1">Ничего не назначено.</p>}
        {today.map((o) => (
          <div key={`${o.event.id}-${o.startsAt}`} className="flex items-center gap-2 py-1">
            <span className="shrink-0 w-9 text-2xs font-mono text-slate-400 tabular-nums">
              {o.event.allDay ? '—' : timeLabel(o.startsAt)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-2xs text-slate-700 dark:text-slate-150 truncate">{o.event.title}</span>
              <span className="block text-2xs text-slate-400">{untilLabel(o.startsAt)}</span>
            </span>
            {o.event.joinUrl && (
              <button type="button" onClick={() => openLink(o.event.joinUrl)} title="Подключиться"
                aria-label="Подключиться к встрече"
                className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center cursor-pointer
                           text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40">
                <Video className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-dark-border
                      bg-slate-50 dark:bg-dark-bg">
        <button type="button" onClick={go}
          className="flex items-center gap-1.5 text-2xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Событие
        </button>
        <span className="flex-1" />
        <button type="button" onClick={go}
          className="flex items-center gap-1.5 text-2xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
          Открыть <Maximize2 className="w-3 h-3" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
