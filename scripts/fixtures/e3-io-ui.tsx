/**
 * Стенд для проверки интерфейса «Таблицы IO» и состава блока в Chromium: сервер
 * подменён запросами в самом тесте, а окно подбора собирается здесь же из
 * синтетической книги. `?view=dialog` — окно подбора с составом блока.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { buildRecipe } from '../../e3/recipe';
import { selectSolution } from '../../e3/solutionSelect';
import E3SelectionDialog from '../../src/components/e3flux/E3SelectionDialog';
import E3SolutionsTab from '../../src/components/e3flux/E3SolutionsTab';
import ModalProvider from '../../src/components/ModalProvider';
import { PaneContext } from '../../src/lib/paneTitle';
import { ioBook, ioPositions } from './e3-io-book';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');

function Dialog() {
  const book = ioBook();
  const { valve, siblings } = ioPositions();
  const selection = selectSolution(valve, siblings, { ...book, solutions: book.solutions }, {}, { 'valve.limit': 'КП2', 'valve.box': 'нет', 'valve.heat_drive': 'нет', 'valve.epv': 'нет', 'valve.voltage': '24' });
  const recipe = buildRecipe(selection, valve, siblings, book);
  return <E3SelectionDialog label="K-1" cls="КЛАПАН" selection={selection} features={book.features} recipe={recipe} onClose={() => undefined} />;
}

createRoot(document.getElementById('mount')!).render(
  <PaneContext.Provider value="win:e3-io-ui">
    <div className="h-full">{params.get('view') === 'dialog' ? <Dialog /> : <E3SolutionsTab rights={{ edit: true, import: true }} projectId="" />}</div>
    <ModalProvider />
  </PaneContext.Provider>,
);
