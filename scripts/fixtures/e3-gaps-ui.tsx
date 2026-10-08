/**
 * Стенд для проверки раздела «Нет данных»: целиком экран E3Flux, сервер подменён
 * запросами в самом тесте. Проект выбран здесь же, до отрисовки.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import E3FluxScreen from '../../src/screens/E3FluxScreen';
import ModalProvider from '../../src/components/ModalProvider';
import { PaneContext } from '../../src/lib/paneTitle';
import { useStore } from '../../src/store/store';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');
useStore.setState({ activeProject: { id: 'p1', name: 'Тестовый проект' } as any });

createRoot(document.getElementById('mount')!).render(
  <PaneContext.Provider value="win:e3-gaps-ui">
    <MemoryRouter><div className="h-full"><E3FluxScreen /></div></MemoryRouter>
    <ModalProvider />
  </PaneContext.Provider>,
);
