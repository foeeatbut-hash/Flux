import React from 'react';
import { createRoot } from 'react-dom/client';
import OwnerLogin from '../../src/components/OwnerLogin';
import '../../src/index.css';

if (new URLSearchParams(location.search).has('electron')) {
  (window as any).electron = { ipcRenderer: { invoke: async () => ({ ok: true, canceled: true }) } };
}

const root = createRoot(document.getElementById('mount')!);
root.render(<OwnerLogin />);
(window as any).__unmountOwnerLogin = () => root.unmount();
