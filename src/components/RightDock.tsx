/**
 * Правые панели: центр уведомлений с календарём и помощник.
 *
 * Как в Windows 11, это скруглённые карточки у правого края, въезжающие справа
 * и стоящие над панелью задач. Колонка прозрачна для мыши: между карточками и
 * вокруг них видны и доступны окна программ.
 *
 * Две вещи, на которые владелец жаловался прямо:
 *  - панели накрывали панель задач — теперь колонка кончается над ней: панель
 *    задач опора оболочки, и никто не встаёт поверх опоры;
 *  - панели не умели быть открытыми вместе — теперь они стоят рядом колонками
 *    и не перекрывают друг друга (на узком экране остаётся последняя открытая).
 *
 * Центр уведомлений закрывается по Esc и щелчку мимо, как всплывающие панели
 * системы; помощник остаётся, пока его не закроют, — в него пишут, поглядывая
 * в рабочее окно.
 *
 * Раскладку считает src/lib/rightPanels.ts, и её проверяет скрипт: ошибка там
 * не падает, а тихо отрезает кусок экрана.
 */
import React from 'react';
import { useOverlay } from '../store/overlayStore';
import { Z } from '../lib/layers';
import { useNotificationStore } from '../store/notificationStore';
import { useAssistantDockStore } from '../store/assistantDockStore';
import { BAR_H } from '../lib/metrics';
import {
  dockPlan, openPanel, closePanel, panelWidth, DOCK_GAP, type PanelId,
} from '../lib/rightPanels';
import NotificationsPanel from './NotificationsPanel';
import GuideDockPanel from './GuideDockPanel';
import CalendarCard from './calendar/ClockPanel';
import type { DisplayRect } from '../../workspace/displays';

/** Сколько карточка догорает на уходе: короче прихода */
const LEAVE_MS = 140;

/** Панель остаётся в дереве на время ухода, чтобы успел доиграть выезд */
function usePresence(on: boolean): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = React.useState(on);
  React.useEffect(() => {
    if (on) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), LEAVE_MS);
    return () => clearTimeout(t);
  }, [on]);
  return { mounted: on || mounted, leaving: !on && mounted };
}

export default function RightDock({ bounds }: { bounds?: DisplayRect } = {}) {
  const notifOpen = useNotificationStore((s) => s.panelOpen);
  const setNotifOpen = useNotificationStore((s) => s.setPanelOpen);
  const assistOpen = useAssistantDockStore((s) => s.open);
  const setAssistOpen = useAssistantDockStore((s) => s.setOpen);

  // Порядок открытия живёт рядом с раскладкой: он и есть свойство колонки
  const [opened, setOpened] = React.useState<PanelId[]>([]);
  React.useEffect(() => {
    setOpened((prev) => {
      let next = notifOpen ? openPanel(prev, 'notifications') : closePanel(prev, 'notifications');
      next = assistOpen ? openPanel(next, 'assistant') : closePanel(next, 'assistant');
      return next.length === prev.length && next.every((p, i) => p === prev[i]) ? prev : next;
    });
  }, [notifOpen, assistOpen]);

  const [width, setWidth] = React.useState(() => (typeof window === 'undefined' ? 1600 : window.innerWidth));
  React.useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const plan = dockPlan(opened, bounds?.w ?? width);
  // На узком экране вторую панель не прячем «под» первой, а закрываем: иначе
  // кнопка трея горела бы у панели, которой не видно
  React.useEffect(() => {
    for (const id of plan.hidden) (id === 'notifications' ? setNotifOpen : setAssistOpen)(false);
  }, [plan.hidden.join()]);

  const notif = usePresence(plan.columns.includes('notifications'));
  const assist = usePresence(plan.columns.includes('assistant'));
  const any = notif.mounted || assist.mounted;

  // Пока колонка открыта, страница браузера уступает место: родной слой
  // Chromium выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(plan.columns.length > 0);

  const boxRef = React.useRef<HTMLDivElement>(null);
  // Центр уведомлений закрывается как всплывающая панель: Esc и щелчок мимо.
  // Кнопки трея, открывающие его, из «мимо» исключены (data-tray-toggle),
  // иначе щелчок по колокольчику закрывал бы панель и тут же открывал снова
  React.useEffect(() => {
    if (!notifOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc в поле ввода помощника — не про уведомления
      if ((document.activeElement as HTMLElement | null)?.closest('[data-dock-assistant]')) return;
      setNotifOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('[data-right-dock], [data-tray-toggle], [data-context-menu], .fx-pop, .fx-dialog')) return;
      setNotifOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown, true); };
  }, [notifOpen, setNotifOpen]);

  if (!any) return null;

  // Без отдельных мониторов колонка занимает весь стол над панелью задач;
  // с ними — рабочую область активного монитора
  const place: React.CSSProperties = bounds
    ? { left: bounds.x, top: bounds.y, width: bounds.w, height: Math.max(1, bounds.h - BAR_H) }
    : { left: 0, top: 0, right: 'var(--flux-rail-w, 0px)', bottom: 'var(--flux-taskbar-h, 0px)' };

  const column = (id: PanelId, mounted: boolean, leaving: boolean, children: React.ReactNode) => mounted && (
    <div
      key={id}
      data-dock-column={id}
      style={{ width: Math.min(panelWidth(id), (bounds?.w ?? width) - DOCK_GAP * 2) }}
      className={`${leaving ? 'fx-dock-out' : 'fx-dock-in'} shrink-0 h-full max-h-full flex flex-col justify-end gap-2 pointer-events-none
                  [&>*]:pointer-events-auto`}
    >
      {children}
    </div>
  );

  return (
    <div
      ref={boxRef}
      data-right-dock
      style={{ ...place, zIndex: Z.tray, padding: DOCK_GAP, gap: DOCK_GAP }}
      className="absolute flex flex-row justify-end items-end pointer-events-none"
    >
      {column('assistant', assist.mounted, assist.leaving, <div className="h-full max-h-[760px] min-h-0 flex flex-col justify-end"><GuideDockPanel /></div>)}
      {column('notifications', notif.mounted, notif.leaving, <><NotificationsPanel /><CalendarCard /></>)}
    </div>
  );
}
