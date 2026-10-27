/**
 * Календарь под уведомлениями — нижняя карточка правой панели, как в Windows 11.
 *
 * Часы в трее человек нажимает не чтобы узнать время (оно и так написано), а
 * чтобы посмотреть, что сегодня и что впереди. Поэтому здесь месяц с сегодняшним
 * днём и точками у дней с событиями, список событий на сегодня, подключение к
 * встрече одной кнопкой и переход в раздел «Календарь».
 *
 * Карточка не знает, где стоит и когда закрывается: это решает правая колонка
 * (components/RightDock). Складывается до одной строки с датой — календарь
 * нужен не всегда, а место справа не резиновое.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Maximize2, Video, ChevronUp, ChevronDown } from 'lucide-react';
import { useStore } from '../../store/store';
import { useCalendarStore } from '../../store/calendarStore';
import { useNotificationStore } from '../../store/notificationStore';
import { rememberSectionUse } from '../../store/workspaceStore';
import { openLink } from '../../lib/openLink';
import {
  monthGrid, occurrences, dayOccurrences, startOfMonth, monthLabel,
  timeLabel, untilLabel, sameDay, inMonth, WEEKDAYS, DAY,
} from '../../lib/calendar';

const FOLD_KEY = 'flux_calendar_folded';

/** «вторник, 27 октября» — заголовок карточки */
const todayTitle = (now: number): string =>
  new Date(now).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

export default function CalendarCard() {
  const navigate = useNavigate();
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const projectId = useStore((s) => s.activeProject?.id) || '';
  const st = useCalendarStore();
  const [month, setMonth] = React.useState(() => Date.now());
  const [folded, setFolded] = React.useState(() => {
    try { return localStorage.getItem(FOLD_KEY) === '1'; } catch (_) { return false; }
  });

  React.useEffect(() => { void st.load(projectId); }, [projectId]);

  const toggleFold = () => setFolded((v) => {
    try { localStorage.setItem(FOLD_KEY, v ? '0' : '1'); } catch (_) { /* приватный режим */ }
    return !v;
  });

  const grid = monthGrid(month);
  const list = occurrences(st.visible(), grid[0], grid[41] + DAY);
  const today = dayOccurrences(list, Date.now());

  const go = () => { rememberSectionUse('/calendar'); navigate('/calendar'); setPanelOpen(false); };
  const shift = (delta: number) => { const d = new Date(month); d.setMonth(d.getMonth() + delta); setMonth(d.getTime()); };

  return (
    <section
      aria-label="Календарь"
      data-dock-calendar
      className="fx-glass rounded-xl overflow-hidden shrink-0 flex flex-col"
    >
      <button type="button" onClick={toggleFold} aria-expanded={!folded}
        title={folded ? 'Развернуть календарь' : 'Свернуть календарь'}
        className="flex items-center gap-2 h-10 px-4 cursor-pointer text-left hover:bg-slate-500/10 transition-colors">
        <span className="flex-1 text-sm font-medium text-slate-800 dark:text-slate-100 first-letter:uppercase">{todayTitle(Date.now())}</span>
        {folded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {!folded && (
        <>
          <div className="flex items-center gap-1 px-3 pb-1">
            <span className="flex-1 text-xs font-medium text-slate-600 dark:text-slate-300 first-letter:uppercase">{monthLabel(month)}</span>
            <button type="button" onClick={() => shift(-1)} aria-label="Прошлый месяц"
              className="w-7 h-7 rounded-md cursor-pointer text-slate-500 hover:bg-slate-500/15">‹</button>
            <button type="button" onClick={() => shift(1)} aria-label="Следующий месяц"
              className="w-7 h-7 rounded-md cursor-pointer text-slate-500 hover:bg-slate-500/15">›</button>
          </div>

          <div className="px-3 pb-2">
            <div className="grid grid-cols-7 mb-1">
              {WEEKDAYS.map((d) => (
                <span key={d} className="text-center text-2xs text-slate-500 dark:text-slate-400">{d}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((day) => {
                const has = dayOccurrences(list, day).length > 0;
                const now = sameDay(day, Date.now());
                const other = !inMonth(day, startOfMonth(month));
                return (
                  <button key={day} type="button" onClick={go} data-today={now || undefined}
                    className={`relative h-8 rounded-full text-xs cursor-pointer
                                ${now ? 'bg-emerald-600 text-white font-semibold'
                                  : other ? 'text-slate-400 dark:text-slate-500 hover:bg-slate-500/15'
                                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-500/15'}`}>
                    {new Date(day).getDate()}
                    {has && !now && (
                      <span aria-hidden className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-emerald-500" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-2 border-t border-slate-500/20 max-h-40 overflow-y-auto scrollbar-thin">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Сегодня</p>
            {today.length === 0 && <p className="text-xs text-slate-500 dark:text-slate-400 pb-1">Ничего не назначено.</p>}
            {today.map((o) => (
              <div key={`${o.event.id}-${o.startsAt}`} className="flex items-center gap-2 py-1">
                <span className="shrink-0 w-10 text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                  {o.event.allDay ? '—' : timeLabel(o.startsAt)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-slate-800 dark:text-slate-100 truncate">{o.event.title}</span>
                  <span className="block text-2xs text-slate-500 dark:text-slate-400">{untilLabel(o.startsAt)}</span>
                </span>
                {o.event.joinUrl && (
                  <button type="button" onClick={() => openLink(o.event.joinUrl)} title="Подключиться"
                    aria-label="Подключиться к встрече"
                    className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center cursor-pointer
                               text-emerald-700 dark:text-emerald-400 hover:bg-slate-500/15">
                    <Video className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 px-3 h-10 border-t border-slate-500/20">
            <button type="button" onClick={go}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer hover:underline">
              <Plus className="w-3.5 h-3.5" /> Событие
            </button>
            <span className="flex-1" />
            <button type="button" onClick={go}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer hover:underline">
              Открыть <Maximize2 className="w-3 h-3" />
            </button>
          </div>
        </>
      )}
    </section>
  );
}
