import React from 'react';
import { ArrowRight, Database, KeyRound, Keyboard, AlertTriangle, ListChecks, Lightbulb, Play } from 'lucide-react';
import type { HandbookArticle } from '../../handbook/model';
import { toursForRoute } from '../../assistant/tours';
import { useAssistantStore } from '../../store/assistantStore';
import { featureById } from '../../lib/permissions';
import { thingRu, linkRu } from '../../handbook/names';

interface Props {
  article: HandbookArticle;
  /** Перейти в сам раздел программы */
  onGoToSection?: (route: string) => void;
  /** Открыть смежную статью */
  onOpen: (id: string) => void;
  titleOf: (id: string) => string;
}

const Head = ({ id, icon: Icon, children }: { id: string; icon: any; children: React.ReactNode }) => (
  <h2 id={`hb-${id}`} className="scroll-mt-4 flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
    <Icon className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
    <span className="flex-1 min-w-0">{children}</span>
  </h2>
);

/**
 * Статья руководства.
 *
 * Порядок разделов один и тот же во всех статьях: зачем — почему — что делать —
 * что хранится — права — клавиши — на чём спотыкаются. Человек, прочитавший
 * две статьи, знает, где искать в третьей.
 */
export default function HandbookArticleView({ article: a, onGoToSection, onOpen, titleOf }: Props) {
  const startTour = useAssistantStore((s) => s.startTour);
  // Демонстрации того же раздела: словами объяснено выше, а показать — короче
  const tours = React.useMemo(() => toursForRoute(a.route || '').slice(0, 4), [a.route]);

  return (
    <article className="@container flex flex-col gap-7 pb-16">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white tracking-tight">{a.title}</h1>
          {a.route && onGoToSection && (
            <button
              type="button" onClick={() => onGoToSection(a.route!)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white shadow-sm cursor-pointer"
            >
              Открыть раздел <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="text-base text-slate-700 dark:text-slate-300 leading-relaxed max-w-[70ch]">{a.lead}</p>

        {/* Показать вместо «читайте выше»: помощник подсветит кнопки прямо в
            разделе и подождёт нажатия. Демонстрации берутся из общего списка
            (assistant/tours), а не переписаны рядом */}
        {tours.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="text-2xs font-semibold text-slate-400 dark:text-slate-500 mr-0.5">
              Показать в программе
            </span>
            {tours.map((t) => (
              <button key={t.id} type="button" onClick={() => startTour(t.id)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-semibold
                           border border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300
                           hover:bg-emerald-600/20 cursor-pointer">
                <Play className="w-3 h-3" /> {t.title}
              </button>
            ))}
          </div>
        )}
      </header>

      {a.why && (
        <section className="flex flex-col gap-2">
          <Head id="why" icon={Lightbulb}>Почему так</Head>
          {/* Пустая строка в тексте разбивает его на абзацы. Раньше весь
              «почему» шёл одним куском: длинные объяснения в три мысли
              слипались в стену текста, которую никто не дочитывал. */}
          {a.why.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="text-sm text-slate-650 dark:text-slate-400 leading-relaxed max-w-[70ch]">{para}</p>
          ))}
        </section>
      )}

      {a.tasks.length > 0 && (
        <section className="flex flex-col gap-3">
          <Head id="tasks" icon={ListChecks}>Что можно сделать</Head>
          <div className="grid grid-cols-1 @[820px]:grid-cols-2 gap-3">
            {a.tasks.map((t) => (
              <div key={t.title} className="sheet p-4 flex flex-col gap-2 min-w-0">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{t.title}</h3>
                <ol className="flex flex-col gap-1.5 list-decimal pl-4 text-sm text-slate-650 dark:text-slate-400">
                  {t.steps.map((s, i) => <li key={i} className="leading-relaxed">{s}</li>)}
                </ol>
                {t.note && (
                  <p className="text-2xs text-slate-500 dark:text-slate-400 border-l-2 border-emerald-600 pl-2.5 mt-0.5 leading-relaxed">
                    {t.note}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {(a.stores?.length || a.links?.length) && (
        <section className="flex flex-col gap-3">
          <Head id="data" icon={Database}>Что хранится</Head>
          {/* Названия по-русски. Внутри программы это Tag, Folder и FileNode,
              но руководство читает инженер, а не тот, кто её писал: ему нужно
              знать, что удаление проекта уносит теги и папки, а не как эти
              таблицы называются (перевод — в src/handbook/names.ts). */}
          {a.stores?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {a.stores.map((s) => (
                <span key={s} className="px-2 py-0.5 rounded-md text-2xs font-semibold bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800">
                  {thingRu(s)}
                </span>
              ))}
            </div>
          ) : null}
          {a.links?.length ? (
            <div className="sheet overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-2xs text-slate-400 dark:text-slate-500">
                    <th className="text-left font-semibold px-3 py-2">Что</th>
                    <th className="text-left font-semibold px-3 py-2">Опирается на</th>
                    <th className="text-left font-semibold px-3 py-2">Как связаны</th>
                  </tr>
                </thead>
                <tbody>
                  {a.links.map(([from, to, via], i) => (
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-white">{thingRu(from)}</td>
                      <td className="px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">{thingRu(to)}</td>
                      <td className="px-3 py-1.5 text-xs text-slate-650 dark:text-slate-400">{linkRu(via)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      )}

      {a.perms?.length ? (
        <section className="flex flex-col gap-2.5">
          <Head id="perms" icon={KeyRound}>Права</Head>
          <ul className="flex flex-col gap-1.5">
            {a.perms.map((id) => {
              const f = featureById(id);
              return (
                <li key={id} className="flex items-start gap-2 text-sm">
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${f?.risky ? 'bg-rose-500' : 'bg-emerald-600'}`} />
                  <span className="flex-1 min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-white">{f?.label || id}</span>
                    {f?.risky && <span className="ml-1.5 text-2xs font-semibold text-rose-600 dark:text-rose-400">не откатывается</span>}
                    {f?.desc && <span className="block text-xs text-slate-650 dark:text-slate-400">{f.desc}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {a.keys?.length ? (
        <section className="flex flex-col gap-2.5">
          <Head id="keys" icon={Keyboard}>Клавиши</Head>
          <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-x-6 gap-y-1.5">
            {a.keys.map(([k, does]) => (
              <div key={k} className="flex items-baseline gap-2.5 text-sm min-w-0">
                <kbd className="shrink-0 px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 border-b-2 bg-white dark:bg-slate-900 font-mono text-xs font-medium text-slate-900 dark:text-white">
                  {k}
                </kbd>
                <span className="flex-1 min-w-0 text-slate-650 dark:text-slate-400">{does}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {a.pitfalls?.length ? (
        <section className="flex flex-col gap-2.5">
          <Head id="pitfalls" icon={AlertTriangle}>На что напороться</Head>
          <ul className="flex flex-col gap-2">
            {a.pitfalls.map((p, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <span className="flex-1 min-w-0 text-slate-800 dark:text-slate-300 leading-relaxed">{p}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {a.see?.length ? (
        <footer className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <span className="text-2xs font-semibold text-slate-400 dark:text-slate-500">Смотрите также</span>
          {a.see.map((id) => (
            <button
              key={id} type="button" onClick={() => onOpen(id)}
              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-850 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              {titleOf(id)}
            </button>
          ))}
        </footer>
      ) : null}
    </article>
  );
}
