import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Equipment from '../../../src/screens/Equipment';
import { PaneContext } from '../../../src/lib/paneTitle';
import { useStore } from '../../../src/store/store';
import './fixture.css';

const projectId = 'equipment-panel-fixture';
useStore.setState({
  user: { id: 'equipment-panel-reviewer', name: 'Просмотр концепта', symbol: 'ПР', role: 'ADMIN' } as any,
  activeProject: { id: projectId, name: '3700-B01-AS-001A' } as any,
});

function Fixture() {
  return <MemoryRouter initialEntries={['/equipment']}><PaneContext.Provider value="win:equipment-panel-preview">
    <div className="flex h-full min-h-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <div className="min-h-0 flex-1"><Equipment /></div>
    </div>
  </PaneContext.Provider></MemoryRouter>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
