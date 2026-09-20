import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, PanelLeftClose, PanelLeftOpen, Link2, Link2Off } from 'lucide-react';
import HandbookNav from '../components/handbook/HandbookNav';
import HandbookArticleView from '../components/handbook/HandbookArticleView';
import { ARTICLES, openTo, search, articleById } from '../handbook/registry';
import { allowEntitlement } from '../store/policyStore';
import { anchorsOf } from '../handbook/model';
import { useWindowStore } from '../store/windowStore';
import { useWindowTitle } from '../lib/paneTitle';

/**
 * Руководство по программе.
 *
 * Три колонки: оглавление с поиском, статья, поле «на этой странице». Раздел
 * живёт в панели рабочего стола, поэтому ширину меряем у контейнера: при
 * @[1180px] стоят все три колонки, ниже уходит поле якорей, а при @[820px] —
 * и оглавление, в кнопку: статью читать важнее, чем видеть список.
 *
 * Вход бывает двух родов: из левого меню (открывается статья, на которой
 * остановились) и по F1 из любого раздела — тогда в адресе стоит ?for=/registry,
 * и открывается статья именно этого раздела.
 */
export default function Handbook() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  // Ниже 820 точек оглавление и статья не помещаются рядом: держим оглавление
  // закрытым и открываем кнопкой. Выше 820 его показывает запрос к контейнеру,
  // и это состояние ни на что не влияет. Порог взят по замеру: при окне 1100
  // на панель остаётся около 860 точек — оглавление должно быть ещё видно.
  const [navOpen, setNavOpen] = useState(false);
  const [anchor, setAnchor] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * «Следовать за программой»: справка меняет статью вслед за верхним окном.
   *
   * Ради этого её и ставят рядом — половина экрана Тегам, половина справке.
   * Без слежения приходилось бы каждый раз возвращаться в справку и заново
   * искать статью того раздела, в котором работаешь; с ним справка ведёт себя
   * как подпись к тому, что открыто.
   */
  const [follow, setFollow] = useState<boolean>(() => {
    try { return localStorage.getItem('flux_handbook_follow') === '1'; } catch { return false; }
  });
  const topPath = useWindowStore((st) => {
    const shown = st.windows.filter((w) => !w.minimized && w.desk === st.desk && w.path !== '/handbook');
    if (!shown.length) return '';
    return shown.reduce((a, b) => (b.z > a.z ? b : a)).path;
  });

  /**
   * Оглавление — это тоже список программ.
   *
   * Статья о встроенной программе, доступ к которой не выдан, не показывается
   * и не открывается по ссылке: руководство было бы самым спокойным способом
   * узнать, что в программе есть раздел, которого тебе не показывают.
   */
  const openArticles = useMemo(() => openTo(ARTICLES, allowEntitlement), []);

  // Что открыто: явная статья, статья раздела по F1, либо начало
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

  const article = (openArticles.find((a) => a.id === openId) || openArticles[0] || ARTICLES[0]);
  useWindowTitle(`Справка · ${article.title}`);
  const hits = useMemo(() => search(query, 20, allowEntitlement), [query]);
  const anchors = useMemo(() => anchorsOf(article), [article]);

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('article', id);
    next.delete('for');
    setParams(next, { replace: true });
  };

  // Слежение: сменилось верхнее окно — меняется статья. Только когда включено
  // и только если у этого раздела статья вообще есть: молчаливый прыжок на
  // «С чего начать» выглядел бы поломкой
  useEffect(() => {
    if (!follow || !topPath) return;
    const a = openArticles.find((x) => x.route === topPath);
    if (a && a.id !== openId) open(a.id);
  }, [follow, topPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Смена статьи возвращает к началу: иначе новая статья открывается на том
  // месте, до которого была прокручена предыдущая
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    setAnchor('');
  }, [openId]);

  // Какой заголовок сейчас на экране — подсвечиваем его в поле якорей
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !anchors.length) return;
    const onScroll = () => {
      let current = '';
      for (const a of anchors) {
        const el = root.querySelector(`#hb-${a.id}`) as HTMLElement | null;
        if (el && el.getBoundingClientRect().top - root.getBoundingClientRect().top < 80) current = a.id;
      }
      setAnchor(current);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [anchors, openId]);

  const goAnchor = (id: string) => {
    const el = bodyRef.current?.querySelector(`#hb-${id}`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /**
   * /handbook?article=<статья>&at=<место> — открыть статью на нужном месте.
   *
   * По такой ссылке сюда приводит помощник: на вопрос «где в руководстве про
   * подписи» он отвечает и даёт переход не просто в статью, а в тот её кусок,
   * о котором речь. Место на секунду подсвечивается — иначе после прокрутки
   * непонятно, куда смотреть, особенно если статья длинная.
   *
   * Параметр гасим сразу: при следующем открытии той же статьи из оглавления
   * прыгать в середину уже незачем.
   */
  useEffect(() => {
    const at = params.get('at');
    if (!at) return;
    const t = window.setTimeout(() => {
      goAnchor(at);
      const el = bodyRef.current?.querySelector(`#hb-${at}`) as HTMLElement | null;
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

  return (
    <div id="handbook-root" className="@container h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 pb-3 min-w-0">
        <button
          type="button" onClick={() => setNavOpen((v) => !v)}
          title={navOpen ? 'Скрыть оглавление' : 'Показать оглавление'}
          className="@[820px]:hidden p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-500 cursor-pointer shrink-0"
        >
          {navOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>
        <BookOpen className="w-5 h-5 text-emerald-700 dark:text-emerald-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold text-slate-900 dark:text-white truncate">Руководство</h1>
          <p className="text-2xs text-slate-500 dark:text-slate-400 truncate">
            Что умеет каждый раздел, что где хранится и чем связано
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const next = !follow;
            setFollow(next);
            try { localStorage.setItem('flux_handbook_follow', next ? '1' : '0'); } catch (_) { /* приватный режим */ }
          }}
          title={follow
            ? 'Справка следует за программой: статья меняется вслед за верхним окном'
            : 'Следовать за программой: статья будет меняться вслед за верхним окном'}
          className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-2xs font-semibold
                      cursor-pointer transition-colors border ${
            follow
              ? 'border-emerald-600/40 bg-emerald-600/15 text-emerald-700 dark:text-emerald-300'
              : 'border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'
          }`}
        >
          {follow ? <Link2 className="w-3.5 h-3.5" /> : <Link2Off className="w-3.5 h-3.5" />}
          <span className="hidden @[560px]:inline">Следовать за программой</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 flex gap-4 min-w-0">
        <aside
          className={`${navOpen ? 'flex' : 'hidden'} @[820px]:flex shrink-0 w-56 @[1180px]:w-64 flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden`}
        >
          <HandbookNav
            articles={openArticles}
            openId={openId}
            query={query}
            hits={hits}
            onQuery={setQuery}
            onOpen={(id) => { open(id); setNavOpen(false); }}
          />
        </aside>

        <div ref={bodyRef} className="flex-1 min-w-0 overflow-y-auto scrollbar-thin pr-1">
          <HandbookArticleView
            article={article}
            onOpen={open}
            titleOf={titleOf}
            onGoToSection={(route) => navigate(route)}
          />
        </div>

        {anchors.length > 1 && (
          <nav className="hidden @[1180px]:flex shrink-0 w-48 flex-col gap-1 pt-1" aria-label="На этой странице">
            <span className="px-2 pb-1 text-2xs uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">
              На этой странице
            </span>
            {anchors.map((x) => (
              <button
                key={x.id} type="button" onClick={() => goAnchor(x.id)}
                className={`text-left px-2 py-1 rounded-lg text-xs cursor-pointer transition-colors border-l-2 ${
                  anchor === x.id
                    ? 'border-emerald-600 text-emerald-800 dark:text-emerald-300 font-semibold bg-emerald-50/60 dark:bg-emerald-950/30'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
                }`}
              >
                {x.title}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
