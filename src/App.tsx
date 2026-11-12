/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import LinkLockSync from './components/explorer/LinkLockSync';
import React, { Suspense, lazy } from 'react';
import { HashRouter as Router, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from './store/store';
import Layout from './components/Layout';
import Login from './screens/Login';

// Стикер открывается отдельным окном Electron — вне рабочего стола
const StickerWindow = lazy(() => import('./screens/StickerWindow'));
const CapturePult = lazy(() => import('./screens/CapturePult'));
const NativeAppHost = lazy(() => import('./components/NativeAppHost'));

import { SocketProvider } from './components/SocketProvider';
import { ServerGate } from './components/BootSplash';
import LicenseGate from './screens/LicenseGate';
import ProblemPanel from './components/feedback/ProblemPanel';
import DeveloperContact from './components/DeveloperContact';
import FloatingFrame from './components/window/FloatingFrame';
import AutomaticIncidentWatcher from './components/feedback/AutomaticIncidentWatcher';
import TagNavigationPanel from './components/TagNavigationPanel';
import { useProblemPanel, openProblemPanel, closeProblemPanel } from './feedback/problemPanel';
import GuideSpotlight from './components/guide/GuideSpotlight';
import { useGuideStore } from './guide/store';
import { Bug } from 'lucide-react';
import { useWindowStore } from './store/windowStore';
import { useDisplayStore } from './store/displayStore';
import { mayClose } from './lib/closeGuard';
import OwnedFileShareSync from './components/explorer/OwnedFileShareSync';
import StoreSync from './components/store/StoreSync';
import { ENV_CONFIG } from './config/env';
import { syncEntityIdMigrationHistory } from './lib/entityIdLocalMigration';

/** Перечитывает журнал сервера, чтобы локальные ссылки на проекты обновлялись на всех компьютерах. */
function EntityIdMigrationSync() {
  const userId = useStore((state) => state.user?.id);
  React.useEffect(() => {
    if (!userId) return;
    return syncEntityIdMigrationHistory(ENV_CONFIG.apiUrl);
  }, [userId]);
  return null;
}

function ScreenLoader() {
  return (
    <div className="w-full h-full flex items-center justify-center py-24">
      <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
    </div>
  );
}

/** Рамка окна Flux: вид и поведение общие с Flux Studio (components/window/FloatingFrame), здесь — то, что знает только Flux. */
function ElectronTitleBar() {
  const displayWorkspace = useDisplayStore(s => s.workspace);
  const displays = useWindowStore(s => s.displays);
  const activeDisplayId = useWindowStore(s => s.activeDisplayId);
  const monitor = displayWorkspace.enabled ? displays.find(d => d.id === activeDisplayId) || displays.find(d => d.primary) || displays[0] : null;
  const getLane = () => monitor?.workArea || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const location = useLocation();
  // Журнал переехал сюда из круглой нашлёпки у правого края: она висела поверх
  // содержимого, закрывала его углом и жила отдельно от всего остального
  // управления программой
  const problemOpen = useProblemPanel((s) => s.open);
  const reportBtn = React.useRef<HTMLButtonElement>(null);
  return (
    <FloatingFrame
      label="Flux" ariaLabel="Управление окном Flux" closeTitle="Закрыть Flux" getLane={getLane} forceVisible={problemOpen}
      hidden={location.pathname === '/sticker' || location.pathname === '/capture' || location.pathname === '/native-app'}
      extra={({ btn, btnBox, noDrag }) => (
        <>
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
            data-problem-toggle
            style={{ ...noDrag, ...btnBox }}
            className={`${btn} relative rounded-lg ${problemOpen ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
          >
            <Bug className="w-3.5 h-3.5" />
          </button>
          <DeveloperContact buttonClassName={btn} buttonStyle={{ ...noDrag, ...btnBox }} />
        </>
      )}
    />
  );
}


function AnimatedRoutes() {
  const user = useStore((state) => state.user);
  const location = useLocation();
  const navigate = useNavigate();

  // Flux Guide получает навигатор, профиль и активный проект от оболочки.
  React.useLayoutEffect(() => {
    const g = useGuideStore.getState();
    g.setNavigator((path: string) => navigate(path));
    g.setUserGetter(() => useStore.getState().user ? { id: useStore.getState().user!.id, name: useStore.getState().user!.name } : null);
    g.setActiveProjectGetter(() => {
      const p = useStore.getState().activeProject;
      return p ? { id: p.id, name: p.name } : null;
    });
  }, [navigate, user?.id]);

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

  // The saved window layout is authoritative: a stale last route could reopen
  // a closed editor or restore a deliberately minimized window after login.
  React.useEffect(() => {
    if (!user && location.pathname !== '/') navigate('/', { replace: true });
  }, [user?.id]);

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
  if (location.pathname === '/native-app') {
    return <Suspense fallback={<ScreenLoader />}><NativeAppHost /></Suspense>;
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
  React.useEffect(() => {
    const controls = (window as any).electron?.windowControls;
    if (!controls?.onCloseRequest) return;
    return controls.onCloseRequest(async (token: string) => {
      let allowed = true;
      for (const entry of useWindowStore.getState().windows) {
        if (!await mayClose(entry.id)) { allowed = false; break; }
      }
      try { await controls.closeConfirm(token, allowed); } catch { /* Сохранение остаётся в открытом окне. */ }
    });
  }, []);
  return (
    <Router>
      <SocketProvider>
        <div className="w-full h-screen flex flex-col overflow-hidden">
          <ElectronTitleBar />
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {/* Пока встроенный сервер поднимается — анимированная заставка вместо пустого экрана */}
            <ServerGate>
              <LicenseGate>
                <EntityIdMigrationSync />
                <LinkLockSync />
                <AnimatedRoutes />
                <TagNavigationPanel />
                <AutomaticIncidentWatcher />
                <OwnedFileShareSync />
                <StoreSync />
              </LicenseGate>
            </ServerGate>
          </div>
        </div>
        <ProblemPanel />
        <GuideSpotlight />
      </SocketProvider>
    </Router>
  );
}
