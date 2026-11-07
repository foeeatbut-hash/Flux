/**
 * Нижняя панель задач: Пуск, закреплённые программы, открытые разделы и трей.
 *
 * Единственное «куда пойти» в программе: разделы одного уровня стоят в один
 * ряд, а не столбиком, и по одному нажатию открываются в активной панели.
 *
 * Здесь только разметка и подписки на хранилища. Что на панели стоит, в каком
 * порядке и когда прячутся подписи — считает src/lib/taskbar.ts: это ломается
 * незаметно и потому проверяется скриптом.
 *
 * Ни одна кнопка не нарисована «на будущее»: всё, что видно, работает. Звук,
 * «кто в проекте» и связь появятся вместе со своими механизмами, а не раньше.
 */
import React from 'react';
import {
  Bell, BellOff, Monitor, LayoutGrid, MessageCircleQuestion, ArrowUpCircle,
} from 'lucide-react';
import { SECTIONS } from '../workspace/sections';
import { visibleSections } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import { openSectionWindow, rememberSectionUse } from '../store/workspaceStore';
import { useStore } from '../store/store';
import { hasAdminRole } from '../lib/permissions';
import { useNotificationStore } from '../store/notificationStore';
import { useFeedbackStore } from '../store/feedbackStore';
import { useShellNotifyStore } from '../store/shellNotifyStore';
import { isQuiet, untilLabel } from '../lib/notifCenter';
import { useMailStore } from '../store/mailStore';
import { useWindowStore, openPaths, activeWindowPath, windowsOf } from '../store/windowStore';
import TaskbarRunMark from './TaskbarRunMark';
import DraftsButton from './drafts/DraftsButton';
import { useDesktopStore } from '../store/desktopStore';
import { buildTaskbar, clockLabel, deadlineLabel, badgeLabel, trayFit, runState, PEEK_DELAY, PEEK_GRACE } from '../lib/taskbar';
import { snapshotWindows, useThumbKeeper } from './useWindowThumbs';
import { BAR_H, BAR_BTN, BAR_ICON, TRAY_ICON, BAR_EDGE, CHIP_H } from '../lib/metrics';
import { Z } from '../lib/layers';
import ContextMenu, { MenuItem } from './ContextMenu';
import StartMenu from './StartMenu';
import TaskbarPeek from './TaskbarPeek';
import { AppIcon } from './icons/FluxIcons';
import ProjectSwitcher from './ProjectSwitcher';
import DbStatusTray from './shell/DbStatusTray';
import { useAssistantDockStore } from '../store/assistantDockStore';
import { useUpdateStore, updateReady } from '../store/updateStore';
import UpdateDialog, { claimUpdateDialogOpen, useUpdateReminders } from './UpdateDialog';
import { displayForRect } from '../../workspace/displays';
import { useDisplayStore } from '../store/displayStore';
import type { NativeAppWindow } from '../../workspace/nativeApps';

/** Минута — самый крупный шаг, который видно на часах без секунд */
function useNow(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function Taskbar({ displayId }: { displayId?: number } = {}) {
  const user = useStore((s) => s.user);
  const activeProject = useStore((s) => s.activeProject);
  const allWindows = useWindowStore(s => s.windows);
  const displays = useWindowStore(s => s.displays);
  const windows = React.useMemo(() => displayId === undefined ? allWindows : allWindows.filter(w => displayForRect(displays, w)?.id === displayId), [allWindows, displays, displayId]);
  const desk = useWindowStore((s) => s.desk);
  const toggleWindow = useWindowStore((s) => s.toggle);
  const minimizeAll = useWindowStore((s) => s.minimizeAll);
  const tileAll = useWindowStore((s) => s.tileAll);
  const notifUnread = useNotificationStore((s) => s.unread);
  // Тихий режим виден на самой кнопке: иначе про него забывают и решают, что
  // уведомления сломались
  const quiet = useShellNotifyStore((s) => s.quiet);
  const chatUnread = useNotificationStore((s) => s.chatUnread);
  const feedbackUnread = useFeedbackStore((s) => s.unread.total);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const notifOpen = useNotificationStore((s) => s.panelOpen);
  const unreadByAccount = useMailStore((s) => s.unreadByAccount);
  const now = useNow();
  const [menu, setMenu] = React.useState<{ x: number; y: number; path: string } | null>(null);
  const [startOpen, setStartOpen] = React.useState(false);
  // Наведение раскрывает карточки окон программы. 400 мс — столько же, сколько
  // ждёт всплывающая подсказка: быстрое движение мимо кнопки ничего не открывает.
  // Когда карточки уже на экране, соседняя кнопка переключает их сразу — иначе
  // при переходе вдоль панели они мигали бы, а уход гасит их без задержки
  // (кроме короткой паузы, чтобы мышь успела дойти от кнопки до карточки)
  const [peek, setPeek] = React.useState<{ path: string; center: number } | null>(null);
  const peekRef = React.useRef(peek);
  peekRef.current = peek;
  const peekTimer = React.useRef<any>(null);
  const leaveTimer = React.useRef<any>(null);
  const centerOf = (el: HTMLElement) => {
    const bar = barRef.current?.getBoundingClientRect();
    const btn = el.getBoundingClientRect();
    return btn.left - (bar?.left || 0) + btn.width / 2;
  };
  /** Есть ли у программы окна на этом столе и мониторе — иначе показывать нечего */
  const hasWindows = (path: string) => windowsOf(windows, path, desk).length > 0;
  const showPeek = (path: string, el: HTMLElement) => {
    // Снимки берутся ДО появления карточек: они стоят над столом и попали бы в кадр
    const ids = windowsOf(windows, path, desk).map((w) => w.id);
    snapshotWindows(ids, { panelShown: peekRef.current !== null });
    setPeek({ path, center: centerOf(el) });
  };
  const armPeek = (path: string, el: HTMLElement) => {
    clearTimeout(peekTimer.current);
    clearTimeout(leaveTimer.current);
    if (!hasWindows(path)) {
      // Кнопка без окон: карточки соседней программы уходят вместе с мышью
      if (peekRef.current) setPeek(null);
      return;
    }
    if (peekRef.current) { showPeek(path, el); return; }
    // Снимок начинается сейчас, а не через 400 мс: к показу он уже готов
    snapshotWindows(windowsOf(windows, path, desk).map((w) => w.id));
    peekTimer.current = setTimeout(() => showPeek(path, el), PEEK_DELAY);
  };
  const disarmPeek = () => {
    clearTimeout(peekTimer.current);
    clearTimeout(leaveTimer.current);
    if (peekRef.current) leaveTimer.current = setTimeout(() => setPeek(null), PEEK_GRACE);
  };
  const keepPeek = () => clearTimeout(leaveTimer.current);
  React.useEffect(() => () => { clearTimeout(peekTimer.current); clearTimeout(leaveTimer.current); }, []);
  React.useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPeek(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!peek]);
  useThumbKeeper();
  const rowRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<HTMLButtonElement>(null);
  // Список свёрнутых кнопок: открывается тем же меню, что и правая кнопка
  const [moreMenu, setMoreMenu] = React.useState<{ x: number; y: number } | null>(null);
  // Помощник — такая же правая панель, как уведомления
  const assistOpen = useAssistantDockStore((s) => s.open);
  const toggleAssist = useAssistantDockStore((s) => s.toggle);
  const [showUpdateDialog, setShowUpdateDialog] = React.useState(false);
  useUpdateReminders();
  React.useEffect(() => {
    const open = (event: Event) => { if (claimUpdateDialogOpen(event)) setShowUpdateDialog(true); };
    window.addEventListener('flux:open-updates', open);
    return () => window.removeEventListener('flux:open-updates', open);
  }, []);
  const [width, setWidth] = React.useState(0);
  const [barWidth, setBarWidth] = React.useState(0);
  const displayWorkspace = useDisplayStore(s => s.workspace);
  const [nativeWindows, setNativeWindows] = React.useState<NativeAppWindow[]>([]);
  React.useEffect(() => {
    const api = (window as any).electron?.nativeApps;
    if (!api?.list || !api?.onChanged) return;
    let alive = true;
    const update = (value?: NativeAppWindow[]) => {
      if (value) { if (alive) setNativeWindows(value); return; }
      void api.list().then((rows: NativeAppWindow[]) => { if (alive && Array.isArray(rows)) setNativeWindows(rows); }).catch(() => {});
    };
    update();
    const off = api.onChanged((rows: NativeAppWindow[]) => update(rows));
    return () => { alive = false; off(); };
  }, []);

  // Ширина всей панели решает, что из необязательного показывать в трее
  React.useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarWidth(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = trayFit(barWidth);

  // Ширину полосы кнопок меряем сами: влезут ли подписи, знает только экран.
  // Полоса тянется по остатку и от своего содержимого не зависит — поэтому
  // измерение устойчиво и подписи не мигают
  React.useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Раздел, открытый с панели или из меню, попадает в «недавние». Здесь, а не в
  // хранилище рабочего стола: список нужен только Пуску и переживает закрытие
  const openSection = React.useCallback((path: string) => {
    rememberSectionUse(path);
    if (displayId !== undefined) useWindowStore.getState().setActiveDisplay(displayId);
    toggleWindow(path);
  }, [toggleWindow, displayId]);

  /**
   * Что считать «открытым»: открытые окна, включая свёрнутые. У свёрнутого
   * есть кнопка, за ней его и возвращают.
   */
  const open = React.useMemo(
    // Только окна текущего стола: панель задач показывает то, что видно на
    // столе, — иначе кнопка вела бы к окну, которого сейчас нет
    () => openPaths(windows, desk),
    [windows, desk],
  );

  const highlighted = activeWindowPath(windows, desk);
  // Раздел «свёрнут», когда свёрнуты все его окна на этом столе: метка под
  // кнопкой тогда бледнее, и видно, что за ней можно вернуться
  const minimizedPaths = React.useMemo(
    () => open.filter((p) => {
      const mine = windowsOf(windows, p, desk);
      return mine.length > 0 && mine.every((w) => w.minimized);
    }),
    [windows, desk, open],
  );

  const mail = React.useMemo(
    () => Object.values(unreadByAccount).reduce((a, b) => a + (b || 0), 0),
    [unreadByAccount],
  );

  /**
   * Что закреплено — личный список сотрудника, а не свойство раздела. Реестр
   * (`pinned` в sections.tsx) остаётся составом по умолчанию для новичка;
   * дальше человек закрепляет и открепляет сам, и панель наконец перестаёт
   * быть одинаковой у всех.
   */
  const barPins = useDesktopStore((s) => s.bar);
  const pinBar = useDesktopStore((s) => s.pinBar);
  const unpinBar = useDesktopStore((s) => s.unpinBar);
  /**
   * Закрытый раздел не должен стоять на панели задач.
   *
   * Отбор здесь был только по роли администратора, и раздел, выданный правом,
   * оставался кнопкой у того, у кого право сняли: закрепление живёт в браузере
   * и про права ничего не знает. Теперь состав панели проходит через ту же
   * политику, что Пуск и рабочий стол, — и снятое право убирает кнопку сразу.
   */
  const ctx = useAppContext();
  const sources = React.useMemo(
    () => visibleSections(SECTIONS, ctx, open).map((s) => ({ ...s, pinned: !s.fileOnly && barPins.includes(s.path) })),
    [barPins, ctx, open],
  );

  const view = React.useMemo(
    () => buildTaskbar(sources, {
      open,
      activePath: highlighted,
      counts: { mail, chat: chatUnread, feedback: feedbackUnread },
      isAdmin: hasAdminRole(user as any),
      width,
      minimized: minimizedPaths,
    }),
    [sources, open, highlighted, mail, chatUnread, feedbackUnread, user?.role, width, minimizedPaths],
  );


  const countOfWindows = React.useCallback(
    (path: string) => windowsOf(windows, path, desk).length,
    [windows, desk],
  );
  /** Нажали по кнопке со стопкой: карточки открываются сразу, без задержки */
  const armPeekNow = (path: string, el: HTMLElement) => {
    clearTimeout(peekTimer.current);
    clearTimeout(leaveTimer.current);
    showPeek(path, el);
  };

  const menuItems: MenuItem[] = menu ? [
    { label: 'Открыть', onClick: () => openSection(menu.path) },
    ...(SECTIONS.find((s) => s.path === menu.path)?.multi && !SECTIONS.find((s) => s.path === menu.path)?.fileOnly
      ? [{ label: 'Новое окно', onClick: () => useWindowStore.getState().openAnother(menu.path) }] : []),
    ...(SECTIONS.find((s) => s.path === menu.path)?.fileOnly ? [] : [
      { label: 'Открыть в отдельном окне', onClick: () => openSectionWindow(menu.path) },
      barPins.includes(menu.path)
      ? { label: 'Открепить от панели', separated: true, onClick: () => unpinBar(menu.path) }
      : { label: 'Закрепить на панели', separated: true, onClick: () => pinBar(menu.path) },
    ]),
    ...(countOfWindows(menu.path) > 0 ? [{
      label: countOfWindows(menu.path) > 1 ? `Закрыть все окна (${countOfWindows(menu.path)})` : 'Закрыть окно',
      onClick: () => {
        const st = useWindowStore.getState();
        for (const w of windowsOf(st.windows, menu.path, st.desk)) void st.requestClose(w.id);
      },
    }] : []),
  ] : [];

  /**
   * Обновление в трее. Раздел настроек открывается сразу на нужном месте:
   * «нажал на значок — попал в обновления», а не «нажал и ищи, где это».
   */
  const hasUpdate = useUpdateStore(updateReady);
  const updateVersion = useUpdateStore((s) => s.latest?.version || '');
  const updateSeen = useUpdateStore((s) => s.seen);
  const trayBtn = (active: boolean) =>
    `relative rounded-lg cursor-pointer flex items-center justify-center transition-colors ${
      active
        ? 'bg-slate-200/70 dark:bg-slate-800 text-slate-900 dark:text-white'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'
    }`;

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Панель задач"
      data-taskbar
      onPointerDownCapture={() => { if (displayId !== undefined) useWindowStore.getState().setActiveDisplay(displayId); }}
      /* Высота, рост кнопки и размер значка — общая мера оболочки
         (src/lib/metrics.ts): панель обязана быть того же роста, что и ряд
         значков в системе, иначе программа рядом с ней выглядит увеличенной */
      /* Справа без отступа: последняя в ряду полоска «показать стол» обязана
         доходить до самого края окна, иначе угол экрана перестаёт быть целью */
      style={{ height: BAR_H, zIndex: Z.taskbar }}
      className="relative shrink-0 flex items-center gap-1 pl-2
                 bg-slate-50 dark:bg-dark-surface border-t border-slate-200 dark:border-dark-border"
    >
      {startOpen && <StartMenu displayId={displayId} onClose={() => setStartOpen(false)} />}
      {showUpdateDialog && <UpdateDialog onClose={() => setShowUpdateDialog(false)} />}

      {/* Пуск — единственный цветной значок на панели, чтобы его находили не
          глядя. Заливки у кнопки больше нет: зелёная плитка была самым ярким
          пятном экрана и спорила с главной кнопкой открытой программы, а
          акцент по методологии принадлежит действию (01-design.md, раздел 3).
          Слова на ней нет: имя остаётся там, где его читают не глазами, — в
          подсказке и в aria-label */}
      <button
        type="button"
        ref={startRef}
        onClick={() => setStartOpen((v) => !v)}
        aria-expanded={startOpen}
        aria-label="Пуск"
        title="Пуск — все программы и поиск"
        style={{ width: BAR_BTN + 8, height: BAR_BTN }}
        className={`flex items-center justify-center rounded-lg shrink-0 cursor-pointer transition-colors
                   text-emerald-700 dark:text-emerald-400 ${startOpen ? 'bg-slate-200/70 dark:bg-slate-800' : 'hover:bg-slate-200/60 dark:hover:bg-slate-800'}`}
      >
        <LayoutGrid size={BAR_ICON} className="shrink-0" />
      </button>

      <DraftsButton displayId={displayId} />
      <div className="w-1 shrink-0" />

      {/* Полоса кнопок не прокручивается. Прокрутка здесь давала скроллбар во
          всю высоту панели у самого её края — и это при том, что кнопки всё
          равно уезжали за край. Что не поместилось, сворачивается в кнопку
          «ещё» справа: список свёрнутого открывается по нажатию, и ни одна
          программа не пропадает без следа */}
      <div
        ref={rowRef}
        /* Программу можно принести сюда из Пуска — это и есть «закрепить на
           панели». Без этого закрепление оставалось настройкой в параметрах,
           то есть местом, куда за ним не ходят */
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('text/plain')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          e.preventDefault();
          try {
            const data = JSON.parse(e.dataTransfer.getData('text/plain') || 'null');
            if (data?.type === 'app_pin' && typeof data.path === 'string') pinBar(data.path);
          } catch (_) { /* принесли не программу */ }
        }}
        className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden"
      >
        {view.visible.map((b) => {
          return (
            <button
              key={b.path}
              type="button"
              onClick={(e) => {
                // Окон несколько — выбирают из карточек, а не наугад поднимают
                if (countOfWindows(b.path) > 1) {
                  if (peek?.path === b.path) setPeek(null);
                  else armPeekNow(b.path, e.currentTarget as HTMLElement);
                  return;
                }
                setPeek(null);
                openSection(b.path);
              }}
              onMouseEnter={(e) => armPeek(b.path, e.currentTarget as HTMLElement)}
              onMouseLeave={disarmPeek}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => {
                // Средним — новое окно той же программы, как в системе. Разделу,
                // у которого окно одно, нового не дать: его просто открывают
                if (e.button !== 1) return;
                e.preventDefault();
                setPeek(null);
                if (SECTIONS.find((x) => x.path === b.path)?.multi) useWindowStore.getState().openAnother(b.path);
                else openSection(b.path);
              }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path: b.path }); }}
              title={b.title}
              aria-label={b.title}
              /* Метка раздела: демонстрации помощника подсвечивают его по
                 ней, и она же стоит на плитке Пуска */
              data-tour={`nav-${b.path}`}
              /* Цель полёта окна при сворачивании и возврате (lib/windowMotion) */
              data-taskbar-btn={b.path}
              aria-current={b.active ? 'true' : undefined}
              style={{ width: BAR_BTN, height: BAR_BTN }}
              /* Запущенная — метка снизу, активная — ещё и светлая подложка, как в
                 системной панели. Рамка вокруг каждой запущенной кнопки
                 превращала ряд значков в ряд карточек */
              className={`relative rounded-lg shrink-0 cursor-pointer flex items-center justify-center
                          text-xs whitespace-nowrap transition-[color,background-color,transform] duration-[80ms]
                          active:scale-[0.94] motion-reduce:active:scale-100 ${
                b.active
                  ? 'bg-slate-200 dark:bg-slate-600 text-slate-900 dark:text-white font-medium ring-1 ring-inset ring-slate-300 dark:ring-slate-500'
                  : b.running
                    ? 'bg-slate-100 dark:bg-slate-900/60 text-slate-700 dark:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800'
              }`}
            >
              <AppIcon path={b.path} size={BAR_ICON} />
              {countOfWindows(b.path) > 1 && (
                <span
                  style={{ height: CHIP_H, minWidth: CHIP_H }}
                  className="absolute bottom-0.5 right-0.5 px-1 rounded bg-slate-200/90 dark:bg-slate-700
                             text-2xs text-slate-500 dark:text-slate-300 tabular-nums
                             flex items-center justify-center" title="Окон этой программы">
                  {countOfWindows(b.path)}
                </span>
              )}
              {b.badge > 0 && (
                <span
                  style={{ height: CHIP_H, minWidth: CHIP_H }}
                  className="absolute -top-0.5 -right-0.5 px-1.5 rounded-full bg-rose-600 text-white text-xs font-medium tabular-nums flex items-center justify-center">
                  {badgeLabel(b.badge)}
                </span>
              )}
              {/* Подчёркивание — «запущена». Видно боковым зрением и не спорит
                  с заливкой активной кнопки */}
              {b.running && <TaskbarRunMark state={runState(b)!} />}
            </button>
          );
        })}
        {nativeWindows.map((nativeWindow) => <button key={`native:${nativeWindow.id}`} type="button"
          onClick={() => void (window as any).electron?.nativeApps?.action(nativeWindow.id, nativeWindow.focused ? 'minimize' : 'focus')}
          onContextMenu={(event) => { event.preventDefault(); void (window as any).electron?.nativeApps?.action(nativeWindow.id, 'focus'); }}
          title={nativeWindow.title || 'Окно Flux'} aria-label={nativeWindow.title || 'Окно Flux'} aria-pressed={nativeWindow.focused}
          style={{ height: BAR_BTN }}
          className={`relative max-w-48 px-2.5 rounded-lg shrink-0 flex items-center text-xs transition-colors ${nativeWindow.focused ? 'bg-slate-200/70 dark:bg-slate-800 text-slate-900 dark:text-white font-medium' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'}`}>
          <span className="block max-w-44 truncate">{nativeWindow.title || 'Окно Flux'}</span>
        </button>)}
      </div>

      {view.hidden.length > 0 && (
        <button
          type="button"
          onClick={(e) => setMoreMenu({ x: e.clientX, y: e.clientY })}
          title={`Ещё ${view.hidden.length}: не поместились на панель`}
          aria-label={`Ещё ${view.hidden.length} программ`}
          style={{ height: BAR_BTN }}
          className="shrink-0 px-2 rounded-lg cursor-pointer text-xs font-medium tabular-nums
                     text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
        >
          »{view.hidden.length}
        </button>
      )}

      {view.tidy && fit.hint && (
        <span className="shrink-0 flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400 px-2 whitespace-nowrap">
          открыто много —
          {/* Настоящая кнопка, а не подчёркнутая строчка: в текст высотой в
              четырнадцать точек надо целиться, и мимо попадают чаще, чем в него */}
          <button
            type="button"
            onClick={tileAll}
            style={{ height: BAR_BTN - 6 }}
            className="px-2 rounded-md cursor-pointer font-medium text-slate-700 dark:text-slate-100
                       border border-slate-300 dark:border-slate-600
                       hover:bg-white dark:hover:bg-slate-800 transition-colors"
          >
            разложить
          </button>
        </span>
      )}

      {/* Трей, слева направо: проект, связь с базой, мониторы, обновление,
          помощник, уведомления, часы. Часы — в самом углу, как в системе:
          справа налево идёт от самого нужного взгляду к редкому, и ряд не
          ломается на середине широкой меткой времени. Порядок зон не меняется
          — по нему запоминают, куда вести мышь */}
      <div className="shrink-0 flex items-center gap-1">
        {/* Проект меняют по двадцать раз в день. Раньше нажатие открывало
            окно раздела «Проекты» целиком — на частое действие показывали
            всё, что известно о проектах. Теперь короткий список, поиск и
            строка «Все проекты» для того самого окна */}
        {activeProject && (
          <ProjectSwitcher
            compact={false}
            variant="tray"
            maxWidth={fit.projectMax}
            onOpenAll={() => openSection('/projects')}
          />
        )}
        <DbStatusTray trayBtn={trayBtn} />

        {/* Physical display mode replaces the virtual-desk switcher in the tray. */}
        {displayWorkspace.displays.length > 1 && <button
          type="button"
          aria-label={displayWorkspace.enabled ? 'Вернуться к одному монитору' : 'Рабочий стол на всех мониторах'}
          title={displayWorkspace.enabled ? 'Отключить рабочую область на всех мониторах · Ctrl+Alt+M' : 'Включить рабочую область на всех мониторах · Ctrl+Alt+M'}
          aria-pressed={displayWorkspace.enabled}
          onClick={() => void useDisplayStore.getState().setAllMonitors(!displayWorkspace.enabled)}
          style={{ width: BAR_BTN, height: BAR_BTN }}
          className={trayBtn(displayWorkspace.enabled)}>
          <Monitor size={TRAY_ICON} />
        </button>}

        {/* Обновление — как в системе: значок у часов светится, когда есть что
            поставить, и по нажатию открывает раздел обновлений. Иначе о новой
            версии узнаёт только тот, кто сам зашёл в настройки и нажал
            «Проверить», — то есть почти никто */}
        {hasUpdate && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('flux:open-updates'))}
            data-tour="app-update-trigger"
            title={`Доступно обновление v${updateVersion} — нажмите, чтобы поставить`}
            style={{ width: BAR_BTN, height: BAR_BTN }}
            className={trayBtn(false)}
          >
            <ArrowUpCircle size={TRAY_ICON} className="text-emerald-600 dark:text-emerald-400" />
            {/* Непросмотренное — точка, без бесконечного мигания: движение в
                покое отвлекает от работы сильнее, чем помогает заметить */}
            {!updateSeen && <span aria-hidden className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-dark-bg" />}
          </button>
        )}

        <button
          type="button"
          onClick={toggleAssist}
          aria-pressed={assistOpen}
          data-tray-toggle
          title="Flux Guide: справка, вопросы и данные проекта (F1 — справка в окне)"
          data-tour="guide-btn"
          style={{ width: BAR_BTN, height: BAR_BTN }}
          className={trayBtn(assistOpen)}
        >
          <MessageCircleQuestion size={TRAY_ICON} />
        </button>

        {/* Уведомления и часы — одна группа вплотную друг к другу, как в системе:
            часы остаются в самом углу, колокольчик слева от них. Оба открывают
            один и тот же правый центр уведомлений с календарём под списком:
            смотрят на часы не чтобы узнать время, а чтобы понять, что сегодня */}
        <div className="flex items-center">
          <button
            type="button"
            onClick={togglePanel}
            aria-pressed={notifOpen}
            data-tray-toggle
            title={isQuiet(quiet)
              ? `Тихий режим ${untilLabel(quiet!)} — уведомления копятся, но не всплывают`
              : notifUnread > 0 ? `Уведомления: ${notifUnread} непрочитанных` : 'Уведомления'}
            data-tour="notif-btn"
            style={{ width: BAR_BTN - 4, height: BAR_BTN }}
            className={trayBtn(notifOpen)}
          >
            {isQuiet(quiet) ? <BellOff size={TRAY_ICON} /> : <Bell size={TRAY_ICON} />}
            {notifUnread > 0 && (
              <span aria-hidden className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${chatUnread > 0 ? 'bg-emerald-500' : 'bg-rose-600'}`} />
            )}
          </button>

          <button
            type="button"
            onClick={togglePanel}
            aria-expanded={notifOpen}
            data-tray-toggle
            data-tour="clock-btn"
            title="Уведомления и календарь: что сегодня и что впереди"
            style={{ height: BAR_BTN }}
            className={`flex flex-col items-end justify-center leading-tight px-2.5 tabular-nums select-none rounded-lg
                        cursor-pointer transition-colors ${notifOpen
              ? 'bg-slate-200/70 dark:bg-slate-800'
              : 'hover:bg-slate-200/60 dark:hover:bg-slate-800'}`}
          >
            <b className="text-sm font-medium text-slate-800 dark:text-slate-150">{clockLabel(now)}</b>
            <span className="text-2xs text-slate-500 dark:text-slate-400">{deadlineLabel(null, now)}</span>
          </button>
        </div>

        {/* Учётная запись живёт в Пуске, как в системе. Круг с инициалами стоял
            здесь же и повторял его подвал целиком — человек, роль, тема,
            параметры, выход, завершение работы, — а второй вход в одно и то же
            место только заставляет гадать, чем они отличаются */}

        {/* Полоска «показать стол» у самого края: мышь упирается в угол и
            попадает не глядя. Девять точек, которые ничего не стоят */}
        <button
          type="button"
          onClick={minimizeAll}
          title="Показать стол — свернуть все окна"
          aria-label="Свернуть все окна"
          /* Во всю высоту панели и вплотную к краю окна: в угол экрана мышь
             упирается и попадает не глядя — тем полоска и берёт, а не
             размером. Отступы сверху и снизу этот угол отрезали */
          style={{ width: BAR_EDGE }}
          className="self-stretch ml-1 cursor-pointer
                     border-l border-slate-200 dark:border-dark-border
                     hover:bg-slate-100 dark:hover:bg-slate-850 transition-colors"
        />
      </div>

      {peek && (
        <TaskbarPeek path={peek.path} displayId={displayId} center={peek.center} barWidth={barWidth}
          onEnter={keepPeek} onLeave={disarmPeek} onClose={() => setPeek(null)} />
      )}
      {moreMenu && (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          items={view.hidden.map((b) => ({
            label: b.badge > 0 ? `${b.title} · ${badgeLabel(b.badge)}` : b.title,
            onClick: () => openSection(b.path),
          }))}
          onClose={() => setMoreMenu(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
