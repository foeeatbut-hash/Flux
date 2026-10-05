import React from 'react';
import { createRoot } from 'react-dom/client';
import HandbookNav from '../../../../src/components/handbook/HandbookNav';
import { ARTICLES, articleById, search } from '../../../../src/handbook/registry';
import './fixture.css';

function Fixture() {
  const [query, setQuery] = React.useState('');
  const [openId, setOpenId] = React.useState('start');
  const hits = React.useMemo(() => search(query, 20, () => true), [query]);
  const current = articleById(openId);

  return <main className="flex h-full min-h-0 gap-3 bg-white p-3 text-slate-900 dark:bg-slate-950 dark:text-white">
    <aside className="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
      <HandbookNav articles={ARTICLES} openId={openId} query={query} hits={hits} onQuery={setQuery} onOpen={setOpenId}/>
    </aside>
    <section aria-label="Выбранная статья" className="min-w-0 flex-1 overflow-auto">
      <h1>{current?.title || 'Статья не найдена'}</h1>
      <p>{current?.lead}</p>
      <output aria-label="ID выбранной статьи">{openId}</output>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture/>);
