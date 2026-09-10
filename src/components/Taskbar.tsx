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
  Bell, BellOff, LayoutGrid, MessageCircleQuestion, LifeBuoy, ArrowUpCircle,
} from 'lucide-react';
import { SECTIONS } from '../workspace/sections';
import { openSectionWindow, rememberSectionUse } from '../store/workspaceStore';
import { useStore } from '../store/store';
import { useNotificationStore } from '../store/notificationStore';
import { useFeedbackStore } from '../store/feedbackStore';
import { useShellNotifyStore } from '../store/shellNotifyStore';
import { isQuiet, untilLabel } from '../lib/notifCenter';
import { useAssistantStore } from '../store/assistantStore';
import { useMailStore } from '../store/mailStore';
import { useWindowStore, openPaths, activeWindowPath, windowsOf } from '../store/windowStore';
import { useDesktopStore } from '../store/desktopStore';
import { buildTaskbar, clockLabel, deadlineLabel, badgeLabel, trayFit } from '../lib/taskbar';
import { BAR_H, BAR_BTN, BAR_ICON, BAR_EDGE, CHIP_H, RUN_MARK } from '../lib/metrics';
import { Z } from '../lib/layers';
import ContextMenu, { MenuItem } from './ContextMenu';
import StartMenu from './StartMenu';
import TaskbarPeek from './TaskbarPeek';
import DeskSwitcher from './DeskSwitcher';
import ProjectSwitcher from './ProjectSwitcher';
import ClockPanel from './calendar/ClockPanel';
import { useUpdateStore, updateReady } from '../store/updateStore';

/** Минута — самый крупный шаг, который видно на часах без секунд */
function useNow(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function Taskbar() {
  const user = useStore((s) => s.user);
  const activeProject = useStore((s) => s.activeProject);
  const windows = useWindowStore((s) => s.windows);
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
  const setNotifOpen = useNotificationStore((s) => s.setPanelOpen);
  const assistantOpen = useAssistantStore((s) => s.isOpen);
  const setAssistantOpen = useAssistantStore((s) => s.setOpen);
  const unreadByAccount = useMailStore((s) => s.unreadByAccount);
  const now = useNow();
  const [menu, setMenu] = React.useState<{ x: number; y: number; path: string } | null>(null);
  const [startOpen, setStartOpen] = React.useState(false);
  // Наведение раскрывает список окон программы. 400 мс — столько же, сколько
  // ждёт всплывающая подсказка: быстрое движение мимо кнопки ничего не открывает
  const [peek, setPeek] = React.useState<{ path: string; left: number } | null>(null);
  const peekTimer = React.useRef<any>(null);
  const armPeek = (path: string, el: HTMLElement) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => {
      const row = rowRef.current?.getBoundingClientRect();
      const btn = el.getBoundingClientRect();
      setPeek({ path, left: Math.max(0, btn.left - (row?.left || 0) + (row ? rowRef.current!.scrollLeft : 0)) });
    }, 400);
  };
  const disarmPeek = () => { clearTimeout(peekTimer.current); };
  React.useEffect(() => () => clearTimeout(peekTimer.current), []);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<HTMLButtonElement>(null);
  // Список свёрнутых кнопок: открывается тем же меню, что и правая кнопка
  const [moreMenu, setMoreMenu] = React.useState<{ x: number; y: number } | null>(null);
  // Панель календаря по часам — такая же панель трея, как уведомления
  const [clockOpen, setClockOpen] = React.useState(false);
  const [width, setWidth] = React.useState(0);
  const [barWidth, setBarWidth] = React.useState(0);

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
    toggleWindow(path);
  }, [toggleWindow]);

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
  const sources = React.useMemo(
    () => SECTIONS.map((s) => ({ ...s, pinned: barPins.includes(s.path) })),
    [barPins],
  );

  const view = React.useMemo(
    () => buildTaskbar(sources, {
      open,
      activePath: highlighted,
      counts: { mail, chat: chatUnread, feedback: feedbackUnread },
      isAdmin: user?.role === 'ADMIN',
      width,
    }),
    [sources, open, highlighted, mail, chatUnread, feedbackUnread, user?.role, width],
  );

  const iconOf = (path: string) => SECTIONS.find((s) => s.path === path)?.icon;

  const countOfWindows = React.useCallback(
    (path: string) => windowsOf(windows, path, desk).length,
    [windows, desk],
  );
  /** Нажали по кнопке со стопкой: список окон открывается сразу, без задержки */
  const armPeekNow = (path: string, el: HTMLElement) => {
    const row = rowRef.current?.getBoundingClientRect();
    const btn = el.getBoundingClientRect();
    setPeek({ path, left: Math.max(0, btn.left - (row?.left || 0) + (rowRef.current?.scrollLeft || 0)) });
  };

  const menuItems: MenuItem[] = menu ? [
    { label: 'Открыть', onClick: () => openSection(menu.path) },
    { label: 'Открыть в отдельном окне', onClick: () => openSectionWindow(menu.path) },
    barPins.includes(menu.path)
      ? { label: 'Открепить от панели', separated: true, onClick: () => unpinBar(menu.path) }
      : { label: 'Закрепить на панели', separated: true, onClick: () => pinBar(menu.path) },
    ...(countOfWindows(menu.path) > 0 ? [{
      label: countOfWindows(menu.path) > 1 ? `Закрыть все окна (${countOfWindows(menu.path)})` : 'Закрыть окно',
      onClick: () => {
        const st = useWindowStore.getState();
        for (const w of windowsOf(st.windows, menu.path, st.desk)) st.close(w.id);
      },
    }] : []),
  ] : [];

  // Обе панели выезжают справа и заняли бы одно место — открываем по одной
  // Помощник открывается, не закрывая уведомления: правая колонка держит обоих
  // (components/RightDock), и терять начатое чтение при вопросе больше не надо
  const openAssistant = () => setAssistantOpen(!assistantOpen);

  /**
   * Справка по тому разделу, где человек стоит, — то же, что F1. Помощник
   * отвечает на вопрос словами, руководство объясняет раздел целиком: это
   * разные нужды, поэтому и кнопки разные.
   */
  const openHandbook = () => {
    const path = highlighted || '/';
    if (path === '/handbook') return;
    const href = `/handbook?for=${encodeURIComponent(path)}`;
    rememberSectionUse('/handbook');
    useWindowStore.getState().open(href);
  };

  /**
   * Обновление в трее. Раздел настроек открывается сразу на нужном месте:
   * «нажал на значок — попал в обновления», а не «нажал и ищи, где это».
   */
  const hasUpdate = useUpdateStore(updateReady);
  const updateVersion = useUpdateStore((s) => s.latest?.version || '');
  const updateSeen = useUpdateStore((s) => s.seen);
  const checkUpdate = useUpdateStore((s) => s.check);
  const initUpdate = useUpdateStore((s) => s.init);

  React.useEffect(() => {
    void initUpdate(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
    // Первая проверка — после того, как оболочка поднялась; дальше раз в час и
    // мгновенно, когда администратор публикует релиз
    const first = setTimeout(() => { void checkUpdate(true); }, 8000);
    const timer = setInterval(() => { void checkUpdate(true); }, 3600000);
    const onPublished = () => { void checkUpdate(true); };
    window.addEventListener('socket:app:update-published', onPublished);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('socket:app:update-published', onPublished);
    };
  }, [initUpdate, checkUpdate]);

  const openUpdates = () => {
    useUpdateStore.getState().markSeen();
    const href = '/settings?section=updates';
    rememberSectionUse('/settings');
    useWindowStore.getState().open(href);
  };

  const trayBtn = (active: boolean) =>
    `relative rounded-[10px] cursor-pointer flex items-center justify-center transition-colors ${
      active
        ? 'bg-emerald-600 text-white'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'
    }`;

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Панель задач"
      data-taskbar
      /* Высота, рост кнопки и размер значка — общая мера оболочки
         (src/lib/metrics.ts): панель обязана быть того же роста, что и ряд
         значков в системе, иначе программа рядом с ней выглядит увеличенной */
      /* Справа без отступа: последняя в ряду полоска «показать стол» обязана
         доходить до самого края окна, иначе угол экрана перестаёт быть целью */
      style={{ height: BAR_H, zIndex: Z.taskbar }}
      className="relative shrink-0 flex items-center gap-1 pl-2
                 bg-white dark:bg-dark-surface border-t border-slate-200 dark:border-dark-border"
    >
      {startOpen && <StartMenu onClose={() => setStartOpen(false)} />}

      {/* Пуск — единственная кнопка с заливкой на всей панели, чтобы её
          находили не глядя. Слова на ней нет: в ряду значков подпись — это
          единственная надпись на всей панели, и она же занимает место кнопки
          программы. Имя остаётся там, где его читают не глазами: в подсказке
          и в aria-label */}
      <button
        type="button"
        ref={startRef}
        onClick={() => setStartOpen((v) => !v)}
        aria-expanded={startOpen}
        aria-label="Пуск"
        title="Пуск — все программы и поиск"
        style={{ width: BAR_BTN + 8, height: BAR_BTN }}
        className="flex items-center justify-center rounded-[10px] shrink-0 cursor-pointer
                   bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
      >
        <LayoutGrid size={BAR_ICON + 2} className="shrink-0" />
      </button>

      <div className="w-2 shrink-0" />

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
          const Icon = iconOf(b.path) as any;
          return (
            <button
              key={b.path}
              type="button"
              onClick={(e) => {
                // Окон несколько — выбирают из списка, а не наугад поднимают
                if (countOfWindows(b.path) > 1) {
                  armPeekNow(b.path, e.currentTarget as HTMLElement);
                  return;
                }
                openSection(b.path);
              }}
              onMouseEnter={(e) => armPeek(b.path, e.currentTarget as HTMLElement)}
              onMouseLeave={disarmPeek}
              onAuxClick={(e) => {
                // Средним — ещё одно окно той же программы, привычка из браузера
                if (e.button !== 1) return;
                e.preventDefault();
                openSectionWindow(b.path);
              }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path: b.path }); }}
              title={b.title}
              /* Метка раздела: демонстрации помощника подсвечивают его по
                 ней, и она же стоит на плитке Пуска */
              data-tour={`nav-${b.path}`}
              aria-current={b.active ? 'true' : undefined}
              style={{ height: BAR_BTN }}
              className={`relative px-2.5 rounded-[10px] shrink-0 cursor-pointer flex items-center gap-2
                          text-xs whitespace-nowrap transition-colors border ${
                b.active
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-semibold border-transparent'
                  : b.running
                    ? 'bg-white dark:bg-dark-bg border-slate-200 dark:border-dark-border text-slate-700 dark:text-slate-150'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'
              }`}
            >
              {Icon && <Icon size={BAR_ICON} className="shrink-0" />}
              {view.labels && <span>{b.title}</span>}
              {countOfWindows(b.path) > 1 && (
                <span
                  style={{ height: CHIP_H, minWidth: CHIP_H }}
                  className="shrink-0 px-1 rounded bg-slate-100 dark:bg-slate-850
                             text-2xs font-mono text-slate-500 dark:text-slate-400 tabular-nums
                             flex items-center justify-center" title="Окон этой программы">
                  {countOfWindows(b.path)}
                </span>
              )}
              {b.badge > 0 && (
                <span
                  style={{ height: CHIP_H, minWidth: CHIP_H }}
                  className="shrink-0 px-1.5 rounded-full bg-rose-600 text-white
                             text-2xs font-bold tabular-nums flex items-center justify-center">
                  {badgeLabel(b.badge)}
                </span>
              )}
              {/* Подчёркивание — «запущена». Видно боковым зрением и не спорит
                  с заливкой активной кнопки */}
              {b.running && (
                <span
                  aria-hidden
                  style={{ height: RUN_MARK, bottom: -5 }}
                  className={`absolute rounded-sm bg-emerald-600 dark:bg-emerald-400 ${
                    b.active ? 'left-[16%] right-[16%]' : 'left-[24%] right-[24%]'
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>

      {view.hidden.length > 0 && (
        <button
          type="button"
          onClick={(e) => setMoreMenu({ x: e.clientX, y: e.clientY })}
          title={`Ещё ${view.hidden.length}: не поместились на панель`}
          aria-label={`Ещё ${view.hidden.length} программ`}
          style={{ height: BAR_BTN }}
          className="shrink-0 px-2 rounded-[10px] cursor-pointer text-xs font-bold tabular-nums
                     text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-dark-border
                     hover:bg-slate-100 dark:hover:bg-slate-850 transition-colors"
        >
          »{view.hidden.length}
        </button>
      )}

      {view.tidy && fit.hint && (
        <span className="shrink-0 flex items-center gap-1.5 text-2xs text-amber-700 dark:text-amber-400 px-2 whitespace-nowrap">
          открыто много —
          {/* Настоящая кнопка, а не подчёркнутая строчка: в текст высотой в
              четырнадцать точек надо целиться, и мимо попадают чаще, чем в него */}
          <button
            type="button"
            onClick={tileAll}
            style={{ height: BAR_BTN - 6 }}
            className="px-2 rounded-lg cursor-pointer font-semibold
                       border border-amber-300 dark:border-amber-800
                       hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors"
          >
            разложить
          </button>
        </span>
      )}

      {/* Трей: проект, часы со сроком, уведомления. Порядок зон не меняется
          никогда — по нему запоминают, куда вести мышь */}
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

        {/* Часы нажимаются: человек смотрит на них не чтобы узнать время, а
            чтобы понять, что сегодня. Раньше нажатие не делало ничего */}
        <button
          type="button"
          onClick={() => { setNotifOpen(false); setClockOpen((v) => !v); }}
          aria-expanded={clockOpen}
          title="Календарь: что сегодня и что впереди"
          className={`flex flex-col items-end leading-tight px-3 tabular-nums select-none rounded-[10px]
                      cursor-pointer transition-colors ${clockOpen
            ? 'bg-emerald-50 dark:bg-emerald-950/40'
            : 'hover:bg-slate-100 dark:hover:bg-slate-850'}`}
        >
          <b className="text-sm font-semibold text-slate-800 dark:text-slate-150">{clockLabel(now)}</b>
          <span className="text-2xs text-slate-500 dark:text-slate-400">{deadlineLabel(null, now)}</span>
        </button>

        {/* Столы: рабочих столов может быть несколько, как в системе */}
        <DeskSwitcher />

        <button
          type="button"
          onClick={openAssistant}
          title="Помощник: вопросы по проекту"
          data-tour="assistant-btn"
          style={{ width: BAR_BTN, height: BAR_BTN }}
          className={trayBtn(assistantOpen)}
        >
          <MessageCircleQuestion size={BAR_ICON + 2} />
        </button>

        <button
          type="button"
          onClick={openHandbook}
          title="Руководство по этому разделу (F1)"
          style={{ width: BAR_BTN, height: BAR_BTN }}
          className={trayBtn(false)}
        >
          <LifeBuoy size={BAR_ICON + 2} />
        </button>

        {/* Обновление — как в системе: значок у часов светится, когда есть что
            поставить, и по нажатию открывает раздел обновлений. Иначе о новой
            версии узнаёт только тот, кто сам зашёл в настройки и нажал
            «Проверить», — то есть почти никто */}
        {hasUpdate && (
          <button
            type="button"
            onClick={openUpdates}
            title={`Доступно обновление v${updateVersion} — нажмите, чтобы поставить`}
            style={{ width: BAR_BTN, height: BAR_BTN }}
            className={trayBtn(false)}
          >
            <ArrowUpCircle size={BAR_ICON + 2} className="text-emerald-600 dark:text-emerald-400" />
            <span aria-hidden
              className={`absolute top-1.5 right-2 w-2 h-2 rounded-full bg-emerald-500 ${
                updateSeen ? '' : 'animate-ping'}`} />
            <span aria-hidden className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-emerald-500" />
          </button>
        )}

        <button
          type="button"
          onClick={togglePanel}
          title={isQuiet(quiet)
            ? `Тихий режим ${untilLabel(quiet!)} — уведомления копятся, но не всплывают`
            : notifUnread > 0 ? `Уведомления: ${notifUnread} непрочитанных` : 'Уведомления'}
          data-tour="notif-btn"
          style={{ width: BAR_BTN, height: BAR_BTN }}
          className={trayBtn(notifOpen)}
        >
          {isQuiet(quiet) ? <BellOff size={BAR_ICON + 2} /> : <Bell size={BAR_ICON + 2} />}
          {notifUnread > 0 && (
            <span aria-hidden className={`absolute top-1.5 right-2 w-2 h-2 rounded-full ${chatUnread > 0 ? 'bg-emerald-500' : 'bg-rose-600'}`} />
          )}
        </button>

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

      {clockOpen && <ClockPanel onClose={() => setClockOpen(false)} />}

      {peek && (
        <TaskbarPeek path={peek.path} left={peek.left + 12} onClose={() => setPeek(null)} />
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
