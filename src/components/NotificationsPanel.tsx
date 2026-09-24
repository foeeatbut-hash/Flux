/**
 * Центр уведомлений: что пришло, что отложено и когда вернётся.
 *
 * Две вкладки. «Общие» — события программы и проекта (журнал изменений) по
 * дням. «Личные» — адресованные лично мне, по подразделам.
 *
 * Появилось то, чего не хватало больше всего: «не беспокоить» и «отложить».
 * Уведомление, пришедшее не вовремя, раньше можно было только закрыть — то
 * есть забыть. Теперь его можно отодвинуть на пятнадцать минут или до утра, и
 * оно вернётся само; а на время сверки ведомости весь поток можно приглушить,
 * не выключая уведомления насовсем в настройках.
 *
 * Счёт (когда вернуть, тихо ли сейчас, что показывать) — в src/lib/notifCenter.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, X, Globe, UserCircle, Clock, ExternalLink, CheckCheck } from 'lucide-react';
import { useStore } from '../store/store';
import { useNotificationStore } from '../store/notificationStore';
import { useShellNotifyStore } from '../store/shellNotifyStore';
import { dataService, SystemChangeLog } from '../services/dataService';
import {
  groupByDay, visibleNow, isQuiet, untilLabel, mergeFeed, unreadIn,
  SNOOZE_CHOICES, QUIET_CHOICES, type FeedFilter,
} from '../lib/notifCenter';

/** Фильтр ленты: три слова вместо двух вкладок */
const FILTERS: { id: FeedFilter; label: string; icon: React.ReactNode }[] = [
  { id: 'all', label: 'Все', icon: <Bell className="w-3.5 h-3.5" /> },
  { id: 'personal', label: 'Личные', icon: <UserCircle className="w-3.5 h-3.5" /> },
  { id: 'system', label: 'Система', icon: <Globe className="w-3.5 h-3.5" /> },
];

const catColor: Record<string, string> = {
  СИСТЕМА: 'text-slate-500',
  ОБОРУДОВАНИЕ: 'text-emerald-600',
  ЧАТ: 'text-emerald-500',
  ПРОЕКТЫ: 'text-amber-600',
  ДОСТУП: 'text-rose-600',
  ДОКУМЕНТЫ: 'text-sky-600',
};

export default function NotificationsPanel() {
  const { user } = useStore();
  const { panelOpen, setPanelOpen, personal, fetch, markAllRead } = useNotificationStore();
  const quiet = useShellNotifyStore((s) => s.quiet);
  const setQuiet = useShellNotifyStore((s) => s.setQuiet);
  const snoozed = useShellNotifyStore((s) => s.snoozed);
  const snooze = useShellNotifyStore((s) => s.snooze);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [logs, setLogs] = useState<SystemChangeLog[]>([]);
  const [snoozing, setSnoozing] = useState<string | null>(null);

  useEffect(() => {
    if (!panelOpen) return;
    dataService.getLogs().then((l) => setLogs(l.slice(0, 60))).catch(() => {});
    if (user?.id) fetch(user.id);
  }, [panelOpen]);

  // Открытую панель считаем прочитанной: человек её видит. Раньше это
  // случалось только на вкладке «Личные», и счётчик горел, пока туда не зайдёшь
  useEffect(() => {
    if (panelOpen && user?.id) {
      const t = setTimeout(() => markAllRead(user.id), 1200);
      return () => clearTimeout(t);
    }
  }, [panelOpen, user?.id]);

  const fmt = (iso?: string) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };

  const go = (route?: string) => {
    if (route && route !== '#') { navigate(route); setPanelOpen(false); }
  };

  const shown = useMemo(() => visibleNow(personal, snoozed), [personal, snoozed]);
  // Одна лента вместо двух вкладок: правила слияния — в lib/notifCenter,
  // потому что «что и в каком порядке видно» имеет правильный ответ
  const feedAll = useMemo(() => mergeFeed(shown, logs, 'all'), [shown, logs]);
  const feed = useMemo(() => mergeFeed(shown, logs, filter), [shown, logs, filter]);
  const days = useMemo(() => groupByDay(feed), [feed]);
  const hidden = personal.length - shown.length;
  const quietNow = isQuiet(quiet);

  // Где стоит панель и сколько ей места — решает правая колонка
  // (components/RightDock): панелей две, и делить колонку они обязаны вместе.
  // Здесь остаётся только содержимое
  if (!panelOpen) return null;

  return (
    <div className="h-full w-full flex flex-col bg-white dark:bg-slate-900">
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800
                        bg-gradient-to-r from-amber-500/10 to-transparent shrink-0">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${quietNow ? 'bg-slate-400' : 'bg-amber-500'}`}>
              {quietNow ? <BellOff className="w-4 h-4 text-white" /> : <Bell className="w-4 h-4 text-white" />}
            </div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Уведомления</h2>
          </div>
          <button type="button" onClick={() => setPanelOpen(false)} title="Закрыть"
            className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400
                       hover:text-slate-700 dark:hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Тихий режим: приглушить поток, не выключая уведомления насовсем */}
        <div className="px-3 py-2 shrink-0 border-b border-slate-100 dark:border-slate-850">
          {quietNow ? (
            <div className="flex items-center gap-2">
              <BellOff className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="flex-1 text-2xs text-slate-500 dark:text-slate-400">
                Тихий режим {untilLabel(quiet!)} — всплывашек не будет, счётчики считают
              </span>
              <button type="button" onClick={() => setQuiet(null)}
                className="px-2 py-1 rounded-md text-2xs font-semibold text-emerald-700 dark:text-emerald-400
                           hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
                Включить
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-2xs text-slate-400 px-1 shrink-0">Не беспокоить</span>
              {QUIET_CHOICES.map((c) => (
                <button key={c.id} type="button" onClick={() => setQuiet(c.id)}
                  className="px-2 py-1 rounded-md text-2xs font-semibold text-slate-600 dark:text-slate-300
                             hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Фильтр из трёх слов вместо двух вкладок. Событие приходит во
            времени, а не по вкладкам: лента одна, а «только своё» —
            это выбор, а не два разных места, где надо искать пропущенное */}
        <div className="flex p-1.5 gap-1 border-b border-slate-100 dark:border-slate-800 shrink-0">
          {FILTERS.map((ftr) => (
            <button key={ftr.id} type="button" onClick={() => setFilter(ftr.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                filter === ftr.id ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850'
              }`}>
              {ftr.icon} {ftr.label}
              {ftr.id === 'personal' && unreadIn(feedAll.filter((i) => i.kind === 'personal')) > 0 && (
                <span className="min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-2xs font-bold flex items-center justify-center">
                  {unreadIn(feedAll.filter((i) => i.kind === 'personal'))}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
          {days.length === 0 && <Empty text={filter === 'personal' ? 'Личных уведомлений нет' : 'Пока ничего не приходило'} />}
          {days.map((day) => (
            <div key={day.title}>
              <div className="px-2 pt-2 pb-1 text-2xs font-bold text-slate-400 sticky top-0 bg-white dark:bg-slate-900">
                {day.title}
              </div>
              {day.items.map((n) => (
                /* Непрочитанное отмечено полосой слева, а не заливкой всей
                   строки: заливка спорит с выделением и делает список пёстрым */
                <div key={n.id}
                  className={`p-2.5 rounded-lg border-l-2 transition-colors hover:bg-slate-50 dark:hover:bg-slate-850 ${
                    n.isRead ? 'border-l-transparent' : 'border-l-amber-500'
                  }`}>
                  <div className="flex items-start gap-1.5">
                    <div className={`text-xs leading-snug flex-1 ${
                      n.kind === 'personal' ? 'font-semibold text-slate-800 dark:text-slate-300' : 'text-slate-700 dark:text-slate-400'
                    }`}>{n.title}</div>
                    <span className={`text-2xs shrink-0 ${catColor[n.category] || 'text-slate-400'}`}>
                      {n.kind === 'personal' ? 'вам' : ''}
                    </span>
                  </div>
                  {n.body && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{n.body}</div>}
                  <div className="flex items-center gap-1 mt-1.5">
                    <span className="text-2xs text-slate-400 flex items-center gap-0.5 mr-auto">
                      {n.who ? <span className="font-semibold text-slate-500 dark:text-slate-400 mr-1">{n.who}</span> : null}
                      <Clock className="w-2.5 h-2.5" />{fmt(n.createdAt)}
                    </span>
                    {n.kind === 'personal' && (snoozing === n.id ? (
                      SNOOZE_CHOICES.map((c) => (
                        <button key={c.id} type="button" onClick={() => { snooze(n.id.slice(2), c.id); setSnoozing(null); }}
                          className="px-1.5 py-0.5 rounded-md text-2xs font-semibold text-slate-600 dark:text-slate-300
                                     hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
                          {c.label}
                        </button>
                      ))
                    ) : (
                      <button type="button" onClick={() => setSnoozing(n.id)} title="Вернуть позже"
                        className="p-1 rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                        <Clock className="w-3 h-3" />
                      </button>
                    ))}
                    {n.targetRoute && n.targetRoute !== '#' && (
                      <button type="button" onClick={() => go(n.targetRoute)} title="Открыть"
                        className="p-1 rounded-md text-emerald-700 dark:text-emerald-400
                                   hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {hidden > 0 && (
            <div className="px-2 py-2 text-2xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
              <Clock className="w-3 h-3 shrink-0" />
              Отложено: {hidden}. Вернутся сами — ничего не потеряется.
            </div>
          )}
        </div>

        {/* «Прочитать всё» всегда на одном месте — внизу панели, а не в конце
            списка, где его надо сначала домотать */}
        {unreadIn(feedAll) > 0 && (
          <button type="button" onClick={() => user?.id && markAllRead(user.id)}
            className="shrink-0 w-full flex items-center justify-center gap-1.5 py-2.5 border-t border-slate-200 dark:border-slate-800
                       text-2xs font-semibold text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-400
                       hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer">
            <CheckCheck className="w-3.5 h-3.5" /> Прочитать всё
          </button>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 py-16 text-xs">
      <Bell className="w-8 h-8 mb-2 opacity-40" />
      {text}
    </div>
  );
}
