import React, { useState } from 'react';
import { Boxes, KeyRound, LogOut, Moon, Sun } from 'lucide-react';
import { type Snapshot } from './call';
import Home from './work/Home';
import ProjectWindow from './work/ProjectWindow';
import { useKey } from './work/useKey';

/**
 * Рабочая область после входа: одно окно, как в Visual Studio. Стартовый экран — «Мои программы»; открытая программа —
 * рабочее окно проекта (дерево файлов, вкладки, «Запустить / Проверить / Опубликовать», нижняя панель).
 * Права и данные решает сервер и главный процесс; окно показывает их ответы. Ключ разработчика создаётся при первом входе сам.
 */
export default function Workspace({ state, onState, theme, onToggleTheme }: { state: Snapshot; onState: (s: Snapshot) => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [error, setError] = useState('');
  const [current, setCurrent] = useState('');
  const keyState = useKey();
  const open = async (id: string) => { const reply = await window.studio.call('openSection', { id }); setError(reply.ok ? '' : reply.error); };
  return (
    <div className="studio-work flex h-full min-h-0 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100">
      <nav className="fx-side w-56 shrink-0 flex flex-col gap-0.5 p-2" aria-label="Flux Studio">
        <div className="fx-gh">{state.name}<span className="fx-n ml-auto data">{state.version}</span></div>
        <button type="button" className="fx-li" aria-current={!current ? 'true' : undefined} onClick={() => setCurrent('')}><Boxes />Мои программы</button>
        {state.owner && state.sections.length > 0 && <div className="fx-gh mt-2">Владелец</div>}
        {state.owner && state.sections.map(item => <button key={item.id} type="button" className="fx-li" onClick={() => void open(item.id)}><KeyRound />{item.title}</button>)}
        <div className="flex-1" />
        <div className="fx-note px-2 truncate" title={state.display}>{state.user?.name || state.user?.id}</div>
        <button type="button" className="fx-li" onClick={onToggleTheme} aria-label="Переключить тему">{theme === 'dark' ? <Sun /> : <Moon />}{theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}</button>
        <button type="button" className="fx-li" onClick={async () => { const reply = await window.studio.call<Snapshot>('logout'); if (reply.ok) onState(reply.value); }}><LogOut />Выйти</button>
      </nav>
      <main className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
        {state.warning && <p className="fx-note fx-note-warn px-4" role="status" data-testid="outdated">{state.warning}</p>}
        {error && <p className="fx-error px-4 py-2" role="alert">{error}</p>}
        <div className="flex-1 min-h-0">
          {current ? <ProjectWindow key={current} id={current} onBack={() => setCurrent('')} keyState={keyState} /> : <Home onOpen={setCurrent} />}
        </div>
      </main>
    </div>
  );
}
