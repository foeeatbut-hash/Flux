import React from 'react';
import { createRoot } from 'react-dom/client';
import ModuleFrame from '../../src/components/modules/ModuleFrame';
import { pageTimings } from '../../src/services/modulePage';
import { useWindowStore } from '../../src/store/windowStore';

// Данные Flux подставные: настоящий протокол, оболочка, мост и окно программы, но без сервера
const data: Record<string, unknown> = { project: { id: 'p', name: 'Тестовый проект', code: 'P' }, equipment: null, tag: null, specification: { rows: [] }, catalog: { families: [] } };
const params = new URLSearchParams(location.search);
// Порог «не отвечает» в проверке короче рабочего: полминуты ждать незачем, а сам механизм тот же
pageTimings.hangMs = Number(params.get('hang') || pageTimings.hangMs);
// Вопросы Flux (сохранение файла) — заглушка диалога: запоминаем текст и отвечаем так, как просит проверка
(window as any).__dialogs = [] as string[];
(window as any).__answer = true;
window.confirm = (text?: string) => { (window as any).__dialogs.push(String(text)); return (window as any).__answer; };
// Окна программы: проверка занимает пять мест, чтобы шестое открытие упёрлось в предел
(window as any).__fillWindows = (id: string, count: number) => useWindowStore.setState({
  windows: Array.from({ length: count }, (_, i) => ({ id: `w${i}`, path: `/module/${id}`, href: `/module/${id}`, desk: 0, x: 0, y: 0, w: 300, h: 200, z: i, minimized: false, maximized: false })) as never,
});
document.body.style.background = 'var(--flux-surface)';
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <button className="fx-btn" id="theme" onClick={() => document.documentElement.classList.toggle('dark')}>Тема</button>
    <ModuleFrame key={params.get('manifest')! + params.get('page')} manifest={JSON.parse(params.get('manifest')!)} page={params.get('page') || undefined}
      context={{ projectId: 'p', entry: 'start', entityId: null }} theme="light"
      createReadCycle={() => async (resource: string) => data[resource] as never} />
  </div>,
);
