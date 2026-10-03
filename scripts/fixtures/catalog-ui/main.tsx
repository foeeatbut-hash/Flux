import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import CatalogScreen from '../../../src/screens/CatalogScreen';
import BuilderScreen from '../../../src/screens/BuilderScreen';
import { PaneContext } from '../../../src/lib/paneTitle';
import { useStore } from '../../../src/store/store';
import './fixture.css';

declare global { interface Window { __setActor?: (role: 'reader'|'owner') => void; __setEmpty?: (value: boolean) => void; __catalogFixtureRole?: 'reader'|'owner'; __catalogFixtureEmpty?: boolean; __catalogFixtureRemote?: boolean; __catalogPolicyWrites?: number } }
const setActor = (role: 'reader'|'owner') => useStore.setState({ user: { id: 'ui-fixture-user', name: 'Проверка интерфейса', symbol: 'UI', role: role === 'owner' ? 'OWNER' : 'ENGINEER_VENT', permissions: { 'builder.edit': true } } as any, activeProject: { id: 'catalog-ui-project', name: 'Пробный проект' } as any });
setActor('reader');
function Fixture() {
  const [screen, setScreen] = useState<'catalog'|'builder'>('catalog');
  const [screenKey, setScreenKey] = useState(0);
  const [actor, setActorState] = useState<'reader'|'owner'>('reader');
  const switchActor = (value: 'reader'|'owner') => { window.__catalogFixtureRole = value; setActor(value); setActorState(value); setScreen('catalog'); setScreenKey((key) => key + 1); };
  window.__catalogFixtureRole = actor;
  window.__setEmpty = (value) => { window.__catalogFixtureEmpty = value; setScreenKey((key) => key + 1); };
  window.__setActor = switchActor;
  return <MemoryRouter initialEntries={['/catalog']}><PaneContext.Provider value="win:catalog-ui-fixture">
    <div className="h-full min-h-0 flex flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <nav aria-label="Проверка экранов" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
        <button className="fx-btn fx-btn-sm" aria-pressed={screen==='catalog'} onClick={()=>setScreen('catalog')}>Каталог</button>
        <button className="fx-btn fx-btn-sm" aria-pressed={screen==='builder'} onClick={()=>setScreen('builder')}>Конструктор</button>
        <span className="flex-1"/><button className="fx-btn fx-btn-sm" onClick={()=>switchActor('reader')}>Читатель</button>
        <button className="fx-btn fx-btn-sm" onClick={()=>switchActor('owner')}>Владелец</button>
      </nav>
      <main className="min-h-0 flex-1 p-2">{screen==='catalog' ? <CatalogScreen key={screenKey}/> : <BuilderScreen/>}</main>
    </div>
  </PaneContext.Provider></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
