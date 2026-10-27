/**
 * Помощник в правой панели: тот же Flux Guide, что и раздел, но карточкой у
 * правого края — спросить, не уходя от рабочего окна.
 *
 * Содержимое — сам раздел `/guide`, без второй копии; его состояние (беседа,
 * черновик, режим) живёт в хранилище Guide и потому общее с окном раздела.
 * Своего роутера у карточки нет, поэтому, как и SectionFrame, она подставляет
 * разделу собственные контексты react-router: адрес внутри карточки (вкладка,
 * статья) — её личный, а переход в другой раздел уходит в общий роутер оболочки
 * и открывает там обычное окно.
 */
import React, { Suspense } from 'react';
import { NavigationType, UNSAFE_LocationContext, UNSAFE_NavigationContext, useNavigate } from 'react-router-dom';
import type { Location, To } from 'react-router-dom';
import { Maximize2, X } from 'lucide-react';
import { sectionForPath } from '../workspace/sections';
import { sectionAccess } from '../lib/appPolicy';
import { useAppContext } from '../store/policyStore';
import { PaneContext } from '../lib/paneTitle';
import { useAssistantDockStore } from '../store/assistantDockStore';
import SectionErrorBoundary from './SectionErrorBoundary';

const START = '/guide?tab=questions';

const makeLocation = (to: To, state?: unknown): Location => {
  const url = typeof to === 'string' ? new URL(to, 'http://x') : new URL(`${to.pathname || '/'}${to.search || ''}${to.hash || ''}`, 'http://x');
  return { pathname: url.pathname, search: url.search, hash: url.hash, state, key: Math.random().toString(36).slice(2) };
};
const hrefOf = (to: To): string => (typeof to === 'string' ? to : `${to.pathname || ''}${to.search || ''}${to.hash || ''}`);

export default function GuideDockPanel() {
  const def = sectionForPath('/guide');
  const ctx = useAppContext();
  const globalNavigate = useNavigate();
  const setOpen = useAssistantDockStore((s) => s.setOpen);
  const [loc, setLoc] = React.useState<Location>(() => makeLocation(START));
  const access = sectionAccess(def, ctx);

  const navigator = React.useMemo(() => {
    const go = (to: To, state: unknown, replace: boolean) => {
      // Свои вкладки и статьи остаются в карточке, остальное — в общий роутер
      if (hrefOf(to).startsWith('/guide')) { setLoc(makeLocation(to, state)); return; }
      globalNavigate(to, { state: { ...((state as object) || {}), __pane: 'dock:guide' }, replace });
    };
    return {
      createHref: (to: To) => hrefOf(to),
      encodeLocation: (to: To) => makeLocation(to),
      go: () => {},
      push: (to: To, state?: unknown) => go(to, state, false),
      replace: (to: To, state?: unknown) => go(to, state, true),
    };
  }, [globalNavigate]);
  const navContext = React.useMemo<any>(() => ({ basename: '', navigator, static: false }), [navigator]);
  const locContext = React.useMemo(() => ({ location: loc, navigationType: NavigationType.Pop }), [loc]);

  const Comp = def.Component;
  return (
    <section aria-label="Помощник" data-dock-assistant className="fx-glass rounded-xl overflow-hidden h-full min-h-0 flex flex-col">
      {/* Собственная строка карточки: рамки окна у неё нет, а шапка Guide занята
          проектом и действиями беседы — класть кнопки поверх неё значило бы
          перекрывать их */}
      <div className="flex items-center gap-0.5 h-9 pl-4 pr-2 shrink-0">
        <span className="mr-auto text-xs font-semibold text-slate-600 dark:text-slate-300">Помощник</span>
        <button type="button" title="Открыть в окне" aria-label="Открыть в окне"
          onClick={() => { setOpen(false); globalNavigate(START); }}
          className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-500/20">
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" title="Закрыть" aria-label="Закрыть помощника" onClick={() => setOpen(false)}
          className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer text-slate-600 dark:text-slate-300 hover:bg-slate-500/20">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="relative flex-1 min-h-0">
      {access !== 'open' ? (
        <div className="fx-empty"><div className="fx-empty-title">Помощник закрыт</div>
          <div className="fx-empty-text">Раздел «Flux Guide» недоступен: его выдаёт администратор.</div></div>
      ) : (
        <PaneContext.Provider value="dock:guide">
          <UNSAFE_NavigationContext.Provider value={navContext}>
            <UNSAFE_LocationContext.Provider value={locContext}>
              <SectionErrorBoundary title={def.title} onClose={() => setOpen(false)}>
                <Suspense fallback={<div className="w-full h-full flex items-center justify-center"><div className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-transparent animate-spin" /></div>}>
                  <div className="absolute inset-0 overflow-hidden"><Comp /></div>
                </Suspense>
              </SectionErrorBoundary>
            </UNSAFE_LocationContext.Provider>
          </UNSAFE_NavigationContext.Provider>
        </PaneContext.Provider>
      )}
      </div>
    </section>
  );
}
