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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, X, Globe, UserCircle, Clock, ExternalLink, CheckCheck } from 'lucide-react';
import { useStore } from '../store/store';
import { useNotificationStore } from '../store/notificationStore';
import { useShellNotifyStore } from '../store/shellNotifyStore';
import { dataService, SystemChangeLog } from '../services/dataService';
import type { WindowsNotificationsSnapshot } from '../../filesystem/windowsNotifications';
import {
  groupByDay, visibleNow, isQuiet, untilLabel, mergeFeed, unreadIn,
  SNOOZE_CHOICES, QUIET_CHOICES, type FeedFilter, type FeedItem,
} from '../lib/notifCenter';

/** Фильтр ленты: три слова вместо двух вкладок */
const FILTERS: { id: FeedFilter; label: string; icon: React.ReactNode }[] = [
  { id: 'all', label: 'Все', icon: <Bell className="w-3.5 h-3.5" /> },
  { id: 'personal', label: 'Личные', icon: <UserCircle className="w-3.5 h-3.5" /> },
  { id: 'system', label: 'Система', icon: <Globe className="w-3.5 h-3.5" /> },
  { id: 'windows', label: 'Windows', icon: <Globe className="w-3.5 h-3.5" /> },
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
  const user = useStore((s) => s.user);
  const { panelOpen, setPanelOpen, personal, fetch, markAllRead, markRead } = useNotificationStore();
  const quiet = useShellNotifyStore((s) => s.quiet);
  const setQuiet = useShellNotifyStore((s) => s.setQuiet);
  const snoozed = useShellNotifyStore((s) => s.snoozed);
  const snooze = useShellNotifyStore((s) => s.snooze);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [logs, setLogs] = useState<SystemChangeLog[]>([]);
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [windows, setWindows] = useState<WindowsNotificationsSnapshot>({status:'unsupported',items:[]});
  const [connectingWindows, setConnectingWindows] = useState(false);
  const [windowsMessage, setWindowsMessage] = useState('');
  useEffect(() => {
    const bridge = (window as any).electron?.windowsNotifications;
    if (!panelOpen || !user?.id || !bridge) { setWindows({status:'unsupported',items:[]}); return; }
    let alive = true; let busy = false;
    const refresh = async () => {
      if (!alive || busy) return;
      busy = true;
      try { const snapshot = await bridge.snapshot(); if (alive) setWindows(snapshot); }
      catch { if (alive) setWindows({status:'unavailable',items:[],message:'Не удалось прочитать уведомления Windows.'}); }
      finally { busy = false; }
    };
    void refresh();
    const off = bridge.onChanged?.(() => void refresh());
    return () => { alive = false; off?.(); };
  }, [panelOpen, user?.id]);
  const windowsFeed = useMemo<FeedItem[]>(() => windows.items.map(item => ({
    id:`w:${item.id}`,kind:'windows',title:item.title,body:item.body,who:item.appName,
    category:'WINDOWS',isRead:true,createdAt:item.createdAt,
  })), [windows.items]);

  useEffect(() => {
    if (!panelOpen) return;
    dataService.getLogs().then((l) => setLogs(l.slice(0, 60))).catch(() => {});
    if (user?.id) fetch(user.id);
  }, [panelOpen]);

  const fmt = (iso?: string) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };

  const go = (route?: string) => {
    if (route === '/updates' || route === '/settings?section=updates') { window.dispatchEvent(new Event('flux:open-updates')); setPanelOpen(false); return; }
    if (route && route !== '#') { navigate(route); setPanelOpen(false); }
  };

  const snoozedUntil = useMemo(() => Object.fromEntries(
    Object.entries(snoozed).map(([id, entry]) => [id, entry.until]),
  ), [snoozed]);
  const shown = useMemo(() => visibleNow(personal, snoozedUntil), [personal, snoozedUntil]);
  // Одна лента вместо двух вкладок: правила слияния — в lib/notifCenter,
  // потому что «что и в каком порядке видно» имеет правильный ответ
  const feedAll = useMemo(() => [...mergeFeed(shown, logs, 'all'),...windowsFeed].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)), [shown, logs, windowsFeed]);
  const feed = useMemo(() => filter === 'all' ? feedAll : filter === 'windows' ? windowsFeed : mergeFeed(shown, logs, filter), [shown, logs, filter, feedAll, windowsFeed]);
  const days = useMemo(() => groupByDay(feed), [feed]);
  const hidden = personal.length - shown.length;
  const quietNow = isQuiet(quiet);

  // Одна открытая панель ещё не значит, что человек просмотрел каждую строку.
  // Отмечаем только личные карточки, которые были видны почти целиком секунду.
  useEffect(() => {
    const root = feedRef.current;
    if (!panelOpen || !root || !user?.id || typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.personalId;
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.8 && !document.hidden) {
          if (!timers.has(id)) timers.set(id, setTimeout(() => {
            timers.delete(id);
            if (!document.hidden) void markRead(user.id, id);
          }, 900));
        } else {
          const timer = timers.get(id);
          if (timer) clearTimeout(timer);
          timers.delete(id);
        }
      }
    }, { root, threshold: [0, 0.8, 1] });
    root.querySelectorAll<HTMLElement>('[data-personal-id]').forEach((node) => observer.observe(node));
    return () => { observer.disconnect(); timers.forEach(clearTimeout); };
  }, [panelOpen, user?.id, feed, markRead]);

  // Где стоит панель и сколько ей места — решает правая колонка
  // (components/RightDock): панелей две, и делить колонку они обязаны вместе.
  // Здесь остаётся только содержимое
  if (!panelOpen) return null;

  return (
    <div className="h-full w-full flex flex-col bg-white dark:bg-slate-900">
      <div className="h-full flex flex-col">
        {/* Шапка по методологии: название и закрыть. Градиент и значок в
            цветной плитке ушли; «не беспокоить» видно по значку рядом с
            названием и по строке под шапкой */}
        <div className="fx-head !px-3">
          <h2 className="fx-head-title">Уведомления</h2>
          {quietNow && <BellOff className="w-3.5 h-3.5 text-slate-400" aria-label="Не беспокоить" />}
          <button type="button" onClick={() => setPanelOpen(false)} title="Закрыть" aria-label="Закрыть"
            className="fx-ibtn ml-auto">
            <X />
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
        <div className="fx-seg px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
          {FILTERS.map((ftr) => (
            <button key={ftr.id} type="button" onClick={() => setFilter(ftr.id)} aria-pressed={filter === ftr.id}>
              {ftr.label}
              {ftr.id === 'personal' && unreadIn(feedAll.filter((i) => i.kind === 'personal')) > 0 && (
                <span className="fx-badge fx-badge-accent">{unreadIn(feedAll.filter((i) => i.kind === 'personal'))}</span>
              )}
            </button>
          ))}
        </div>

        <div ref={feedRef} className="flex-1 overflow-y-auto scrollbar-thin px-1 pb-2">
          {filter === 'windows' && windows.status !== 'ready' && <div className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">
            <p className="break-words">{windowsMessage || windows.message || 'Для уведомлений Windows установите компонент Flux Notification Bridge и разрешите ему доступ. Уведомления Flux работают независимо.'}</p>
            {(window as any).electron?.windowsNotifications && <button type="button" disabled={connectingWindows} className="fx-btn mt-2" onClick={async () => {
              setConnectingWindows(true); setWindowsMessage('');
              try { const result = await (window as any).electron.windowsNotifications.requestConsent(); setWindowsMessage(result.message || 'Разрешите доступ в открывшемся окне Windows.'); }
              catch { setWindowsMessage('Компонент уведомлений Windows не удалось открыть.'); }
              finally { setConnectingWindows(false); }
            }}>{connectingWindows ? 'Открываю…' : 'Подключить уведомления Windows'}</button>}
          </div>}
          {days.length === 0 && <Empty text={filter === 'personal' ? 'Личных уведомлений нет' : filter === 'windows' ? 'Уведомлений Windows нет' : 'Пока ничего не приходило'} />}
          {days.map((day) => (
            <div key={day.title}>
              <div className="fx-gh sticky top-0 bg-white dark:bg-slate-900">
                {day.title}
              </div>
              {day.items.map((n) => (
                /* Непрочитанное отмечено точкой перед заголовком, а не заливкой и
                   не полосой слева: полоса по методологии — примета
                   сгенерированного интерфейса, заливка спорит с выделением */
                <div key={n.id} data-personal-id={n.kind === 'personal' && !n.isRead ? n.id.slice(2) : undefined}
                  className="px-2 py-2 rounded-md transition-colors hover:bg-slate-50 dark:hover:bg-slate-850 border-b border-slate-100 dark:border-slate-850 last:border-b-0">
                  <div className="flex items-start gap-1.5">
                    <span aria-label={n.isRead ? undefined : 'Не прочитано'} className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${n.isRead ? 'bg-transparent' : 'bg-emerald-500'}`} />
                    <div className={`min-w-0 flex-1 break-words text-sm leading-snug ${
                      n.kind === 'personal' ? 'font-medium text-slate-800 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'
                    }`}>{n.title}</div>
                    <span className={`text-2xs shrink-0 ${catColor[n.category] || 'text-slate-400'}`}>
                      {n.kind === 'personal' ? 'вам' : n.kind === 'windows' ? 'Windows' : ''}
                    </span>
                  </div>
                  {n.body && <div className="break-words text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{n.body}</div>}
                  <div className="flex items-center gap-1 mt-1.5">
                    <span className="text-2xs text-slate-400 flex items-center gap-0.5 mr-auto">
                      {n.who ? <span className="min-w-0 break-words font-semibold text-slate-500 dark:text-slate-400 mr-1">{n.who}</span> : null}
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
            className="shrink-0 w-full flex items-center justify-center gap-1.5 h-10 border-t border-slate-200 dark:border-slate-800
                       text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">
            <CheckCheck className="w-3.5 h-3.5" /> Прочитать всё
          </button>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="fx-empty"><div className="fx-empty-title">{text}</div></div>
  );
}
