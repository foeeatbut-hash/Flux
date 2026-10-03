import React from 'react';
import { queryCatalog } from '../../../catalog/query';
import { useCatalogStore } from '../../store/catalogStore';

/** Local deterministic answers from the published Catalog snapshot. */
export default function CatalogAnswer() {
  const catalog = useCatalogStore((s) => s.catalog);
  const loaded = useCatalogStore((s) => s.loaded);
  const loading = useCatalogStore((s) => s.loading);
  const error = useCatalogStore((s) => s.error);
  const load = useCatalogStore((s) => s.load);
  const [question, setQuestion] = React.useState('');
  const [result, setResult] = React.useState<ReturnType<typeof queryCatalog> | null>(null);

  React.useEffect(() => { if (!loaded && !loading) void load(); }, [loaded, loading, load]);

  const ask = (event: React.FormEvent) => {
    event.preventDefault();
    setResult(queryCatalog(catalog, question));
  };

  return (
    <section className="border-b border-slate-200 dark:border-slate-800 p-3 space-y-2" aria-label="Ответ по Каталогу">
      <form onSubmit={ask} className="flex gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)}
          placeholder="Спросить по опубликованному Каталогу" aria-label="Вопрос по Каталогу"
          className="min-w-0 flex-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm" />
        <button type="submit" disabled={!loaded || !question.trim()}
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Найти</button>
      </form>
      {loading && <p className="text-xs text-slate-500">Загружается опубликованный Каталог…</p>}
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
      {result && <div className="space-y-2 text-sm" aria-live="polite">
        <p className="whitespace-pre-line text-slate-800 dark:text-slate-300">{result.answer}</p>
        {result.matches.length > 0 && <p className="text-xs text-slate-500">Найдено: {result.matches.map((m) => m.title).join(', ')}</p>}
        {result.sources.length > 0 && <ul className="text-xs text-slate-500">
          {result.sources.map((source, i) => <li key={`${source.file}:${source.edition || ''}:${source.pages || ''}:${i}`}>
            Источник: {source.file}{source.edition ? ` · ${source.edition}` : ''}{source.pages ? ` · стр. ${source.pages}` : ''}
          </li>)}
        </ul>}
      </div>}
    </section>
  );
}
