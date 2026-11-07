import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProblemPanel from '../src/components/feedback/ProblemPanel';
import ModuleFeedbackActions from '../src/components/feedback/ModuleFeedbackActions';
import { useStore } from '../src/store/store';
import { useWindowStore } from '../src/store/windowStore';
import { useModuleStore } from '../src/store/moduleStoreState';
import { openProblemPanel } from '../src/feedback/problemPanel';
import '../src/index.css';

useStore.setState({ user: { id: 'fixture-user', name: 'Анна', isActive: true } as any });
useModuleStore.setState({ local: { ok: true, userId: 'fixture-user', channels: ['test'], installed: {}, available: [], fallbacks: {}, runnable: [{ version: '1.1.0', channel: 'test', author: 'Автор', manifest: { id: 'calc-one', name: 'Расчёт', version: '1.0.0', contractVersion: 1, author: 'Автор', entries: [], reads: [], logic: '' } }] } });
useWindowStore.setState({ desk: 0, windows: [{ id: 'fixture-window', path: '/module/calc-one', href: '/module/calc-one', desk: 0, z: 1, minimized: false, maximized: false, restore: null, x: 0, y: 0, w: 500, h: 400 }] });
function Fixture() {
  const [running, setRunning] = useState('1.0.0');
  const [revision, setRevision] = useState(3);
  return <div className="p-4 text-slate-800 dark:text-slate-100"><button className="fx-btn" onClick={() => openProblemPanel()}>Открыть панель</button>
    <div data-win="fixture-window"><div data-running-module="calc-one" data-running-version={running} data-running-channel="test" data-running-api="1" data-running-developer="Автор" data-running-name="Расчёт" /></div>
    <button className="fx-btn" onClick={() => setRunning('1.1.0')}>Перезапустить</button>
    <ModuleFeedbackActions card={{ id: 'report-1', number: 1, title: 'Проблема', description: '', type: 'BUG', status: 'NEW', revision, authorId: 'a', createdAt: new Date().toISOString(), moduleId: 'calc-one' }} onChanged={async () => setRevision((n) => n + 1)} />
    <ProblemPanel /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
