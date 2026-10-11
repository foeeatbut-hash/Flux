import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FluxGuide from '../../../src/screens/FluxGuide';
import { useStore } from '../../../src/store/store';
import { useGuideStore } from '../../../src/guide/store';
import './fixture.css';

const project = { id: 'fixture-project', name: 'Проект демонстрационный' };
useStore.setState({ user: { id: 'fixture-user', name: 'Тест', role: 'user', symbol: 'T' }, activeProject: project });
useGuideStore.setState({ mode: 'questions', projectId: project.id, projectName: project.name, projects: [project], messages: [], chatId: null, lastResult: null });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/projects')) return Response.json({ projects: [project] });
  if (url.includes('/chats')) return Response.json({ chats: [] });
  if (url.includes('/components?')) return Response.json({ total: 3, items: [
    { id: 'c1', name: 'Вентилятор В-2', itemCode: 'F-02', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П2', systemCategory: 'AHU', monoblockName: 'МБ-2', status: 'ordered', hasConflict: false, tags: [{ id: 't2', identifier: 'FAN-002' }], specs: [], specsTotal: 0 },
    { id: 'c2', name: 'Вентилятор В-10', itemCode: 'F-10', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П1', systemCategory: 'AHU', monoblockName: 'МБ-1', status: 'added', hasConflict: false, tags: [], specs: [], specsTotal: 0 },
    { id: 'c3', name: 'Вентилятор В-1', itemCode: 'F-01', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П1', systemCategory: 'AHU', monoblockName: 'МБ-1', status: 'added', hasConflict: false, tags: [{ id: 't1', identifier: 'FAN-001' }], specs: [], specsTotal: 0 },
  ] });
  if (url.includes('/guide/chats/')) return Response.json({ chat: { id: 'fixture-chat', projectId: project.id, title: 'Демонстрация', messages: [] } });
  return Response.json({});
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <div className="h-screen min-h-0 bg-white text-slate-900 dark:bg-slate-950 dark:text-white">
    <MemoryRouter initialEntries={[`/guide${window.location.search || '?tab=questions'}`]}>
      <Routes><Route path="/guide" element={<FluxGuide />} /></Routes>
    </MemoryRouter>
  </div>,
);
