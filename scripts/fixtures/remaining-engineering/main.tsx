import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Registry from '../../../src/screens/Registry';
import ModalProvider from '../../../src/components/ModalProvider';
import { PaneContext } from '../../../src/lib/paneTitle';
import { useStore } from '../../../src/store/store';
import './fixture.css';

useStore.setState({
  user: { id: 'remaining-eng-user', name: 'Синтетический инженер', symbol: 'TEST', role: 'ADMIN', permissions: {} } as any,
  activeProject: { id: 'remaining-eng-project', name: 'Синтетический инженерный проект', status: 'active' } as any,
  theme: 'light',
});

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/registry']}>
    <PaneContext.Provider value="win:remaining-engineering-registry">
      <div className="flex h-full min-h-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
        <Registry />
      </div>
      <ModalProvider />
    </PaneContext.Provider>
  </MemoryRouter>,
);
