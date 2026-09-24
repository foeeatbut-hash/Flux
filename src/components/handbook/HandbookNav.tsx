import React from 'react';
import { Search, X } from 'lucide-react';
import { GROUPS, type HandbookArticle } from '../../handbook/model';
import type { HandbookHit } from '../../handbook/registry';

interface Props {
  articles: HandbookArticle[];
  openId: string;
  query: string;
  hits: HandbookHit[];
  onQuery: (q: string) => void;
  onOpen: (id: string) => void;
}

/**
 * Оглавление руководства: поиск и дерево статей по группам.
 *
 * Пока в поле поиска что-то есть, дерево уступает место находкам — держать на
 * экране и то и другое значит показывать два ответа на один вопрос.
 */
export default function HandbookNav({ articles, openId, query, hits, onQuery, onOpen }: Props) {
  const searching = query.trim().length >= 2;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 p-2.5 border-b border-slate-200 dark:border-slate-800">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Поиск по руководству"
            aria-label="Поиск по руководству"
            className="w-full pl-8 pr-8 py-1.5 text-sm rounded-lg bg-slate-100 dark:bg-slate-850 border border-transparent focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900 outline-none text-slate-900 dark:text-white placeholder:text-slate-400"
          />
          {query && (
            <button
              type="button" onClick={() => onQuery('')} title="Очистить поиск"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-thin py-2">
        {searching ? (
          hits.length ? (
            <ul className="px-1.5 flex flex-col gap-0.5">
              {hits.map((h) => (
                <li key={h.article.id}>
                  <button
                    type="button" onClick={() => onOpen(h.article.id)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                      h.article.id === openId
                        ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="block text-sm font-semibold truncate">{h.article.title}</span>
                    <span className="block text-2xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5">
                      {h.excerpt}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-6 text-center">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Ничего не нашлось</p>
              <p className="text-2xs text-slate-500 dark:text-slate-400 mt-1">
                Попробуйте одно слово вместо нескольких — например «корзина» или «подпись».
              </p>
            </div>
          )
        ) : (
          GROUPS.map((g) => {
            const list = articles.filter((a) => a.group === g.id);
            if (!list.length) return null;
            return (
              <section key={g.id} className="px-1.5 pb-3">
                <h3 className="px-2.5 pt-2 pb-1 text-xs font-semibold text-slate-400 dark:text-slate-500">
                  {g.title}
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {list.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button" onClick={() => onOpen(a.id)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm cursor-pointer transition-colors flex items-center gap-2 min-w-0 ${
                          a.id === openId
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold'
                            : 'hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <span className="flex-1 min-w-0 truncate">{a.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </nav>
    </div>
  );
}
