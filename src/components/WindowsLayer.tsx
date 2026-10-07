/**
 * Слой окон: сам стол, окна поверх него и подсветка прилипания.
 *
 * Разделы внутри окон живут тем же keep-alive, что и в панелях: свёрнутое окно
 * остаётся смонтированным и просто скрывается, поэтому вернуться к нему —
 * значит увидеть тот же открытый документ на том же месте.
 *
 * Перетаскивание и размер считает src/lib/windows.ts; здесь только события
 * указателя и разметка.
 */
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Minus, Square, X, Copy } from 'lucide-react';
import { SECTIONS, isKnownSection, sectionForPath } from '../workspace/sections';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useWindowStore } from '../store/windowStore';
import { useWindowTitleStore } from '../store/windowTitleStore';
import { MIN_W, snapZoneAt, type Edge, type SnapZone, type WinState } from '../lib/windows';
import { layoutsFor, otherShares, panelSpot, shareStyle, type Layout, type Share } from '../lib/layouts';
import SnapPanel, { PANEL_W, panelHeight } from './SnapPanel';
import SnapAssist from './SnapAssist';
import { deskAction, isTyping, nextInCycle } from '../lib/deskKeys';
import { sectionAccess } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import SectionFrame, { asHref } from './SectionFrame';
import Desktop from './Desktop';
import Taskbar from './Taskbar';
import { useDisplayStore, workspaceAreas } from '../store/displayStore';
import { displayAt, displayForRect, displaySnap, type DisplayRect } from '../../workspace/displays';
import { shareRect } from '../lib/layouts';
import { BAR_H } from '../lib/metrics';
import { Z } from '../lib/layers';

/** Восемь краёв: четыре стороны и четыре угла */
const EDGES: { edge: Edge; cls: string }[] = [
  { edge: 'n', cls: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 's', cls: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 'w', cls: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'e', cls: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'nw', cls: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { edge: 'ne', cls: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
];

function WindowFrame({
  win, isTop, hidden, liveLocation, globalNavigate, onSnapArm, onSnapDisarm, onSnapOpen, onSnapClose,
}: {
  win: WinState;
  isTop: boolean;
  /** Окно не на этом столе: остаётся живым, но не показывается */
  hidden: boolean;
  liveLocation: ReturnType<typeof useLocation>;
  globalNavigate: ReturnType<typeof useNavigate>;
  /** Наведение на квадратик: панель долей раскроется через 400 мс */
  onSnapArm: (id: string, el: HTMLElement) => void;
  onSnapDisarm: () => void;
  onSnapOpen: (id: string, el: HTMLElement) => void;
  onSnapClose: () => void;
}) {
  const def = sectionForPath(win.path);
  const Icon = SECTIONS.find((s) => s.path === win.path)?.icon as any;
  const st = useWindowStore;
  // Имя окну даёт содержимое: «Ведомость В-1», а не «Конструктор». Нет
  // открытого документа — остаётся имя программы
  const title = useWindowStore((s) => s.titles[win.id]) || def.title;
  // На это окно навели в списке на панели задач — обводим, чтобы было понятно,
  // какое из трёх поднимется
  const peeked = useWindowStore((s) => s.peeked === win.id);
  // A browser or embedded workspace can be narrower than the desktop window
  // minimum. In that case the window occupies the available viewport so its
  // controls and contents remain reachable.
  const compactViewport = window.innerWidth < MIN_W;

  /**
   * Перетаскивание и размер на указателе, а не на мыши: одним кодом работают
   * мышь, тачпад и перо. Захват указателя обязателен — без него окно
   * «срывается», как только курсор обгонит перерисовку.
   */
  const drag = (e: React.PointerEvent, edge: Edge | null) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    st.getState().focus(win.id);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = { x: e.clientX, y: e.clientY };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      if (edge) { st.getState().resize(win.id, edge, dx, dy); return; }
      st.getState().move(win.id, dx, dy);
      // Подсветка считается от курсора, а не от края окна: человек целится
      // курсором, и попадание должно совпадать с тем, что он видит
      const box = el.closest('[data-desk]')?.getBoundingClientRect();
      if (box) {
        const x = ev.clientX - box.left, y = ev.clientY - box.top;
        const monitor = displayAt(st.getState().displays, x, y);
        const bounds = monitor?.workArea || { x: 0, y: 0, w: box.width, h: box.height };
        if (monitor) st.getState().setActiveDisplay(monitor.id);
        st.getState().setSnapping(snapZoneAt(x - bounds.x, y - bounds.y, bounds), monitor?.id);
      }
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      const zone = st.getState().snapping;
      if (!edge && zone) st.getState().applySnap(win.id, zone);
      else { st.getState().setSnapping(null); if (!edge) st.getState().finishMove(win.id); }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  // Раздел может занять заголовок целиком (Проводник: полоса вкладок 38 точек).
  // Тогда рама отдаёт ему место, а сама оставляет только кнопки окна
  const claim = useWindowTitleStore((s) => s.claims[win.id]);
  const hostRef = React.useCallback((el: HTMLDivElement | null) => useWindowTitleStore.getState().setHost(win.id, el), [win.id]);
  React.useEffect(() => () => { useWindowTitleStore.getState().setHost(win.id, null); }, [win.id]);

  const btn = claim
    // Кнопки на всю высоту полосы, 46 точек шириной, как в Windows 11; красная заливка у «Закрыть» — тоже оттуда
    ? 'w-[46px] self-stretch flex items-center justify-center cursor-pointer transition-colors'
    : 'w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors';
  // Цвет кнопок полосы раздела: светлая плашка при наведении, как в Windows 11
  const capClaimed = 'text-slate-500 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/10';

  return (
    <div
      role="dialog"
      aria-label={title}
      data-win={win.id}
      onPointerDownCapture={() => { if (!isTop) st.getState().focus(win.id); }}
      style={{
        left: compactViewport ? 0 : win.x, top: win.y,
        width: compactViewport ? window.innerWidth : win.w,
        height: win.h, zIndex: 10 + win.z,
        display: win.minimized || hidden ? 'none' : undefined,
      }}
      /* Активное окно отличает тень и тёмное название, а не зелёная рамка и
         зелёный заголовок: акцент по методологии — только у главной кнопки,
         фокуса и «включено» (01-design.md, раздел 3). Подсветка при
         подглядывании с панели задач осталась — это указание, а не украшение */
      className={`absolute flex flex-col rounded-xl overflow-hidden bg-white dark:bg-dark-bg border transition-shadow ${
        peeked
          ? 'border-emerald-500 shadow-2xl ring-2 ring-emerald-500/40'
          : isTop
            ? 'border-slate-300 dark:border-slate-600 shadow-2xl'
            : 'border-slate-200 dark:border-dark-border shadow-lg'
      }`}
    >
      <div
        onPointerDown={(e) => drag(e, null)}
        onDoubleClick={() => st.getState().maximize(win.id)}
        style={claim ? { height: claim.height } : undefined}
        /* 34 точки: попасть можно, и не жалко экрана при четырёх окнах. Когда
           раздел занял заголовок, высоту и фон полосы задаёт он */
        className={claim
          ? `shrink-0 flex items-center select-none ${claim.className}`
          : `h-[34px] shrink-0 flex items-center gap-2 px-2.5 select-none cursor-grab active:cursor-grabbing
                    border-b border-slate-200 dark:border-dark-border bg-white dark:bg-dark-bg`}
      >
        {!claim && Icon && <Icon className={`w-4 h-4 shrink-0 ${isTop ? 'text-slate-500 dark:text-slate-300' : 'text-slate-300 dark:text-slate-500'}`} />}
        {!claim && <span className={`flex-1 min-w-0 truncate text-xs font-medium ${isTop ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}`}
          title={title === def.title ? title : `${title} · ${def.title}`}>{title}</span>}
        {/* Место раздела: пустое и скрытое, пока слот не занят */}
        <div ref={hostRef} data-title-host className={claim ? 'flex-1 min-w-0 self-stretch' : 'hidden'} />
        <button type="button" title="Свернуть" aria-label="Свернуть"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => st.getState().minimize(win.id)}
          className={`${btn} ${claim ? capClaimed : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-850'}`}>
          <Minus className="w-3.5 h-3.5" />
        </button>
        {/* Квадратик: нажатие разворачивает, наведение и правая кнопка
            раскрывают доли экрана. Привычное поведение не отнимаем */}
        <button type="button"
          title={win.maximized ? 'Вернуть размер' : 'Развернуть. Наведите — доли экрана'}
          aria-label="Развернуть"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { onSnapClose(); st.getState().maximize(win.id); }}
          onContextMenu={(e) => { e.preventDefault(); onSnapOpen(win.id, e.currentTarget as HTMLElement); }}
          onMouseEnter={(e) => onSnapArm(win.id, e.currentTarget as HTMLElement)}
          onMouseLeave={onSnapDisarm}
          className={`${btn} ${claim ? capClaimed : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-850'}`}>
          {win.maximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3 h-3" />}
        </button>
        <button type="button" title="Закрыть" aria-label="Закрыть"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { void st.getState().requestClose(win.id); }}
          className={`${btn} ${claim ? 'text-slate-500 dark:text-slate-300 hover:bg-[#c42b1c]' : 'text-slate-500 hover:bg-rose-600'} hover:text-white`}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Окно объявляет себя мерой ширины: разделы спрашивают его, а не экран.
          Метка нужна проверке раскладки — она мерит окно, а не стол */}
      <div data-window-body className="@container relative flex-1 min-h-0">
        <SectionFrame
          paneId={`win:${win.id}`}
          path={win.path}
          href={win.href}
          visible={!hidden}
          isLive={isTop}
          liveLocation={liveLocation}
          globalNavigate={globalNavigate}
        />
      </div>

      {!win.maximized && EDGES.map(({ edge, cls }) => (
        <span
          key={edge}
          onPointerDown={(e) => drag(e, edge)}
          /* Полоса захвата 6 точек снаружи содержимого: попасть можно,
             случайно потянуть — нет */
          className={`absolute ${cls} z-10`}
        />
      ))}
    </div>
  );
}

export default function WindowsLayer() {
  const handledNavigation = React.useRef<string | null>(null);
  const windows = useWindowStore((s) => s.windows);
  const snapping = useWindowStore((s) => s.snapping);
  const area = useWindowStore((s) => s.area);
  const desk = useWindowStore((s) => s.desk);
  const setArea = useWindowStore((s) => s.setArea);
  const location = useLocation();
  const navigate = useNavigate();
  const policy = useAppContext();
  const deskRef = React.useRef<HTMLDivElement>(null);
  const workspace = useDisplayStore(s => s.workspace);
  const displayReady = useDisplayStore(s => s.available);
  const displays = useWindowStore(s => s.displays);
  const snappingDisplayId = useWindowStore(s => s.snappingDisplayId);
  React.useLayoutEffect(() => {
    // Пока native-мост отвечает, сохраняем прошлую топологию: иначе старт
    // сначала сдвинет окна в обычное окно, затем повторно в общий стол.
    if (!displayReady && (window as any).electron?.displays) return;
    useWindowStore.getState().setDisplayAreas(workspace.enabled ? workspaceAreas(workspace) : [], workspace.enabled ? workspace.bounds : null);
  }, [workspace, displayReady]);
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.code !== 'KeyM') return;
      const state = useDisplayStore.getState();
      if (!state.available || (!state.workspace.enabled && state.workspace.displays.length < 2)) return;
      e.preventDefault();
      void state.setAllMonitors(!state.workspace.enabled);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const desktopBounds = displays.length ? displays.reduce((r, d) => ({
    x: Math.min(r.x, d.workArea.x), y: Math.min(r.y, d.workArea.y),
    w: Math.max(r.x + r.w, d.workArea.x + d.workArea.w) - Math.min(r.x, d.workArea.x),
    h: Math.max(r.y + r.h, d.workArea.y + d.workArea.h) - Math.min(r.y, d.workArea.y),
  }), { ...displays[0].workArea }) : { x: 0, y: 0, w: area.w, h: area.h };
  const snapBounds = displays.find(d => d.id === snappingDisplayId)?.workArea || { x: 0, y: 0, ...area };

  // Стол меряем сами и сообщаем геометрии: она не должна знать про DOM
  React.useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setArea({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setArea]);

  // На столе видны только его окна: стол — это набор окон, а не второй экран
  const mine = React.useMemo(() => windows.filter((w) => w.desk === desk), [windows, desk]);
  const topWin = React.useMemo(() => {
    const vis = mine.filter((w) => !w.minimized);
    return vis.length ? vis.reduce((a, b) => (b.z > a.z ? b : a)) : null;
  }, [mine]);
  const top = topWin?.id || null;

  /**
   * Верхнее окно и общий адрес — одно и то же. Раздел верхнего окна «живой»:
   * его location берётся из адреса программы. Разойдясь, они дали бы живому
   * разделу чужой адрес — открытый Конструктор получил бы параметры Тегов.
   *
   * Панели держат ту же связь (см. Workspace), окнам она нужна ровно так же:
   * без неё не работают ни ссылка на документ, ни кнопка «назад».
   */
  React.useEffect(() => {
    if (!topWin) return;
    const here = asHref(location);
    if (here === topWin.href) return;
    const remembered = useWorkspaceStore.getState().frozenHrefs[`win:${topWin.id}::${topWin.path}`];
    navigate(remembered || topWin.href, { state: { __windowSync: true } });
  }, [topWin?.id, topWin?.href]);

  /**
   * Живое окно ушло на другой адрес (открыли документ из библиотеки, зашли в
   * папку) — окно обязано это запомнить. Иначе оно потеряет себя: следующее
   * открытие того же документа заведёт ещё одно окно рядом.
   */
  React.useEffect(() => {
    if (!topWin) return;
    const here = asHref(location);
    // Только собственный переход окна. Тот же адрес, пришедший снаружи, — это
    // просьба открыть документ, и решать её должно следующее правило: иначе
    // окно молча забирало бы себе чужой адрес, и второе окно не появлялось
    if ((location.state as any)?.__pane !== `win:${topWin.id}`) return;
    if (here.split('?')[0] !== topWin.path) return;
    useWindowStore.getState().setHref(topWin.id, here);
  }, [location, topWin?.id]);

  /**
   * Обратная сторона той же связи: адрес пришёл извне (ссылка, помощник,
   * двойное нажатие по документу на столе) — поднимаем нужное окно.
   *
   * Именно layout-эффект, а не обычный: решение принимается до показа кадра.
   * Обычный эффект успевал показать чужой адрес в прежнем верхнем окне — и то
   * запоминало его себе. Два окна оказывались на одном документе и начинали
   * спорить автосохранением.
   */
  React.useLayoutEffect(() => {
    if (!isKnownSection(location.pathname)) return;
    // «/» — начальный адрес программы, а не просьба открыть Главную. Открывали
    // бы — поверх пустого стола всплывало бы окно, которого не просили, и
    // закрыть его насовсем было бы нельзя: вход, выход из раздела и просто
    // перезапуск снова приводят сюда. Главная открывается со стола, из Пуска
    // и с панели задач — там нажатие сказано вслух
    if (location.pathname === '/') return;
    /**
     * Адресная строка — тоже поверхность.
     *
     * Скрытый раздел окна не открывает, и раньше адрес после такой попытки
     * так и оставался «/play» при пустом столе: сам по себе это уже ответ на
     * вопрос, есть ли в программе такой раздел. Возвращаем на Главную, как
     * будто адреса не существует, — то же самое делает рама раздела, когда
     * успевает смонтироваться
     */
    if (sectionAccess(sectionForPath(location.pathname), policy) === 'hide') {
      navigate('/', { replace: true });
      return;
    }
    // Rights refresh and shell focus synchronization are not launch commands.
    const navigationKey = location.key || asHref(location);
    if (handledNavigation.current === navigationKey) return;
    handledNavigation.current = navigationKey;
    if ((location.state as any)?.__windowSync) return;
    const st = useWindowStore.getState();
    const here = asHref(location);
    const cur = st.windows.filter((w) => !w.minimized && w.desk === st.desk);
    const now = cur.length ? cur.reduce((a, b) => (b.z > a.z ? b : a)) : null;
    // Переход внутри самого окна и по тому же разделу — это оно и перешло:
    // человек открыл документ из библиотеки Конструктора и остался в своём
    // окне. Адрес запоминает следующий эффект, открывать нечего
    const from = (location.state as any)?.__pane;
    if (now && from === `win:${now.id}` && now.path === location.pathname) return;
    st.open(here);
  }, [location, policy, navigate]);

  /**
   * Клавиши окон: Alt+Tab по кругу, Ctrl+F4 закрыть, Ctrl+Alt+D показать стол.
   * Alt+Tab работает и во время набора — это переключение между окнами, а не
   * правка содержимого, и отбирать его у человека нельзя (см. src/lib/deskKeys).
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = deskAction(e, { typing: isTyping(document.activeElement as any), hasSelection: false });
      if (act !== 'nextWindow' && act !== 'prevWindow' && act !== 'closeWindow'
        && act !== 'minimizeAll' && act !== 'newWindow') return;
      const st = useWindowStore.getState();
      if (!st.windows.length) return;
      e.preventDefault();
      if (act === 'minimizeAll') { st.minimizeAll(); return; }
      const cur = st.windows.filter((w) => !w.minimized && w.desk === st.desk)
        .reduce<typeof st.windows[number] | null>((a, b) => (!a || b.z > a.z ? b : a), null);
      if (act === 'closeWindow') { if (cur) void st.requestClose(cur.id); return; }
      if (act === 'newWindow') {
        // Ещё одно окно той же программы: у единичных разделов второго не бывает
        if (cur && sectionForPath(cur.path).multi) st.openAnother(cur.href);
        return;
      }
      const next = nextInCycle(st.windows.filter((w) => w.desk === st.desk), cur?.id || null, act === 'prevWindow');
      if (next) st.focus(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Доли экрана: панель у кнопки разворота ──
  const [snap, setSnap] = React.useState<{ id: string; x: number; y: number; bounds: DisplayRect; displayId?: number } | null>(null);
  const [shareHint, setShareHint] = React.useState<Share | null>(null);
  const [assist, setAssist] = React.useState<{ shares: Share[]; skip: string[]; displayId?: number } | null>(null);
  const snapTimer = React.useRef<any>(null);

  const openSnap = React.useCallback((id: string, el: HTMLElement) => {
    const desk = deskRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!desk) return;
    const st = useWindowStore.getState();
    const win = st.windows.find(w => w.id === id);
    const display = win ? displayForRect(st.displays, win) : null;
    const bounds = display?.workArea || { x: 0, y: 0, ...st.area };
    const count = layoutsFor(bounds).length;
    if (!count) return; // столу тесно — предлагать нечего, и панель не открываем
    const spot = panelSpot(
      { x: r.left - desk.left - bounds.x, y: r.top - desk.top - bounds.y, h: r.height },
      { w: PANEL_W, h: panelHeight(count) },
      bounds,
    );
    setSnap({ id, x: spot.x + bounds.x, y: spot.y + bounds.y, bounds, displayId: display?.id });
  }, []);
  const armSnap = React.useCallback((id: string, el: HTMLElement) => {
    clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => openSnap(id, el), 400);
  }, [openSnap]);
  const disarmSnap = React.useCallback(() => clearTimeout(snapTimer.current), []);
  const closeSnap = React.useCallback(() => {
    clearTimeout(snapTimer.current);
    setSnap(null);
    setShareHint(null);
  }, []);
  React.useEffect(() => () => clearTimeout(snapTimer.current), []);
  React.useEffect(() => { closeSnap(); setAssist(null); }, [displays, closeSnap]);

  /** Выбрали долю: ставим окно и предлагаем занять оставшиеся */
  const pickShare = React.useCallback((layout: Layout, index: number) => {
    const id = snap?.id;
    closeSnap();
    if (!id) return;
    const st = useWindowStore.getState();
    st.putInShare(id, layout.shares[index], snap?.displayId);
    const rest = otherShares(layout, index);
    // Занимать нечем — предлагать нечего: одно окно на столе это не раскладка
    const others = st.windows.filter((w) => w.id !== id && w.desk === st.desk);
    setAssist(others.length && rest.length ? { shares: rest, skip: [id], displayId: snap?.displayId } : null);
  }, [snap, closeSnap]);

  // Win+Z — панель долей у верхнего окна, как в системе
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (deskAction(e, { typing: isTyping(document.activeElement as any), hasSelection: false }) !== 'snapPanel') return;
      const st = useWindowStore.getState();
      const cur = st.windows.filter((w) => !w.minimized && w.desk === st.desk)
        .reduce<WinState | null>((a, b) => (!a || b.z > a.z ? b : a), null);
      if (!cur) return;
      e.preventDefault();
      const el = deskRef.current?.querySelector(`[data-win="${cur.id}"] [aria-label="Развернуть"]`);
      if (el) openSnap(cur.id, el as HTMLElement);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSnap]);

  return (
    <div
      ref={deskRef}
      data-desk
      onPointerDownCapture={e => {
        const box = e.currentTarget.getBoundingClientRect();
        const display = displayAt(displays, e.clientX - box.left, e.clientY - box.top);
        if (display) useWindowStore.getState().setActiveDisplay(display.id);
      }}
      className="relative w-full h-full overflow-hidden bg-slate-100 dark:bg-dark-bg"
    >
      {/* Значки живут под окнами: стол — это фон, а не ещё одно окно */}
      <div className="absolute overflow-hidden" style={{ left: desktopBounds.x, top: desktopBounds.y, width: desktopBounds.w, height: desktopBounds.h }}>
        <Desktop screenOrigin={workspace.enabled ? { x: workspace.bounds.x, y: workspace.bounds.y } : undefined} />
      </div>
      {displays.map(d => <div key={d.id} data-display-taskbar={d.id}
        className="absolute" style={{ left: d.workArea.x, top: d.workArea.y + d.workArea.h - BAR_H, width: d.workArea.w, height: BAR_H, zIndex: Z.taskbar }}>
        <Taskbar displayId={d.id} />
      </div>)}

      {/* Показываем окна этого стола, но держим смонтированными все: раздел на
          соседнем столе продолжает жить — с открытым документом, набранным и
          ещё не сохранённым текстом, местом прокрутки. Стол переключают
          мимоходом, и терять на этом работу нельзя */}
      {windows.map((w) => (
        <WindowFrame
          key={w.id}
          win={w}
          isTop={w.id === top}
          hidden={w.desk !== desk}
          liveLocation={location}
          globalNavigate={navigate}
          onSnapArm={armSnap}
          onSnapDisarm={disarmSnap}
          onSnapOpen={openSnap}
          onSnapClose={closeSnap}
        />
      ))}

      {/* Куда встанет окно по выбранной доле — зажигаем место на столе */}
      {shareHint && (
        <div aria-hidden style={(() => { const bounds = snap?.bounds || { x: 0, y: 0, ...area }; const r = shareRect(shareHint, bounds); return { left: r.x + bounds.x, top: r.y + bounds.y, width: r.w, height: r.h }; })()}
          className="absolute z-[59] rounded-xl border-2 border-emerald-500 bg-emerald-500/10 pointer-events-none" />
      )}

      {snap && (
        <SnapPanel
          area={snap.bounds}
          x={snap.x}
          y={snap.y}
          onPick={pickShare}
          onHover={setShareHint}
          onClose={closeSnap}
        />
      )}

      {assist && (
        <SnapAssist shares={assist.shares} skip={assist.skip} displayId={assist.displayId} onClose={() => setAssist(null)} />
      )}

      {/* Куда встанет окно, если отпустить: показываем до того, как отпустили */}
      {snapping && (
        <div
          aria-hidden
          style={(() => { const r = displaySnap(snapping, snapBounds); return { left: r.x, top: r.y, width: r.w, height: r.h }; })()}
          className="absolute z-[9] rounded-xl border-2 border-emerald-500 bg-emerald-500/10 pointer-events-none"
        />
      )}
    </div>
  );
}
