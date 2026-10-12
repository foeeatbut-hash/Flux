import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/index.css';
import './fixture.css';
import GuideSpotlight from '../../../src/components/guide/GuideSpotlight';
import { useGuideStore } from '../../../src/guide/store';
import { withProjectContext } from '../../../src/guide/tourRuntime';
import { TOURS } from '../../../src/guide/support/tours';

function Fixture() {
  const [status, setStatus] = useState('Ожидает подтверждения');
  const [sideEffectCount, setSideEffectCount] = useState(0);
  const [dark, setDark] = useState(() => new URLSearchParams(location.search).has('dark'));
  const [projectSelected, setProjectSelected] = useState(false);
  const projectRef = useRef(false);
  const emptyProject = new URLSearchParams(location.search).has('empty-project');
  const regularTour = {
    id: 'fixture-result', title: 'Проверка результата', keywords: [], questions: [], intro: '',
    steps: [
      { text: 'Подготовьтесь к проверке результата.', action: 'info' },
      {
        text: 'Нажмите цель и дождитесь фактического статуса. Один клик не завершает шаг.',
        target: '[data-tour="fixture-target"]', action: 'click',
        expectedResult: { kind: 'visible-text', selector: '#result', contains: 'Подтверждено' },
      },
    ],
  } as any;
  const tour = emptyProject
    ? withProjectContext(TOURS.find((item) => item.id === 'add-tag')!, projectSelected)
    : regularTour;

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    useGuideStore.getState().setActiveProjectGetter(() => projectRef.current ? { id: 'fixture-project', name: 'Тестовый проект' } : null);
    useGuideStore.setState({
      activeTour: tour, tourStepIndex: 0, tourPaused: false,
      tourStepCompleted: false, highlightSelector: null,
    });
    return () => useGuideStore.setState({ activeTour: null, tourStepIndex: 0, tourPaused: false, tourStepCompleted: false, highlightSelector: null });
  }, [dark]);

  const selectProject = () => { projectRef.current = true; setProjectSelected(true); };

  return <main className="min-h-screen bg-slate-50 p-4 text-slate-800 dark:bg-dark-bg dark:text-dark-text-main">
    <section className="mx-auto flex max-w-5xl flex-col gap-4 rounded border border-slate-200 bg-white p-4 dark:border-dark-border dark:bg-dark-panel">
      <h1 className="text-sm font-semibold">Изолированная проверка подсказки Guide</h1>
      <p className="text-xs">Fixture содержит синтетические данные в памяти и не вызывает сервер или запись в проект.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setDark((value) => !value)} className="rounded border px-3 py-2 text-xs">Тема</button>
        {emptyProject && <button type="button" onClick={selectProject} className="rounded border px-3 py-2 text-xs">Выбрать проект</button>}
        <button type="button" onClick={() => setStatus('Подтверждено сервером')} className="rounded border px-3 py-2 text-xs">Показать результат</button>
        <button type="button" onClick={() => { setStatus('Сохранение…'); setSideEffectCount((n) => n + 1); }} data-tour="fixture-target" className="rounded bg-emerald-700 px-3 py-2 text-xs text-white">Цель</button>
      </div>
      <div id="result" role="status" className="text-xs">{status}</div>
      <div id="effect-count" className="text-xs">Действие пользователя: {sideEffectCount}</div>
    </section>
    <GuideSpotlight />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
