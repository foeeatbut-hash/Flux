/**
 * Центр уведомлений: что пришло, сгруппированное по программам.
 *
 * Верхняя карточка правой панели (components/RightDock), под ней календарь.
 * Как в Windows 11: программа — заголовок группы со значком и счётчиком, под
 * ней её уведомления; «Удалить все» очищает ленту разом, «Очистить» у группы —
 * только эту программу.
 *
 * Удаление личное: сервер уведомления не стирает, это журнал, — на рабочем
 * месте скрывается всё, что пришло до нажатия (lib/notifCenter, `isCleared`).
 * Вместе с ним все личные отмечаются прочитанными, иначе счётчик на колокольчике
 * продолжал бы гореть над пустой панелью.
 *
 * Есть «отложить» и «не беспокоить»: уведомление, пришедшее не вовремя, раньше
 * можно было только закрыть — то есть забыть. Теперь его можно отодвинуть на
 * пятнадцать минут или до утра, а на время сверки ведомости приглушить весь
 * поток, не выключая уведомления насовсем в настройках.
 *
 * Счёт (когда вернуть, тихо ли сейчас, что показывать) — в src/lib/notifCenter.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, X, CheckCheck, Clock } from 'lucide-react';
import { useStore } from '../store/store';
import { useNotificationStore } from '../store/notificationStore';
import { useShellNotifyStore } from '../store/shellNotifyStore';
import { dataService, SystemChangeLog } from '../services/dataService';
import type { WindowsNotificationsSnapshot } from '../../filesystem/windowsNotifications';
import {
  visibleNow, isQuiet, untilLabel, mergeFeed, unreadIn, groupByApp, withoutCleared, clearMoment,
  QUIET_CHOICES, type FeedFilter, type FeedItem,
} from '../lib/notifCenter';
import { sectionForPath, isKnownSection } from '../workspace/sections';
import { AppIcon } from './icons/FluxIcons';
import ContextMenu from './ContextMenu';
import NotificationItem from './NotificationItem';

/** Фильтр ленты: четыре слова вместо вкладок */
const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'personal', label: 'Личные' },
  { id: 'system', label: 'Система' },
  { id: 'windows', label: 'Windows' },
];

/** Название программы по адресу перехода; адрес без раздела — сама оболочка */
const titleOf = (route: string) => (isKnownSection(route) && route !== '/' ? sectionForPath(route).title : 'Flux');

export default function NotificationsPanel() {
  const user = useStore((s) => s.user);
  const { panelOpen, setPanelOpen, personal, fetch, markAllRead, markRead } = useNotificationStore();
  const quiet = useShellNotifyStore((s) => s.quiet);
  const setQuiet = useShellNotifyStore((s) => s.setQuiet);
  const snoozed = useShellNotifyStore((s) => s.snoozed);
  const snooze = useShellNotifyStore((s) => s.snooze);
  const cleared = useShellNotifyStore((s) => s.cleared);
  const clearFeed = useShellNotifyStore((s) => s.clearFeed);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [logs, setLogs] = useState<SystemChangeLog[]>([]);
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const [quietMenu, setQuietMenu] = useState<{ x: number; y: number } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [windows, setWindows] = useState<WindowsNotificationsSnapshot>({ status: 'unsupported', items: [] });
  const [connectingWindows, setConnectingWindows] = useState(false);
  const [windowsMessage, setWindowsMessage] = useState('');
  useEffect(() => {
    const bridge = (window as any).electron?.windowsNotifications;
    if (!panelOpen || !user?.id || !bridge) { setWindows({ status: 'unsupported', items: [] }); return; }
    let alive = true; let busy = false;
    const refresh = async () => {
      if (!alive || busy) return;
      busy = true;
      try { const snapshot = await bridge.snapshot(); if (alive) setWindows(snapshot); }
      catch { if (alive) setWindows({ status: 'unavailable', items: [], message: 'Не удалось прочитать уведомления Windows.' }); }
      finally { busy = false; }
    };
    void refresh();
    const off = bridge.onChanged?.(() => void refresh());
    return () => { alive = false; off?.(); };
  }, [panelOpen, user?.id]);
  const windowsFeed = useMemo<FeedItem[]>(() => windows.items.map(item => ({
    id: `w:${item.id}`, kind: 'windows', title: item.title, body: item.body, who: item.appName,
    category: 'WINDOWS', isRead: true, createdAt: item.createdAt,
  })), [windows.items]);

  useEffect(() => {
    if (!panelOpen) return;
    dataService.getLogs().then((l) => setLogs(l.slice(0, 60))).catch(() => {});
    if (user?.id) fetch(user.id);
  }, [panelOpen]);

  const go = (route?: string) => {
    if (route === '/updates' || route === '/settings?section=updates') { window.dispatchEvent(new Event('flux:open-updates')); setPanelOpen(false); return; }
    if (route && route !== '#') { navigate(route); setPanelOpen(false); }
  };

  const snoozedUntil = useMemo(() => Object.fromEntries(
    Object.entries(snoozed).map(([id, entry]) => [id, entry.until]),
  ), [snoozed]);
  const shown = useMemo(() => visibleNow(personal, snoozedUntil), [personal, snoozedUntil]);
  // Одна лента вместо вкладок: правила слияния — в lib/notifCenter, потому что
  // «что и в каком порядке видно» имеет правильный ответ
  const feedAll = useMemo(
    () => withoutCleared([...mergeFeed(shown, logs, 'all'), ...windowsFeed], cleared)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [shown, logs, windowsFeed, cleared],
  );
  const feed = useMemo(
    () => filter === 'all' ? feedAll : feedAll.filter((i) => (filter === 'personal' ? i.kind === 'personal' : filter === 'system' ? i.kind === 'system' : i.kind === 'windows')),
    [feedAll, filter],
  );
  const groups = useMemo(() => groupByApp(feed, titleOf), [feed]);
  const hidden = personal.length - shown.length;
  const quietNow = isQuiet(quiet);
  const unread = unreadIn(feedAll);

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

  const clearAll = () => {
    clearFeed('*', clearMoment(feedAll));
    if (user?.id) void markAllRead(user.id);
  };

  const emptyText = filter === 'personal' ? 'Личных уведомлений нет'
    : filter === 'windows' ? 'Уведомлений Windows нет'
      : 'Новых уведомлений нет';

  return (
    <section
      aria-label="Уведомления"
      data-dock-notifications
      className="fx-glass rounded-xl overflow-hidden flex flex-col min-h-0"
    >
      {/* Шапка: название, тихий режим, «прочитать всё», «удалить все». Градиент
          и значок в цветной плитке по методологии ушли */}
      <div className="flex items-center gap-1 h-11 px-4 shrink-0">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mr-auto">Уведомления</h2>
        <button type="button" aria-label="Не беспокоить"
          title={quietNow ? `Тихий режим ${untilLabel(quiet!)} — всплывашек не будет, счётчики считают` : 'Не беспокоить'}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setQuietMenu({ x: r.left, y: r.bottom + 4 });
          }}
          className={`w-7 h-7 rounded-md flex items-center justify-center cursor-pointer hover:bg-slate-500/20
                      ${quietNow ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-300'}`}>
          {quietNow ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
        </button>
        {unread > 0 && (
          <button type="button" onClick={() => user?.id && void markAllRead(user.id)}
            title="Отметить всё прочитанным" aria-label="Отметить всё прочитанным"
            className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-500/20">
            <CheckCheck className="w-4 h-4" />
          </button>
        )}
        <button type="button" onClick={clearAll} disabled={feedAll.length === 0}
          className="h-7 px-2 rounded-md text-xs font-medium cursor-pointer text-slate-700 dark:text-slate-100
                     hover:bg-slate-500/20 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent">
          Удалить все
        </button>
        <button type="button" onClick={() => setPanelOpen(false)} title="Закрыть" aria-label="Закрыть"
          className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-500/20">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Фильтр из четырёх слов: событие приходит во времени, а не по вкладкам —
          лента одна, а «только своё» это выбор, а не два разных места, где
          надо искать пропущенное */}
      <div className="fx-seg px-3 pb-2 shrink-0">
        {FILTERS.map((ftr) => (
          <button key={ftr.id} type="button" onClick={() => setFilter(ftr.id)} aria-pressed={filter === ftr.id}>
            {ftr.label}
          </button>
        ))}
      </div>

      <div ref={feedRef} className="min-h-24 overflow-y-auto scrollbar-thin px-2 pb-2">
        {filter === 'windows' && windows.status !== 'ready' && <div className="px-2 py-2 text-xs text-slate-600 dark:text-slate-300">
          <p className="break-words">{windowsMessage || windows.message || 'Для уведомлений Windows установите компонент Flux Notification Bridge и разрешите ему доступ. Уведомления Flux работают независимо.'}</p>
          {(window as any).electron?.windowsNotifications && <button type="button" disabled={connectingWindows} className="fx-btn mt-2" onClick={async () => {
            setConnectingWindows(true); setWindowsMessage('');
            try { const result = await (window as any).electron.windowsNotifications.requestConsent(); setWindowsMessage(result.message || 'Разрешите доступ в открывшемся окне Windows.'); }
            catch { setWindowsMessage('Компонент уведомлений Windows не удалось открыть.'); }
            finally { setConnectingWindows(false); }
          }}>{connectingWindows ? 'Открываю…' : 'Подключить уведомления Windows'}</button>}
        </div>}
        {groups.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-slate-600 dark:text-slate-300">{emptyText}</div>
        )}
        {groups.map((g) => (
          <div key={g.key} data-notif-group={g.key} className="mb-2 last:mb-0">
            <div className="group flex items-center gap-2 h-8 px-2 sticky top-0 z-10">
              {g.route ? <AppIcon path={g.route} size={16} /> : <Bell className="w-4 h-4 text-slate-500" />}
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-100 truncate">{g.title}</span>
              {g.unread > 0 && <span className="fx-badge fx-badge-accent">{g.unread}</span>}
              <button type="button" onClick={() => clearFeed(g.key, clearMoment(g.items))}
                title={`Очистить: ${g.title}`} aria-label={`Очистить: ${g.title}`}
                className="ml-auto w-6 h-6 rounded-md flex items-center justify-center cursor-pointer text-slate-500
                           opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-slate-500/20">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {g.items.map((n) => (
                <NotificationItem key={n.id} n={n}
                  snoozing={snoozing === n.id}
                  onSnoozeMenu={(open) => setSnoozing(open ? n.id : null)}
                  onSnooze={(choice) => { snooze(n.id.slice(2), choice); setSnoozing(null); }}
                  onGo={go} />
              ))}
            </div>
          </div>
        ))}
        {hidden > 0 && (
          <div className="px-2 py-2 text-2xs text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
            <Clock className="w-3 h-3 shrink-0" />
            Отложено: {hidden}. Вернутся сами — ничего не потеряется.
          </div>
        )}
      </div>

      {quietMenu && (
        <ContextMenu x={quietMenu.x} y={quietMenu.y} onClose={() => setQuietMenu(null)}
          items={quietNow
            ? [{ label: `Включить уведомления (тихо ${untilLabel(quiet!)})`, onClick: () => setQuiet(null) }]
            : QUIET_CHOICES.map((c) => ({ label: `Не беспокоить: ${c.label}`, onClick: () => setQuiet(c.id) }))} />
      )}
    </section>
  );
}
