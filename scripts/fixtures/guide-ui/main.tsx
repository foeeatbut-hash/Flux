import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FluxGuide from '../../../src/screens/FluxGuide';
import { useStore } from '../../../src/store/store';
import { useGuideStore } from '../../../src/guide/store';
import ModalProvider from '../../../src/components/ModalProvider';
// Заранее оптимизируем библиотеку экспорта: Vite не должен перезагружать фикстуру при первом нажатии.
import 'xlsx';
import './fixture.css';

const project = { id: 'fixture-project', name: 'Проект демонстрационный' };
const otherProject = { id: 'fixture-project-other', name: 'Проект из истории' };
useStore.setState({ user: { id: 'fixture-user', name: 'Тест', role: 'user', symbol: 'T' }, activeProject: project });
useGuideStore.setState({ mode: 'questions', projectId: project.id, projectName: project.name, projects: [project, otherProject], messages: [], chatId: null, lastResult: null });

(window as any).__stageOtherProjectChat = () => {
  const chat = { id: 'fixture-other-chat', projectId: otherProject.id, title: 'Вопрос из другого проекта', preview: 'Сохранённый ответ', updatedAt: '2026-10-11T12:00:00Z' };
  (window as any).__guideHistoryRows = [chat];
  useGuideStore.setState({
  chats: [chat],
  messages: [{ id: 'fixture-unsaved-question', role: 'user', text: 'Текущий черновой вопрос' }],
  chatId: 'fixture-unsaved-chat', chatSaveState: 'saved', draftQuestions: 'Оставить этот черновик',
  });
};
(window as any).__guideHistorySnapshot = () => {
  const state = useGuideStore.getState();
  return { projectId: state.projectId, chatId: state.chatId, messages: state.messages.map((message) => message.text), draftQuestions: state.draftQuestions, chats: state.chats };
};

// Большая выборка проверяет прокрутку настоящего ответа, не меняя серверную фикстуру.
(window as any).__guideLargeTable = () => useGuideStore.setState({ messages: [{
  id: 'large-table', role: 'guide', text: 'Большая выборка', table: {
    title: 'Большая выборка', columns: ['Позиция', 'Код'],
    rows: Array.from({ length: 300 }, (_, index) => [`Позиция ${index + 1}`, `F-${index + 1}`]),
  },
}] });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/office/files/new')) {
    const bytes = init?.body ? Array.from(new Uint8Array(await new Response(init.body).arrayBuffer())) : [];
    const captures = (window as any).__guideExports || ((window as any).__guideExports = []);
    captures.push({ url, bytes });
    return Response.json({ id: `fixture-file-${captures.length}`, name: new URL(url, location.origin).searchParams.get('name') || 'export' });
  }
  if (url.includes('/projects')) return Response.json({ projects: [project, otherProject] });
  if (url.includes('/guide/chats/fixture-other-chat')) return Response.json({ chat: { id: 'fixture-other-chat', projectId: otherProject.id, title: 'Вопрос из другого проекта', messages: [{ id: 'other-q', role: 'user', text: 'Вопрос сохранённого чата', projectId: otherProject.id }, { id: 'other-a', role: 'guide', text: 'Ответ из другого проекта', projectId: otherProject.id }] } });
  if (url.includes('/chats')) return Response.json({ chats: (window as any).__guideHistoryRows || [] });
  if (url.includes('/components?')) return Response.json({ total: 3, items: [
    { id: 'c1', name: 'Вентилятор В-2', itemCode: 'F-02', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П2', systemCategory: 'AHU', monoblockName: 'МБ-2', status: 'ordered', hasConflict: false, tags: [{ id: 't2', identifier: 'FAN-002' }], specs: [], specsTotal: 0 },
    { id: 'c2', name: 'Вентилятор В-10', itemCode: 'F-10', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П1', systemCategory: 'AHU', monoblockName: 'МБ-1', status: 'added', hasConflict: false, tags: [], specs: [], specsTotal: 0 },
    { id: 'c3', name: 'Вентилятор В-1', itemCode: 'F-01', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П1', systemCategory: 'AHU', monoblockName: 'МБ-1', status: 'added', hasConflict: false, tags: [{ id: 't1', identifier: 'FAN-001' }], specs: [], specsTotal: 0 },
  ] });
  return Response.json({});
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <div className="h-screen min-h-0 bg-white text-slate-900 dark:bg-slate-950 dark:text-white">
    <MemoryRouter initialEntries={[`/guide${window.location.search || '?tab=questions'}`]}>
      <Routes><Route path="/guide" element={<FluxGuide />} /></Routes>
    </MemoryRouter>
    <ModalProvider />
  </div>,
);
