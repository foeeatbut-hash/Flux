/**
 * Календарь — программа с окном.
 *
 * Четыре вида, и каждый отвечает на свой вопрос. Месяц — «что вообще в этом
 * месяце». Неделя — «как выглядит моя неделя». День — «что сегодня по часам».
 * Сроки — «что и когда мы обязаны отдать»; это список, а не сетка, потому что
 * сроки читают списком, а не по клеткам.
 *
 * Счёт сетки, повторов и подписей — src/lib/calendar.ts: там же он и
 * проверяется. Здесь только разметка и то, что человек нажимает.
 */
import React from 'react';
import {
  ChevronLeft, ChevronRight, Plus, Video, Clock, Users, Link2, Lock, CalendarDays, ListChecks,
} from 'lucide-react';
import { useStore } from '../store/store';
import { useCalendarStore } from '../store/calendarStore';
import { openLink } from '../lib/openLink';
import EventDialog, { type Draft } from '../components/calendar/EventDialog';
import {
  monthGrid, occurrences, dayOccurrences, startOfDay, startOfWeek, startOfMonth,
  monthLabel, dateLabel, timeLabel, rangeLabel, untilLabel, weekday, sameDay, inMonth,
  KIND_LABEL, WEEKDAYS, DAY, HOUR, MINUTE, type Occurrence,
} from '../lib/calendar';

type View = 'month' | 'week' | 'day' | 'due';

const TONE: Record<string, string> = {
  emerald: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/60',
  amber: 'bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-900/60',
  sky: 'bg-sky-50 dark:bg-sky-950/20 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-900/60',
  slate: 'bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-150 border-slate-200 dark:border-slate-800',
};

const toneOf = (o: Occurrence): string =>
  TONE[o.event.kind === 'deadline' ? 'amber' : o.event.kind === 'reminder' ? 'sky' : o.event.kind === 'note' ? 'slate' : 'emerald'];

export default function CalendarScreen() {
  const activeProject = useStore((s) => s.activeProject);
  const st = useCalendarStore();
  const [view, setView] = React.useState<View>('month');
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const [draft, setDraft] = React.useState<Draft | null>(null);

  const projectId = activeProject?.id || '';
  React.useEffect(() => { void st.load(projectId); }, [projectId]);

  // Событие могли начать со стороны: строкой «/встреча» или из письма.
  // Забираем черновик один раз и сразу гасим
  React.useEffect(() => {
    if (!st.draft) return;
    setDraft(st.draft);
    setAnchor(st.draft.startsAt || Date.now());
    st.setDraft(null);
  }, [st.draft]);

  const events = st.visible();

  // Окно раскрытия повторов — по виду: месяцу нужна сетка целиком, дню — сутки
  const [from, to] = React.useMemo(() => {
    if (view === 'day') return [startOfDay(anchor), startOfDay(anchor) + DAY];
    if (view === 'week') return [startOfWeek(anchor), startOfWeek(anchor) + 7 * DAY];
    if (view === 'due') return [Date.now() - 30 * DAY, Date.now() + 180 * DAY];
    const grid = monthGrid(anchor);
    return [grid[0], grid[41] + DAY];
  }, [view, anchor]);

  const list = React.useMemo(() => occurrences(events, from, to), [events, from, to]);

  const step = (dir: number) => {
    const d = new Date(anchor);
    if (view === 'day') d.setDate(d.getDate() + dir);
    else if (view === 'week') d.setDate(d.getDate() + 7 * dir);
    else d.setMonth(d.getMonth() + dir);
    setAnchor(d.getTime());
  };

  const openAt = (t: number) => setDraft({
    startsAt: t, endsAt: t + 30 * MINUTE, kind: 'meeting', visibility: 'project',
  });

  const openEvent = (o: Occurrence) => {
    const e = o.event;
    setDraft({
      id: e.id.startsWith('vdr:') ? e.id : e.id,
      kind: e.kind, title: e.title, description: e.description,
      startsAt: o.startsAt, endsAt: o.endsAt, allDay: e.allDay, rrule: e.rrule,
      place: e.place, joinUrl: e.joinUrl, remindMin: e.remindMin,
      visibility: e.visibility, guests: e.guests.map((g) => g.userId),
    });
  };

  const title = view === 'day'
    ? `${dateLabel(anchor)}, ${WEEKDAYS[weekday(anchor)].toLowerCase()}`
    : view === 'week'
      ? `${dateLabel(startOfWeek(anchor))} – ${dateLabel(startOfWeek(anchor) + 6 * DAY)}`
      : monthLabel(anchor);

  const tab = (id: View, label: string) => (
    <button key={id} type="button" onClick={() => setView(id)}
      className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
        view === id ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs'
          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}>
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-white dark:bg-dark-surface">
      {/* Шапка: куда смотрим и чем */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <button type="button" onClick={() => step(-1)} aria-label="Назад"
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Вперёд"
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850">
          <ChevronRight className="w-4 h-4" />
        </button>
        <h1 className="text-sm font-bold text-slate-800 dark:text-slate-100 min-w-0 truncate">{title}</h1>
        <button type="button" onClick={() => setAnchor(Date.now())}
          className="px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850">
          сегодня
        </button>

        <span className="flex-1" />

        <div className="flex bg-slate-100 dark:bg-slate-900 p-0.5 rounded-xl">
          {tab('day', 'День')}{tab('week', 'Неделя')}{tab('month', 'Месяц')}{tab('due', 'Сроки')}
        </div>

        <button type="button" onClick={() => openAt(startOfDay(anchor) + 10 * HOUR)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer
                     bg-emerald-600 text-white hover:bg-emerald-700">
          <Plus className="w-3.5 h-3.5" /> Событие
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Какие календари показывать */}
        <aside className="hidden @[900px]:flex w-48 shrink-0 flex-col gap-1 p-3 border-r border-slate-200 dark:border-dark-border">
          <p className="text-2xs font-bold uppercase tracking-wider text-slate-400 mb-1">Календари</p>
          {([
            { id: 'project', label: 'События проекта', tone: 'bg-emerald-500' },
            { id: 'deadlines', label: 'Сроки ВДР', tone: 'bg-amber-500' },
            { id: 'private', label: 'Личное', tone: 'bg-sky-500' },
          ] as const).map((c) => (
            <button key={c.id} type="button"
              onClick={() => st.setShown({ [c.id]: !st.shown[c.id] } as any)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer
                         hover:bg-slate-100 dark:hover:bg-slate-850">
              <span className={`w-3 h-3 rounded shrink-0 ${st.shown[c.id] ? c.tone : 'bg-slate-200 dark:bg-slate-800'}`} />
              <span className={`text-xs ${st.shown[c.id] ? 'text-slate-700 dark:text-slate-150' : 'text-slate-400'}`}>
                {c.label}
              </span>
            </button>
          ))}

          {st.error && (
            <p className="mt-3 text-2xs text-rose-600 dark:text-rose-400">Календарь не прочитан: {st.error}</p>
          )}

          <div className="mt-auto pt-3 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">
            Сроки ВДР приходят из реестра и здесь только показываются — двигать их надо в Менеджменте.
          </div>
        </aside>

        <div className="flex-1 min-w-0 overflow-auto">
          {view === 'month' && <MonthView anchor={anchor} list={list} onDay={openAt} onEvent={openEvent} />}
          {view === 'week' && <WeekView anchor={anchor} list={list} onDay={openAt} onEvent={openEvent} />}
          {view === 'day' && <DayView anchor={anchor} list={list} onEvent={openEvent} onAt={openAt} />}
          {view === 'due' && <DueView list={list} onEvent={openEvent} />}
        </div>
      </div>

      {draft && <EventDialog draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}

/** Полоска события в сетке: время, название и признак встречи со ссылкой */
function Chip({ o, onClick }: { o: Occurrence; onClick: () => void }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`${o.event.title} · ${rangeLabel(o, o.event.allDay)} · ${KIND_LABEL[o.event.kind]}`}
      className={`w-full flex items-center gap-1 px-1.5 py-0.5 rounded border text-left cursor-pointer
                  text-2xs truncate ${toneOf(o)}`}>
      {!o.event.allDay && <span className="shrink-0 font-mono opacity-70">{timeLabel(o.startsAt)}</span>}
      {o.event.joinUrl && <Video className="w-2.5 h-2.5 shrink-0" />}
      {o.event.visibility === 'private' && <Lock className="w-2.5 h-2.5 shrink-0" />}
      <span className="truncate">{o.event.title}</span>
    </button>
  );
}

function MonthView({ anchor, list, onDay, onEvent }: {
  anchor: number; list: Occurrence[]; onDay: (t: number) => void; onEvent: (o: Occurrence) => void;
}) {
  const grid = monthGrid(anchor);
  const month = startOfMonth(anchor);
  return (
    <div className="min-w-[640px]">
      <div className="grid grid-cols-7 border-b border-slate-200 dark:border-dark-border">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1 text-2xs font-bold uppercase tracking-wider text-slate-400 text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {grid.map((day) => {
          const items = dayOccurrences(list, day);
          const today = sameDay(day, Date.now());
          const other = !inMonth(day, month);
          return (
            /* Клетка дня — не кнопка. Кнопкой она была, а внутри неё стояли
               кнопки событий: разметка недопустимая, и React ругался на каждой
               отрисовке месяца. Ругань по устройству программы попадает в
               Журнал, и он засорялся при каждом открытии Календаря. Теперь
               кнопка одна — число дня, за неё же берётся клавиатура, — а
               нажатие по пустому месту клетки открывает день как раньше */
            <div key={day} role="gridcell" onClick={() => onDay(day + 10 * HOUR)}
              className={`min-h-[92px] p-1 border-b border-r border-slate-100 dark:border-slate-850 text-left
                          align-top cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/60
                          ${other ? 'bg-slate-50/60 dark:bg-slate-900/30' : ''}`}>
              <button type="button" onClick={(e) => { e.stopPropagation(); onDay(day + 10 * HOUR); }}
                title={`Открыть ${new Date(day).toLocaleDateString('ru-RU')}`}
                className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-2xs font-semibold mb-1 cursor-pointer
                                ${today ? 'bg-emerald-600 text-white' : other ? 'text-slate-300 dark:text-slate-500' : 'text-slate-500 dark:text-slate-400'}`}>
                {new Date(day).getDate()}
              </button>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((o) => (
                  <Chip key={`${o.event.id}-${o.startsAt}`} o={o} onClick={() => onEvent(o)} />
                ))}
                {items.length > 3 && (
                  <span className="block px-1 text-2xs text-slate-400">ещё {items.length - 3}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({ anchor, list, onDay, onEvent }: {
  anchor: number; list: Occurrence[]; onDay: (t: number) => void; onEvent: (o: Occurrence) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => startOfWeek(anchor) + i * DAY);
  return (
    <div className="grid grid-cols-7 min-w-[720px] h-full">
      {days.map((day) => {
        const items = dayOccurrences(list, day);
        const today = sameDay(day, Date.now());
        return (
          <div key={day} className="border-r border-slate-100 dark:border-slate-850 flex flex-col min-h-0">
            <button type="button" onClick={() => onDay(day + 10 * HOUR)}
              className="shrink-0 px-2 py-1.5 text-left cursor-pointer border-b border-slate-200 dark:border-dark-border
                         hover:bg-slate-50 dark:hover:bg-slate-900/60">
              <span className="block text-2xs uppercase tracking-wider text-slate-400">{WEEKDAYS[weekday(day)]}</span>
              <span className={`text-sm font-bold ${today ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-150'}`}>
                {new Date(day).getDate()}
              </span>
            </button>
            <div className="flex-1 overflow-y-auto p-1 space-y-1">
              {items.length === 0 && <span className="block px-1 py-2 text-2xs text-slate-300 dark:text-slate-500">—</span>}
              {items.map((o) => <Chip key={`${o.event.id}-${o.startsAt}`} o={o} onClick={() => onEvent(o)} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * День по часам. Рабочий день начинается с восьми: показывать ночь целиком
 * значит заставлять прокручивать сетку до первой встречи каждый раз.
 */
function DayView({ anchor, list, onEvent, onAt }: {
  anchor: number; list: Occurrence[]; onEvent: (o: Occurrence) => void; onAt: (t: number) => void;
}) {
  const day = startOfDay(anchor);
  const items = dayOccurrences(list, day);
  const hours = Array.from({ length: 15 }, (_, i) => i + 7);
  return (
    <div className="p-2">
      {items.length === 0 && (
        <p className="px-2 py-3 text-xs text-slate-400">На этот день ничего не назначено.</p>
      )}
      {hours.map((h) => {
        const at = day + h * HOUR;
        const inHour = items.filter((o) => o.startsAt >= at && o.startsAt < at + HOUR);
        return (
          /* Строка часа — по той же причине не кнопка: внутри стоят кнопки
             событий. Кнопка здесь одна — сам час */
          <div key={h} onClick={() => onAt(at)}
            className="w-full flex items-start gap-3 px-2 py-1 text-left cursor-pointer rounded-lg
                       hover:bg-slate-50 dark:hover:bg-slate-900/60">
            <button type="button" onClick={(e) => { e.stopPropagation(); onAt(at); }}
              title={`Создать событие на ${String(h).padStart(2, '0')}:00`}
              className="shrink-0 w-10 pt-0.5 text-2xs font-mono text-slate-400 tabular-nums text-left cursor-pointer">
              {String(h).padStart(2, '0')}:00
            </button>
            <span className="flex-1 min-w-0 space-y-1 border-t border-slate-100 dark:border-slate-850 pt-1">
              {inHour.map((o) => (
                <span key={`${o.event.id}-${o.startsAt}`} className="block">
                  <Chip o={o} onClick={() => onEvent(o)} />
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Сроки — списком: их читают подряд, а не ищут по клеткам */
function DueView({ list, onEvent }: { list: Occurrence[]; onEvent: (o: Occurrence) => void }) {
  const rows = list.filter((o) => o.event.kind === 'deadline' || o.event.joinUrl);
  return (
    <div className="p-3 space-y-1">
      {rows.length === 0 && (
        <p className="text-xs text-slate-400">Сроков и встреч впереди нет.</p>
      )}
      {rows.map((o) => (
        <div key={`${o.event.id}-${o.startsAt}`}
          className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-dark-border">
          {o.event.kind === 'deadline'
            ? <ListChecks className="w-4 h-4 shrink-0 text-amber-500" />
            : <CalendarDays className="w-4 h-4 shrink-0 text-emerald-500" />}
          <button type="button" onClick={() => onEvent(o)}
            className="flex-1 min-w-0 text-left cursor-pointer">
            <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{o.event.title}</span>
            <span className="block text-2xs text-slate-500 dark:text-slate-400">
              {dateLabel(o.startsAt)} · {untilLabel(o.startsAt)}
              {o.event.guests.length > 0 && ` · ${o.event.guests.length} чел.`}
            </span>
          </button>
          {o.event.joinUrl && (
            <button type="button" onClick={() => openLink(o.event.joinUrl)}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-semibold cursor-pointer
                         bg-emerald-600 text-white hover:bg-emerald-700">
              <Link2 className="w-3 h-3" /> Подключиться
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
