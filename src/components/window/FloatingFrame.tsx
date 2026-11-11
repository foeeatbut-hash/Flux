import React from 'react';
import { Z } from '../../lib/layers';
import { FRAME_W, FRAME_H, FRAME_GRIP, FRAME_BTN, FRAME_LABEL, FRAME_LURE } from '../../lib/metrics';

/**
 * Управление окном Flux — подвижная панелька сверху по центру.
 *
 * Раньше это была полоса во всю ширину, и её крестик стоял в правом верхнем
 * углу — там же, где крестик окна программы внутри Flux. Между «закрыть
 * ведомость» и «закрыть Flux с несохранённой ведомостью» было двадцать точек
 * по диагонали, и промах стоил дорого.
 *
 * Теперь панелька висит по центру верхнего края, как у удалённого рабочего
 * стола Windows: всплывает, когда курсор подходит к кромке, и уезжает через
 * полторы секунды после ухода. Её можно приколоть кнопкой и подвинуть вдоль
 * края — место запоминается. Между двумя крестиками теперь весь экран.
 *
 * Полоса больше не занимает высоту: панелька плавает поверх, и разделу
 * достаются те 36 точек, которые она отнимала.
 */
export interface FrameStyles { btn: string; btnBox: React.CSSProperties; noDrag: React.CSSProperties }
export interface FloatingFrameProps {
  /** Подпись посередине панельки: «Flux», «Flux Studio» */
  label: string;
  ariaLabel: string;
  closeTitle: string;
  /** Полоса экрана, в пределах которой панелька ходит (рабочая область монитора); читается при каждой отрисовке, чтобы ширина окна была свежей */
  getLane: () => { x: number; y: number; w: number; h?: number };
  /** Кнопки программы слева от кнопок окна (у Flux — «сообщить о проблеме»); получают размеры кнопок панельки */
  extra?: (styles: FrameStyles) => React.ReactNode;
  /** Панелька остаётся на виду, пока открыто связанное с ней окно (панель обращения) */
  forceVisible?: boolean;
  /** Отдельные окна (стикер, пульт захвата) рисуют себя сами; хуки при этом выполняются как раньше */
  hidden?: boolean;
}

export default function FloatingFrame({ label, ariaLabel, closeTitle, getLane, extra, forceVisible = false, hidden = false }: FloatingFrameProps) {
  const lane = getLane();
  const isElectron = typeof window !== 'undefined' && !!(window as any).electron;
  const wc = isElectron ? (window as any).electron?.windowControls : null;
  const [maximized, setMaximized] = React.useState(false);
  const [near, setNear] = React.useState(false);
  const [pinned, setPinned] = React.useState(() => {
    try { return localStorage.getItem('flux_frame_pin') === '1'; } catch (_) { return false; }
  });
  const [x, setX] = React.useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('flux_frame_x');
      return raw === null ? null : Number(raw);
    } catch (_) { return null; }
  });
  const hideTimer = React.useRef<any>(null);

  React.useEffect(() => {
    if (!wc) return;
    document.documentElement.dataset.fluxElectronWindow = 'true';
    wc.isMaximized?.().then((v: boolean) => setMaximized(!!v)).catch(() => {});
    const off = wc.onMaximizedChange?.((v: boolean) => setMaximized(!!v));
    return () => {
      off && off();
      delete document.documentElement.dataset.fluxElectronWindow;
      delete document.documentElement.dataset.fluxWindowMaximized;
    };
  }, [wc]);
  React.useEffect(() => {
    if (wc) document.documentElement.dataset.fluxWindowMaximized = String(maximized);
  }, [wc, maximized]);

  // Всплывает от близости курсора к верхней кромке. Полторы секунды на уход —
  // столько же, сколько у удалённого стола: за меньшее панелька успевает
  // исчезнуть из-под руки, тянущейся к её кнопке
  React.useEffect(() => {
    if (!isElectron) return;
    const onMove = (e: MouseEvent) => {
      if (e.clientY >= lane.y && e.clientY <= lane.y + FRAME_LURE && e.clientX >= lane.x && e.clientX < lane.x + lane.w) {
        clearTimeout(hideTimer.current);
        setNear(true);
        return;
      }
      if (e.clientY > lane.y + 64 || e.clientX < lane.x || e.clientX > lane.x + lane.w) {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setNear(false), 1500);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(hideTimer.current); };
  }, [isElectron, lane.x, lane.y, lane.w]);

  // Панелька больше не выпрыгивает на каждую внутреннюю ошибку. Раньше она
  // так показывала счётчик — а счётчик показывал человеку то, чего он не
  // просил и с чем ничего не может сделать. О сбое сообщают, когда сбой
  // мешает работать, и решает это человек, а не счётчик
  // Окно стало у́же — панельку надо пересчитать, иначе приколотая уедет за край
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const onResize = () => bump();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Отдельные окна рисуют себя сами: у стикера своя шапка, у пульта захвата
  // её нет вовсе — он и так 306×150 без рамок
  if (hidden) return null;

  // В браузере кнопок окна нет — окном распоряжается браузер. Панелька при
  // этом остаётся: журнал нужен и там, а другого места у него больше нет
  const WIDTH = isElectron ? FRAME_W : FRAME_W - FRAME_BTN * 3;
  const left = Math.round(
    lane.x + (x === null ? Math.max(8, (lane.w - WIDTH) / 2) : Math.min(Math.max(8, x), Math.max(8, lane.w - WIDTH - 8))),
  );
  // Пока открыта панель обращения, верхняя панель остаётся: панель встаёт под её
  // кнопкой, и если бы оболочка уехала вверх через полторы секунды, под
  // обращением остался бы пустой промежуток, а кнопку закрытия было бы не достать
  const visible = pinned || near || forceVisible;

  // Панельку тянут за насечку слева — вдоль верхнего края. Само окно двигают
  // за её середину: это область перетаскивания окна (WebkitAppRegion)
  const startSlide = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - left;
    const onMove = (ev: PointerEvent) => setX(ev.clientX - dx - lane.x);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const next = ev.clientX - dx - lane.x;
      setX(next);
      try { localStorage.setItem('flux_frame_x', String(Math.round(next))); } catch (_) { /* приватный режим */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const flipPin = () => {
    const next = !pinned;
    setPinned(next);
    try { localStorage.setItem('flux_frame_pin', next ? '1' : '0'); } catch (_) { /* приватный режим */ }
  };

  const btn = 'flex items-center justify-center text-slate-300 hover:text-white transition-colors cursor-pointer';
  const btnBox = { width: FRAME_BTN, height: FRAME_H - 8 } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <>
      {/* Полоска-приманка у самой кромки: мышь упирается в край экрана и
          вызывает панельку, не целясь */}
      <div
        aria-hidden
        onMouseEnter={() => { clearTimeout(hideTimer.current); setNear(true); }}
        style={{ zIndex: Z.frame, left, top: lane.y, width: WIDTH, height: FRAME_LURE }}
        className="fixed top-0"
      />

      <div
        role="toolbar"
        aria-label={ariaLabel}
        style={{
          zIndex: Z.frame,
          left,
          top: visible ? lane.y + 6 : lane.y - (FRAME_H + 8),
          visibility: visible ? 'visible' : 'hidden',
          width: WIDTH,
          height: FRAME_H,
          transition: 'top 160ms ease',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        onMouseEnter={() => { clearTimeout(hideTimer.current); setNear(true); }}
        onDoubleClick={() => wc?.maximize?.()}
        className="fixed flex items-center gap-0.5 pl-1 pr-1 rounded-xl select-none
                   bg-slate-900/95 border border-slate-700 shadow-2xl"
      >
        <button
          type="button"
          onPointerDown={startSlide}
          onClick={flipPin}
          title={pinned ? 'Открепить — панелька будет прятаться' : 'Приколоть панельку; потяните, чтобы сдвинуть'}
          aria-label="Приколоть или сдвинуть панельку"
          style={{ ...noDrag, width: FRAME_GRIP, height: FRAME_GRIP }}
          className={`flex items-center justify-center cursor-grab active:cursor-grabbing rounded-lg
                      ${pinned ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.4">
            <line x1="2" y1="4" x2="10" y2="4" /><line x1="2" y1="8" x2="10" y2="8" />
          </svg>
        </button>

        {/* Подпись и растяжка — это и есть область перетаскивания окна: всё
            остальное в панельке помечено `no-drag`. Сколько её останется,
            считает FRAME_DRAG в общей мере, и проверка следит за этим числом:
            иначе новая кнопка тихо съела бы область снова */}
        <span style={{ width: FRAME_LABEL }} className="text-xs font-medium text-slate-400 text-center">{label}</span>
        <span className="flex-1" />

        <div className="flex items-center" style={noDrag}>
          {extra?.({ btn, btnBox, noDrag })}
          {/* Кнопки окна — только в самой программе: в браузере окном
              распоряжается браузер, и три мёртвые кнопки там были бы обманом */}
          {isElectron && (
            <>
              <button type="button" onClick={() => wc?.minimize?.()} className={`${btn} hover:bg-slate-800 rounded-lg`} title="Свернуть" style={{ ...noDrag, ...btnBox }}>
                <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1.1" fill="currentColor" /></svg>
              </button>
              <button type="button" onClick={() => wc?.maximize?.()} className={`${btn} hover:bg-slate-800 rounded-lg`} title={maximized ? 'Восстановить' : 'Развернуть'} style={{ ...noDrag, ...btnBox }}>
                {maximized ? (
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1">
                    <rect x="2.4" y="1.2" width="6.4" height="6.4" rx="1" />
                    <rect x="1.2" y="3.4" width="6.4" height="6.4" rx="1" fill="#0f172a" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1"><rect x="1.4" y="1.4" width="8.2" height="8.2" rx="1.2" /></svg>
                )}
              </button>
              <button type="button" onClick={() => wc?.close?.()} className={`${btn} hover:bg-rose-600 rounded-lg`} title={closeTitle} style={{ ...noDrag, ...btnBox }}>
                <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.2"><line x1="1.5" y1="1.5" x2="9.5" y2="9.5" /><line x1="9.5" y1="1.5" x2="1.5" y2="9.5" /></svg>
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
