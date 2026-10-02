import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Minus, Square, X } from 'lucide-react';
import SectionFrame, { makeLocation, asHref } from './SectionFrame';
import { internalAppHref } from '../../workspace/nativeApps';
import { sectionForPath } from '../workspace/sections';
import { mayClose } from '../lib/closeGuard';
import { useWindowStore } from '../store/windowStore';
import { useAppContext } from '../store/policyStore';
import { sectionAccess } from '../lib/appPolicy';
import ModalProvider from './ModalProvider';

/** Отдельный WebContents не пересоздаётся при переносе настоящего окна Windows. */
export default function NativeAppHost() {
  const outer = useLocation(); const navigate = useNavigate();
  const params = new URLSearchParams(outer.search);
  const id = params.get('id') || '';
  const href = internalAppHref(params.get('target')) || '/';
  const location = React.useMemo(() => makeLocation(href), [href]);
  const path = sectionForPath(location.pathname).path;
  const def = sectionForPath(path);
  const ctx = useAppContext();
  const title = useWindowStore(s => s.titles[id]) || def.title;
  const [closing, setClosing] = React.useState(false);
  const closeInProgress = React.useRef(false);
  const api = (window as any).electron?.nativeApps;
  React.useEffect(() => {
    document.title = `${title} — Flux`;
  }, [title]);
  React.useEffect(() => {
    void api?.location?.(id, href)?.catch(() => {});
  }, [api, id, href]);
  React.useEffect(() => {
    if (!api?.onCloseRequest) return;
    return api.onCloseRequest(async (requested: string) => {
      if (requested !== id || closeInProgress.current) return;
      closeInProgress.current = true; setClosing(true);
      try { await api.closeReply(id, await mayClose(id)); }
      catch { /* Отказ моста сохраняет редактор и его правки. */ }
      finally { closeInProgress.current = false; setClosing(false); }
    });
  }, [api, id]);
  const transition = React.useCallback(async (to: any, opts?: any) => {
    const next = internalAppHref(typeof to === 'string' ? to : asHref(to));
    if (!next || (next !== href && !await mayClose(id))) return;
    const query = new URLSearchParams({ id, target: next });
    navigate(`/native-app?${query}`, opts);
  }, [href, id, navigate]);
  const access = sectionAccess(def, ctx);
  return <div className="flex h-dvh min-h-0 flex-col bg-white text-slate-700 dark:bg-dark-bg dark:text-slate-300">
    <header className="flex h-9 shrink-0 items-center border-b border-slate-200 bg-slate-50 dark:border-dark-border dark:bg-dark-surface">
      <div className="min-w-0 flex-1 truncate px-3 text-sm" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>{title}</div>
      <button type="button" title="Свернуть" className="h-9 w-10 hover:bg-slate-200 dark:hover:bg-slate-700" onClick={() => (window as any).electron?.windowControls?.minimize()}><Minus size={14} className="mx-auto" /></button>
      <button type="button" title="Развернуть" className="h-9 w-10 hover:bg-slate-200 dark:hover:bg-slate-700" onClick={() => (window as any).electron?.windowControls?.maximize()}><Square size={12} className="mx-auto" /></button>
      <button type="button" title="Закрыть" disabled={closing} className="h-9 w-10 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50" onClick={() => (window as any).electron?.windowControls?.close()}><X size={15} className="mx-auto" /></button>
    </header>
    <main className="relative min-h-0 flex-1">
      {access === 'hide' ? <div className="fx-empty">Раздел недоступен для вашей учётной записи.</div>
        : <SectionFrame paneId={`win:${id}`} path={path} href={href} isLive visible liveLocation={location} globalNavigate={transition} />}
    </main>
    <ModalProvider />
  </div>;
}
