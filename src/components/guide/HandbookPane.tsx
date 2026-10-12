import { useEffect, useMemo, useRef } from 'react';
import { Clock, MessageSquare, Star } from 'lucide-react';
import HandbookNav from '../handbook/HandbookNav';
import HandbookArticleView from '../handbook/HandbookArticleView';
import { ARTICLES, openTo, search, articleById } from '../../handbook/registry';
import { anchorsOf, GROUPS } from '../../handbook/model';
import { allowEntitlement } from '../../store/policyStore';
import { useGuideStore } from '../../guide/store';

// ── Режим «Справочник»: статья + дерево, поиск живёт в нижней строке ──

export function HandbookPane({ params, setParams, query }: { params: URLSearchParams; setParams: (next: URLSearchParams, opts?: any) => void; query: string }) {
  const favorites = useGuideStore((s) => s.favorites);
  const recent = useGuideStore((s) => s.recent);
  const toggleFavorite = useGuideStore((s) => s.toggleFavorite);
  const rememberArticle = useGuideStore((s) => s.rememberArticle);
  const runAction = useGuideStore((s) => s.runAction);
  const setMode = useGuideStore((s) => s.setMode);
  const ask = useGuideStore((s) => s.ask);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openArticles = useMemo(() => openTo(ARTICLES, allowEntitlement), []);
  const compact = query.trim().length >= 2;

  const openId = useMemo(() => {
    const byId = params.get('article');
    if (byId && openArticles.some((a) => a.id === byId)) return byId;
    const forRoute = params.get('for');
    if (forRoute) {
      const a = openArticles.find((x) => x.route === forRoute);
      if (a) return a.id;
    }
    return 'start';
  }, [params, openArticles]);

  const article = openArticles.find((a) => a.id === openId) || openArticles[0] || ARTICLES[0];
  const hits = useMemo(() => (compact ? search(query, 20, allowEntitlement) : []), [compact, query]);
  const anchors = useMemo(() => anchorsOf(article), [article]);
  const isFav = favorites.includes(article.id);

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('article', id);
    next.delete('for');
    setParams(next, { replace: true });
  };

  useEffect(() => { rememberArticle(article.id); }, [article.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [openId]);

  // ?at=<якорь> — открыть статью на нужном месте и подсветить
  useEffect(() => {
    const at = params.get('at');
    if (!at) return;
    const t = window.setTimeout(() => {
      const el = bodyRef.current?.querySelector(`#hb-${at}`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (el) {
        el.classList.add('flux-hb-flash');
        window.setTimeout(() => el.classList.remove('flux-hb-flash'), 2000);
      }
      const next = new URLSearchParams(params);
      next.delete('at');
      setParams(next, { replace: true });
    }, 240);
    return () => window.clearTimeout(t);
  }, [params, openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const titleOf = (id: string) => articleById(id)?.title || id;
  const favList = favorites.map((id) => articleById(id)).filter(Boolean).slice(0, 5);
  const recentList = recent.map((id) => articleById(id)).filter((a): a is NonNullable<typeof a> => !!a && a.id !== article.id).slice(0, 5);
  const goToSection = (route: string) => runAction({ kind: 'navigate', label: '', route });

  return (
    <div className="flex-1 min-h-0 flex min-w-0">
      {/* Две колонки от 760 px (навигация слева); в компакте дерево открывается кнопкой */}
      <div className="hidden @[760px]:block w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 min-h-0">
        <HandbookNav articles={openArticles} openId={compact ? '' : openId} query={query} hits={hits} onQuery={() => {}} onOpen={open} hideSearch />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-800 min-w-0">
          <span className="text-2xs text-slate-400 dark:text-slate-500 truncate">Справочник Flux · {compact ? `поиск «${query.trim()}»` : article.title}</span>
          <div className="flex-1" />
          <button type="button" onClick={() => toggleFavorite(article.id)}
            className={`p-1.5 rounded-lg cursor-pointer ${isFav ? 'text-amber-500' : 'text-slate-400 hover:text-amber-500'}`}
            title={isFav ? 'Убрать из избранного' : 'В избранное'}>
            <Star className={`w-4 h-4 ${isFav ? 'fill-amber-400' : ''}`} />
          </button>
        </div>

        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-4">
          {compact ? (
            hits.length ? (
              <ul className="flex flex-col gap-1">
                {hits.map((h) => (
                  <li key={h.article.id}>
                    <button type="button" onClick={() => open(h.article.id)}
                      className="w-full text-left px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-emerald-600/60 cursor-pointer min-w-0">
                      <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text-main">{h.article.title}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{h.excerpt}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-slate-400">По запросу «{query.trim()}» статей нет. Проверьте слова или спросите «Вопросами» — Guide подскажет близкие темы.</div>
            )
          ) : (
            <>
              {/* Стартовый экран: короткая строка, программы, избранное/недавние только при наличии */}
              {openId === 'start' && (
                <div className="flex flex-col gap-5 mb-6 max-w-[70ch]">
                  <div>
                    <h1 className="text-xl font-semibold text-slate-900 dark:text-white tracking-tight mb-1">Найдите программу или нужное действие</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Выберите раздел ниже, наберите запрос в строке внизу или задайте вопрос — Guide ответит по проверенным статьям и данным проекта.</p>
                  </div>
                  {(favList.length > 0 || recentList.length > 0) && (
                    <div className="flex flex-col gap-3">
                      {favList.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-2xs font-semibold text-slate-400 flex items-center gap-1"><Star className="w-3 h-3" /> Избранное</span>
                          <div className="flex flex-wrap gap-1.5">
                            {favList.map((a) => a && (
                              <button key={a.id} type="button" onClick={() => open(a.id)}
                                className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer">
                                {a.title}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {recentList.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-2xs font-semibold text-slate-400 flex items-center gap-1"><Clock className="w-3 h-3" /> Недавно открытые</span>
                          <div className="flex flex-wrap gap-1.5">
                            {recentList.map((a) => (
                              <button key={a.id} type="button" onClick={() => open(a.id)}
                                className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer">
                                {a.title}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Программы — компактные группы по реальным маршрутам */}
                  {GROUPS.filter((g) => g.id === 'sections').map((g) => (
                    <div key={g.id} className="flex flex-col gap-1.5">
                      <span className="text-2xs font-semibold text-slate-400">{g.title}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {openArticles.filter((a) => a.group === 'sections' && a.route).map((a) => (
                          <button key={a.id} type="button" onClick={() => open(a.id)}
                            className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-slate-200 dark:border-slate-800
                                       text-slate-700 dark:text-slate-300 hover:border-emerald-600/60 hover:bg-emerald-600/5 cursor-pointer"
                            title={a.lead}>
                            {a.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <HandbookArticleView article={article} onGoToSection={goToSection} onOpen={open} titleOf={titleOf} />

              {/* Связь с «Вопросами»: контекст статьи переносится в запрос, не отправляется сам */}
              <div className="mt-4 max-w-[70ch] flex flex-wrap gap-2">
                <button type="button"
                  onClick={() => { setMode('questions'); void ask(`Как — ${article.title}: подробно`); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-emerald-600/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/10 cursor-pointer">
                  <MessageSquare className="w-3.5 h-3.5" /> Задать вопрос по теме
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

