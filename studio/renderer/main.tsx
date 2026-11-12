/**
 * Окно Flux Studio: подключение к базе, вход (логин и пароль или ключ владельца), рабочая область.
 *
 * Вид и экраны входа — те же компоненты, что у Flux (src/components/auth, src/components/window): окно
 * ничего не решает про права, оно показывает то, что ответил сервер. Мост window.studio отдаёт предзагрузка
 * (studio/shell/preload.ts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import FloatingFrame from '../../src/components/window/FloatingFrame';
import { type Snapshot } from './call';
import { useTheme } from './theme';
import ConnectScreen from './auth/ConnectScreen';
import LoginScreen from './auth/LoginScreen';
import Workspace from './Workspace';

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const { theme, toggleTheme } = useTheme();
  useEffect(() => window.studio.onState(setState), []);
  useEffect(() => { void window.studio.call<Snapshot>('state').then(r => { if (r.ok) setState(r.value); else setError(r.error); }); }, []);
  // Заставка из index.html гаснет, когда окно получило первое состояние (как во Flux — когда ответил сервер)
  useEffect(() => { if (state || error) window.__bootSplashDone?.(false); }, [!!state, !!error]);
  const disconnect = useCallback(async () => { const r = await window.studio.call<Snapshot>('disconnect'); if (r.ok) setState(r.value); }, []);
  const name = state?.name || 'Flux Studio';
  return (
    <div className="w-full h-screen flex flex-col overflow-hidden font-sans">
      <FloatingFrame label={name} ariaLabel={`Управление окном ${name}`} closeTitle={`Закрыть ${name}`} getLane={() => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })} />
      <div className="flex-1 min-h-0 overflow-auto">
        {!state && <p className="p-6 fx-hint" role={error ? 'alert' : undefined}>{error || 'Загрузка…'}</p>}
        {state && !state.connected && <ConnectScreen state={state} onDone={setState} theme={theme} onToggleTheme={toggleTheme} />}
        {state && state.connected && !state.user && <LoginScreen state={state} onDone={setState} onBack={disconnect} theme={theme} onToggleTheme={toggleTheme} />}
        {state && state.connected && state.user && <Workspace state={state} onState={setState} theme={theme} onToggleTheme={toggleTheme} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
