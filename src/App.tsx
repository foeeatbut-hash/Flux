/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy } from 'react';
import { HashRouter as Router, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from './store/store';
import Layout from './components/Layout';
import Login from './screens/Login';

// Стикер открывается отдельным окном Electron — вне рабочего стола
const StickerWindow = lazy(() => import('./screens/StickerWindow'));
const CapturePult = lazy(() => import('./screens/CapturePult'));

import { SocketProvider } from './components/SocketProvider';
import { ServerGate } from './components/BootSplash';
import LicenseGate from './screens/LicenseGate';
import ProblemPanel from './components/feedback/ProblemPanel';
import { useProblemPanel, openProblemPanel, closeProblemPanel } from './feedback/problemPanel';
import AssistantSpotlight from './components/AssistantSpotlight';
import { setAssistantNavigator, setAssistantProjectGetter, setAssistantSceneGetter, useAssistantStore } from './store/assistantStore';
import { Z } from './lib/layers';
import { FRAME_W, FRAME_H, FRAME_GRIP, FRAME_BTN, FRAME_LABEL, FRAME_LURE } from './lib/metrics';
import { Bug } from 'lucide-react';
import { useWindowStore } from './store/windowStore';
import { SECTIONS } from './workspace/sections';

function ScreenLoader() {
  return (
    <div className="w-full h-full flex items-center justify-center py-24">
      <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
    </div>
  );
}

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
function ElectronTitleBar() {
  const location = useLocation();
  const isElectron = typeof window !== 'undefined' && !!(window as any).electron;
  const wc = isElectron ? (window as any).electron?.windowControls : null;
  // Журнал переехал сюда из круглой нашлёпки у правого края: она висела поверх
  // содержимого, закрывала его углом и жила отдельно от всего остального
  // управления программой
  const problemOpen = useProblemPanel((s) => s.open);
  const reportBtn = React.useRef<HTMLButtonElement>(null);
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
    wc.isMaximized?.().then((v: boolean) => setMaximized(!!v)).catch(() => {});
    const off = wc.onMaximizedChange?.((v: boolean) => setMaximized(!!v));
    return () => { off && off(); };
  }, [wc]);

  // Всплывает от близости курсора к верхней кромке. Полторы секунды на уход —
  // столько же, сколько у удалённого стола: за меньшее панелька успевает
  // исчезнуть из-под руки, тянущейся к её кнопке
  React.useEffect(() => {
    if (!isElectron) return;
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= FRAME_LURE) {
        clearTimeout(hideTimer.current);
        setNear(true);
        return;
      }
      if (e.clientY > 64) {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setNear(false), 1500);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(hideTimer.current); };
  }, [isElectron]);

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
  if (location.pathname === '/sticker' || location.pathname === '/capture') return null;

  // В браузере кнопок окна нет — окном распоряжается браузер. Панелька при
  // этом остаётся: журнал нужен и там, а другого места у него больше нет
  const WIDTH = isElectron ? FRAME_W : FRAME_W - FRAME_BTN * 3;
  const left = Math.round(
    x === null ? Math.max(8, (window.innerWidth - WIDTH) / 2) : Math.min(Math.max(8, x), Math.max(8, window.innerWidth - WIDTH - 8)),
  );
  const visible = pinned || near;

  // Панельку тянут за насечку слева — вдоль верхнего края. Само окно двигают
  // за её середину: это область перетаскивания окна (WebkitAppRegion)
  const startSlide = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - left;
    const onMove = (ev: PointerEvent) => setX(ev.clientX - dx);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const next = ev.clientX - dx;
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
        style={{ zIndex: Z.frame, left, width: WIDTH, height: FRAME_LURE }}
        className="fixed top-0"
      />

      <div
        role="toolbar"
        aria-label="Управление окном Flux"
        style={{
          zIndex: Z.frame,
          left,
          top: visible ? 6 : -(FRAME_H + 8),
          width: WIDTH,
          height: FRAME_H,
          transition: 'top 160ms ease',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        onMouseEnter={() => { clearTimeout(hideTimer.current); setNear(true); }}
        onDoubleClick={() => wc?.maximize?.()}
        className="fixed flex items-center gap-0.5 pl-1 pr-1 rounded-xl select-none
                   bg-slate-900/95 border border-slate-700 shadow-2xl backdrop-blur-sm"
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
        <span style={{ width: FRAME_LABEL }} className="text-2xs font-bold text-slate-400 text-center tracking-wide">Flux</span>
        <span className="flex-1" />

        <div className="flex items-center" style={noDrag}>
          {/* Единственная дверь к сообщению о сбое. Раньше эта же кнопка
              открывала журнал с фильтрами и складывала его текст в чат-канал
              «Ошибки» — обращение жило там обычной репликой, без номера и без
              ответа. Панель выдвигается отсюда, поэтому кнопка отдаёт свой
              прямоугольник: панель встаёт под ней, а не посреди экрана */}
          <button
            type="button"
            ref={reportBtn}
            onClick={() => {
              if (problemOpen) { closeProblemPanel(); return; }
              const rect = reportBtn.current?.getBoundingClientRect();
              openProblemPanel(
                { sectionKey: window.location.hash.replace(/^#/, '') },
                rect ? { top: Math.round(rect.bottom + 6), right: Math.round(window.innerWidth - rect.right) } : undefined,
              );
            }}
            title="Сообщить о проблеме"
            aria-label="Сообщить о проблеме"
            aria-expanded={problemOpen}
            style={{ ...noDrag, ...btnBox }}
            className={`${btn} relative rounded-lg ${problemOpen ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
          >
            <Bug className="w-3.5 h-3.5" />
          </button>
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
              <button type="button" onClick={() => wc?.close?.()} className={`${btn} hover:bg-rose-600 rounded-lg`} title="Закрыть Flux" style={{ ...noDrag, ...btnBox }}>
                <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.2"><line x1="1.5" y1="1.5" x2="9.5" y2="9.5" /><line x1="9.5" y1="1.5" x2="1.5" y2="9.5" /></svg>
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function AnimatedRoutes() {
  const user = useStore((state) => state.user);
  const location = useLocation();
  const navigate = useNavigate();

  // Регистрируем навигатор и доступ к активному проекту для встроенного ассистента
  React.useEffect(() => {
    setAssistantNavigator((path: string) => navigate(path));
    setAssistantProjectGetter(() => useStore.getState().activeProject?.id || null);
    // Обстановку помощнику сообщает оболочка: она одна знает, какие окна
    // открыты и как называются их документы. Если бы помощник читал окна сам,
    // он знал бы про них больше, чем рама, и они разошлись бы (§17.3)
    setAssistantSceneGetter(
      () => {
        const st = useWindowStore.getState();
        return st.windows.map((w) => ({
          path: w.path,
          section: SECTIONS.find((s) => s.path === w.path)?.title || w.path,
          title: st.titles[w.id] || '',
          z: w.z,
          minimized: w.minimized,
        }));
      },
      () => useStore.getState().activeProject?.name || '',
    );
  }, [navigate]);

  // Сообщаем ассистенту текущий раздел (для контекстной встречи и подсказок)
  React.useEffect(() => {
    useAssistantStore.getState().setRoute(location.pathname);
    // и запоминаем как дело: «что я делал» отвечается этим, а не журналом
    const title = SECTIONS.find((s) => s.path === location.pathname)?.title;
    if (title) useAssistantStore.getState().remember(`открыл раздел «${title}»`);
  }, [location.pathname]);

  // Сессия API истекла или профиль отключён (401 от сервера) → на экран входа
  React.useEffect(() => {
    const onExpired = () => {
      if (useStore.getState().user) {
        useStore.getState().setUser(null);
      }
    };
    window.addEventListener('flux:auth-expired', onExpired);
    return () => window.removeEventListener('flux:auth-expired', onExpired);
  }, []);

  // Save the user's active route path when they interact
  React.useEffect(() => {
    if (user && location.pathname !== '/sticker') {
      localStorage.setItem(`pdm_last_path_${user.id}`, location.pathname + location.search);
    }
  }, [location, user]);

  // Restore the user's last visited route on initial load if they are at "/"
  React.useEffect(() => {
    if (user && location.pathname === '/') {
      const lastPath = localStorage.getItem(`pdm_last_path_${user.id}`);
      if (lastPath && lastPath !== '/') {
        navigate(lastPath, { replace: true });
      }
    }
  }, [user]);

  // Окно-стикер открывается отдельным окном Electron: не требуем повторного входа
  if (location.pathname === '/sticker') {
    return (
      <Suspense fallback={<ScreenLoader />}>
        <StickerWindow />
      </Suspense>
    );
  }

  // Пульт захвата — тоже отдельное окно. Данных проекта он не трогает,
  // только следит за буфером, поэтому входа не требует
  if (location.pathname === '/capture') {
    return (
      <Suspense fallback={null}>
        <CapturePult />
      </Suspense>
    );
  }

  if (!user) {
    return <Login />;
  }

  // Разделы держит «живыми» рабочий стол внутри Layout (keep-alive + панели),
  // поэтому здесь один маршрут: Layout сам решает, какой раздел показать по URL.
  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      <Suspense fallback={<ScreenLoader />}>
        <Routes location={location}>
          {/* Standing standalone route outside the layout to prevent Sidebar/Header replication */}
          <Route path="/sticker" element={<StickerWindow />} />
          <Route path="*" element={<Layout />} />
        </Routes>
      </Suspense>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <SocketProvider>
        <div className="w-full h-screen flex flex-col overflow-hidden">
          <ElectronTitleBar />
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {/* Пока встроенный сервер поднимается — анимированная заставка вместо пустого экрана */}
            <ServerGate>
              <LicenseGate>
                <AnimatedRoutes />
              </LicenseGate>
            </ServerGate>
          </div>
        </div>
        <ProblemPanel />
        <AssistantSpotlight />
      </SocketProvider>
    </Router>
  );
}
