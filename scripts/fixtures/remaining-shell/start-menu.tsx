import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import '../../..//src/index.css';
import StartMenu from '../../../src/components/StartMenu';
import { useStore } from '../../../src/store/store';
import { useDesktopStore } from '../../../src/store/desktopStore';
import { usePolicyStore } from '../../../src/store/policyStore';
import { useWindowStore } from '../../../src/store/windowStore';

useStore.setState({ user: { id: 'shell-fixture', name: 'Проверочный сотрудник', symbol: 'SHELL-1', role: 'ADMIN' }, theme: 'light' });
useDesktopStore.setState({ apps: [], bar: [], groups: [] });
usePolicyStore.setState({ platform: { enabled: true, supported: true, maintenance: false, version: 1, note: '' }, permissions: null, rolePermissions: null, loaded: true });

function Page() {
  const [open, setOpen] = React.useState(false);
  const location = useLocation();
  return <main className="min-h-screen bg-slate-100 p-3">
    <button className="fx-btn" onClick={() => setOpen(true)}>Открыть Пуск</button>
    <button className="fx-btn" onClick={() => { useWindowStore.getState().setArea({ w: 1280, h: 720 }); }}>Задать область</button>
    <output data-testid="route">{location.pathname}</output>
    <output data-testid="desk-apps">{useDesktopStore(s => s.apps).join(',')}</output>
    <output data-testid="bar-apps">{useDesktopStore(s => s.bar).join(',')}</output>
    <output data-testid="windows">{useWindowStore(s => s.windows).map(w => w.path).join(',')}</output>
    {open && <StartMenu onClose={() => setOpen(false)} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Page /></BrowserRouter>);
