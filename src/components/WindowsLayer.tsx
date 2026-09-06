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
import { snapZoneAt, type Edge, type SnapZone, type WinState } from '../lib/windows';
import { layoutsFor, otherShares, panelSpot, shareStyle, type Layout, type Share } from '../lib/layouts';
import SnapPanel, { PANEL_W, panelHeight } from './SnapPanel';
import SnapAssist from './SnapAssist';
import { deskAction, isTyping, nextInCycle } from '../lib/deskKeys';
import { stepDesk } from '../lib/desks';
import SectionFrame, { asHref } from './SectionFrame';
import Desktop from './Desktop';

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
        st.getState().setSnapping(snapZoneAt(ev.clientX - box.left, ev.clientY - box.top, {
          w: box.width, h: box.height,
        }));
      }
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      const zone = st.getState().snapping;
      if (!edge && zone) st.getState().applySnap(win.id, zone);
      else st.getState().setSnapping(null);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  const btn = 'w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-colors';

  return (
    <div
      role="dialog"
      aria-label={title}
      data-win={win.id}
      onPointerDownCapture={() => { if (!isTop) st.getState().focus(win.id); }}
      style={{
        left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 10 + win.z,
        display: win.minimized || hidden ? 'none' : undefined,
      }}
      className={`absolute flex flex-col rounded-xl overflow-hidden bg-white dark:bg-dark-bg border transition-shadow ${
        peeked
          ? 'border-emerald-500 shadow-2xl ring-2 ring-emerald-500/40'
          : isTop
            ? 'border-emerald-500/70 shadow-2xl'
            : 'border-slate-200 dark:border-dark-border shadow-lg'
      }`}
    >
      <div
        onPointerDown={(e) => drag(e, null)}
        onDoubleClick={() => st.getState().maximize(win.id)}
        /* 34 точки: попасть можно, и не жалко экрана при четырёх окнах */
        className={`h-[34px] shrink-0 flex items-center gap-2 px-2.5 select-none cursor-grab active:cursor-grabbing
                    border-b border-slate-200 dark:border-dark-border ${
          isTop ? 'bg-emerald-50 dark:bg-emerald-950/40' : 'bg-slate-50 dark:bg-dark-surface'
        }`}
      >
        {Icon && <Icon className={`w-4 h-4 shrink-0 ${isTop ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'}`} />}
        <span className="flex-1 min-w-0 truncate text-xs font-semibold text-slate-800 dark:text-slate-150"
          title={title === def.title ? title : `${title} · ${def.title}`}>{title}</span>
        <button type="button" title="Свернуть" aria-label="Свернуть"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => st.getState().minimize(win.id)}
          className={`${btn} text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-850`}>
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
          className={`${btn} text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-850`}>
          {win.maximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3 h-3" />}
        </button>
        <button type="button" title="Закрыть" aria-label="Закрыть"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => st.getState().close(win.id)}
          className={`${btn} text-slate-500 hover:bg-rose-600 hover:text-white`}>
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
  const windows = useWindowStore((s) => s.windows);
  const snapping = useWindowStore((s) => s.snapping);
  const area = useWindowStore((s) => s.area);
  const desk = useWindowStore((s) => s.desk);
  const setArea = useWindowStore((s) => s.setArea);
  const location = useLocation();
  const navigate = useNavigate();
  const deskRef = React.useRef<HTMLDivElement>(null);

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
    navigate(remembered || topWin.href);
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
  }, [location]);

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
      if (act === 'closeWindow') { if (cur) st.close(cur.id); return; }
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
  const [snap, setSnap] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const [shareHint, setShareHint] = React.useState<Share | null>(null);
  const [assist, setAssist] = React.useState<{ shares: Share[]; skip: string[] } | null>(null);
  const snapTimer = React.useRef<any>(null);

  const openSnap = React.useCallback((id: string, el: HTMLElement) => {
    const desk = deskRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!desk) return;
    const st = useWindowStore.getState();
    const count = layoutsFor(st.area).length;
    if (!count) return; // столу тесно — предлагать нечего, и панель не открываем
    const spot = panelSpot(
      { x: r.left - desk.left, y: r.top - desk.top, h: r.height },
      { w: PANEL_W, h: panelHeight(count) },
      st.area,
    );
    setSnap({ id, ...spot });
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

  /** Выбрали долю: ставим окно и предлагаем занять оставшиеся */
  const pickShare = React.useCallback((layout: Layout, index: number) => {
    const id = snap?.id;
    closeSnap();
    if (!id) return;
    const st = useWindowStore.getState();
    st.putInShare(id, layout.shares[index]);
    const rest = otherShares(layout, index);
    // Занимать нечем — предлагать нечего: одно окно на столе это не раскладка
    const others = st.windows.filter((w) => w.id !== id && w.desk === st.desk);
    setAssist(others.length && rest.length ? { shares: rest, skip: [id] } : null);
  }, [snap, closeSnap]);

  /**
   * Соседний стол. Ctrl+Alt+стрелка — то же сочетание, что в системе; окна
   * при этом не двигаются, меняется только то, какой набор показан.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.altKey) || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const st = useWindowStore.getState();
      if (st.desks.length < 2) return;
      e.preventDefault();
      st.goToDesk(stepDesk(st.desk, e.key === 'ArrowRight' ? 1 : -1, st.desks.length));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      className="relative w-full h-full overflow-hidden bg-slate-100 dark:bg-dark-bg"
    >
      {/* Значки живут под окнами: стол — это фон, а не ещё одно окно */}
      <Desktop />

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
        <div aria-hidden style={shareStyle(shareHint, area)}
          className="absolute z-[59] rounded-xl border-2 border-emerald-500 bg-emerald-500/10 pointer-events-none" />
      )}

      {snap && (
        <SnapPanel
          area={area}
          x={snap.x}
          y={snap.y}
          onPick={pickShare}
          onHover={setShareHint}
          onClose={closeSnap}
        />
      )}

      {assist && (
        <SnapAssist shares={assist.shares} skip={assist.skip} onClose={() => setAssist(null)} />
      )}

      {/* Куда встанет окно, если отпустить: показываем до того, как отпустили */}
      {snapping && (
        <div
          aria-hidden
          style={
            snapping === 'top' ? { left: 0, top: 0, right: 0, bottom: 0 }
              : snapping === 'left' ? { left: 0, top: 0, bottom: 0, width: '50%' }
                : { right: 0, top: 0, bottom: 0, width: '50%' }
          }
          className="absolute z-[9] rounded-xl border-2 border-emerald-500 bg-emerald-500/10 pointer-events-none"
        />
      )}
    </div>
  );
}
