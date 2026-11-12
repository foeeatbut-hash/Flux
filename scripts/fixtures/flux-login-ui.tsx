import React from 'react';
import { createRoot } from 'react-dom/client';
import Login from '../../src/screens/Login';
import '../../src/index.css';

// Настоящий экран входа Flux без сервера: нужен для снимков и замеров «до/после» (scripts/test-unified-login-ui.ts)
if (new URLSearchParams(location.search).has('electron')) {
  (window as any).electron = { ipcRenderer: { invoke: async () => ({ ok: true, canceled: true }) } };
}
const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
try { localStorage.setItem('theme', theme); } catch { /* приватный режим */ }
document.documentElement.classList.toggle('dark', theme === 'dark');
createRoot(document.getElementById('mount')!).render(<Login />);
