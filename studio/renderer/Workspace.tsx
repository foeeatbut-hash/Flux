import React, { useState } from 'react';
import { Boxes, FilePen, FolderCode, LogOut, ShieldCheck, Send, Bug, KeyRound, Moon, Sun } from 'lucide-react';
import { type Snapshot } from './call';
import Modules from './Modules';
import Projects from './sections/Projects';
import Editor from './sections/Editor';
import Check from './sections/Check';
import Publish from './sections/Publish';
import Errors from './sections/Errors';

/**
 * Рабочая область после входа: слева список разделов (боковая панель Flux, пункты fx-li), справа раздел.
 * Права и данные решает сервер и главный процесс; окно показывает их ответы.
 */
const NAV: Array<[string, string, React.ReactNode]> = [
  ['modules', 'Подпрограммы', <Boxes key="m" />], ['project', 'Проект подпрограммы', <FolderCode key="p" />], ['editor', 'Редактор', <FilePen key="e" />],
  ['check', 'Проверка перед отправкой', <ShieldCheck key="c" />], ['publish', 'Публикация', <Send key="s" />], ['errors', 'Ошибки', <Bug key="b" />],
];

export default function Workspace({ state, onState, theme, onToggleTheme }: { state: Snapshot; onState: (s: Snapshot) => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [error, setError] = useState('');
  const [section, setSection] = useState('modules');
  // Открытый проект общий для разделов: редактор, проверка и публикация работают с ним
  const [current, setCurrent] = useState('');
  const open = async (id: string) => { const reply = await window.studio.call('openSection', { id }); setError(reply.ok ? '' : reply.error); };
  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100">
      <nav className="fx-side w-60 shrink-0 flex flex-col gap-0.5 p-2" aria-label="Разделы Studio">
        <div className="fx-gh">{state.name}<span className="fx-n ml-auto data">{state.version}</span></div>
        {NAV.map(([id, title, icon]) => <button key={id} type="button" className="fx-li" aria-current={section === id ? 'true' : undefined} onClick={() => setSection(id)}>{icon}{title}</button>)}
        {current && <p className="fx-note px-2" title="Открытый проект">Проект: <span className="code">{current}</span></p>}
        {state.sections.length > 0 && <div className="fx-gh mt-2">Управление</div>}
        {state.sections.map(item => <button key={item.id} type="button" className="fx-li" onClick={() => void open(item.id)}><KeyRound />{item.title}</button>)}
        <div className="flex-1" />
        <div className="fx-note px-2 truncate" title={state.display}>{state.user?.name || state.user?.id}</div>
        <button type="button" className="fx-li" onClick={onToggleTheme} aria-label="Переключить тему">{theme === 'dark' ? <Sun /> : <Moon />}{theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}</button>
        <button type="button" className="fx-li" onClick={async () => { const reply = await window.studio.call<Snapshot>('logout'); if (reply.ok) onState(reply.value); }}><LogOut />Выйти</button>
      </nav>
      <main className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
        {state.warning && <p className="fx-note fx-note-warn px-4" role="status" data-testid="outdated">{state.warning}</p>}
        {error && <p className="fx-error px-4 py-2" role="alert">{error}</p>}
        <div className="flex-1 min-h-0">
          {section === 'modules' && <Modules />}
          {section === 'project' && <Projects current={current} onOpen={setCurrent} />}
          {section === 'editor' && <Editor id={current} />}
          {section === 'check' && <Check id={current} onGo={setSection} />}
          {section === 'publish' && <Publish id={current} onGo={setSection} onOpen={setCurrent} />}
          {section === 'errors' && <Errors />}
        </div>
      </main>
    </div>
  );
}
