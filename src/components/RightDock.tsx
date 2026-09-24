/**
 * Правая колонка: уведомления и помощник рядом, а не вместо друг друга.
 *
 * Здесь исправлены две вещи, на которые владелец жаловался прямо.
 *
 * Панели накрывали панель задач. Они тянулись от верха окна до самого низа, и
 * под ними оказывались часы, календарь и значки трея — то есть ровно то, ради
 * чего панель задач нужна. Теперь колонка кончается над ней: панель задач —
 * опора оболочки, и никто не встаёт поверх опоры.
 *
 * И панели не умели быть открытыми одновременно: открытие одной закрывало
 * другую. Человек, читавший уведомление и решивший спросить помощника, терял
 * уведомление из виду. Теперь они делят колонку по высоте — кто открыт раньше,
 * тот выше, — а между ними разделитель, который можно подвинуть. На узком
 * экране делить нечего: там они становятся двумя вкладками одной панели.
 *
 * Раскладку считает src/lib/rightPanels.ts, и её проверяет скрипт: ошибка здесь
 * не падает, а тихо отрезает кусок экрана.
 */
import React from 'react';
import { useOverlay } from '../store/overlayStore';
import { Z } from '../lib/layers';
import { useAssistantStore } from '../store/assistantStore';
import { useNotificationStore } from '../store/notificationStore';
import {
  dockPlan, clampSplit, openPanel, closePanel, panelTitle, PANEL_W, type PanelId,
} from '../lib/rightPanels';
import NotificationsPanel from './NotificationsPanel';
import AssistantPanel from './AssistantPanel';

const SPLIT_KEY = 'flux_dock_split';

export default function RightDock() {
  const notifOpen = useNotificationStore((s) => s.panelOpen);
  const assistantOpen = useAssistantStore((s) => s.isOpen);

  // Порядок открытия живёт рядом с раскладкой: он и есть свойство колонки, а
  // не свойство уведомлений или помощника по отдельности
  const [opened, setOpened] = React.useState<PanelId[]>([]);
  React.useEffect(() => {
    setOpened((prev) => {
      let next = notifOpen ? openPanel(prev, 'notifications') : closePanel(prev, 'notifications');
      next = assistantOpen ? openPanel(next, 'assistant') : closePanel(next, 'assistant');
      return next.length === prev.length && next.every((p, i) => p === prev[i]) ? prev : next;
    });
  }, [notifOpen, assistantOpen]);

  const [width, setWidth] = React.useState(() => (typeof window === 'undefined' ? 1600 : window.innerWidth));
  React.useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Куда человек поставил разделитель — его привычка, а не свойство проекта
  const [split, setSplit] = React.useState(() => {
    try { return Number(localStorage.getItem(SPLIT_KEY)) || 0.5; } catch (_) { return 0.5; }
  });
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [tab, setTab] = React.useState<PanelId | null>(null);

  const plan = dockPlan(opened, width, split);
  // Пока колонка открыта, страница браузера уступает место: родной слой
  // Chromium выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(plan.order.length > 0);
  const shown = plan.tabs ? [tab && plan.order.includes(tab) ? tab : plan.active].filter(Boolean) as PanelId[] : plan.order;

  /** Тянем разделитель: считаем долю от высоты колонки, а не от окна */
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) => {
      const next = clampSplit((ev.clientY - box.top) / box.height, box.height);
      setSplit(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      setSplit((s) => { try { localStorage.setItem(SPLIT_KEY, String(s)); } catch (_) { /* приватный режим */ } return s; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  if (!plan.order.length) return null;

  const body = (id: PanelId) => (id === 'notifications' ? <NotificationsPanel /> : <AssistantPanel />);

  return (
    <aside
      ref={boxRef}
      style={{ zIndex: Z.tray, width: PANEL_W, right: 'var(--flux-rail-w, 0px)', bottom: 'var(--flux-taskbar-h, 0px)' }}
      data-right-dock
      className="absolute top-0 flex flex-col bg-white dark:bg-slate-900 border-l
                 border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden"
    >
      {/* Вкладки — только на узком экране: на широком обе панели видны сразу,
          и вкладка была бы лишним нажатием ни за чем */}
      {plan.tabs && (
        <div className="fx-tabs shrink-0 h-10 px-2 border-b border-slate-200 dark:border-slate-800" role="tablist">
          {plan.order.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shown[0] === id}
              data-dock-tab
              onClick={() => setTab(id)}
              className="fx-tab flex-1 justify-center"
            >
              {panelTitle(id)}
            </button>
          ))}
        </div>
      )}

      {shown.map((id, i) => (
        <React.Fragment key={id}>
          {i > 0 && (
            <div
              data-dock-divider
              onPointerDown={startDrag}
              title="Потяните, чтобы поделить колонку"
              className="shrink-0 h-1.5 cursor-row-resize bg-slate-200 dark:bg-slate-800
                         hover:bg-emerald-500/60 transition-colors"
            />
          )}
          <div
            data-dock-part
            className="min-h-0 overflow-hidden"
            style={shown.length > 1
              ? { flex: `${i === 0 ? plan.split : 1 - plan.split} 1 0` }
              : { flex: '1 1 0' }}
          >
            {body(id)}
          </div>
        </React.Fragment>
      ))}
    </aside>
  );
}
