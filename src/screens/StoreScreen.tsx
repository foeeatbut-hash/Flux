/**
 * Flux Store — раздел «Store» в «Пуске»: витрина, страница программы,
 * библиотека, администрирование. Вид по образцу Microsoft Store
 * (docs/methodology/01-design.md, исключение; устройство — roadmap/modules.md).
 */
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Home, LayoutGrid, Library, ScrollText, Search, Shield } from 'lucide-react';
import '../components/store/store.css';
import { categoryName, searchListings, STORE_CATEGORIES, updateAvailable, type StoreListing } from '../../modules/store/model';
import { moduleHref } from '../../modules/launch';
import { useModuleStore } from '../store/moduleStoreState';
import { useStore } from '../store/store';
import StoreHome, { StoreCard } from '../components/store/StoreHome';
import StoreModulePage from '../components/store/StoreModulePage';
import StoreLibrary from '../components/store/StoreLibrary';
import StoreAdmin from '../components/store/StoreAdmin';
import StoreDialogs, { type StoreDialog } from '../components/store/StoreDialogs';
import { ModuleIcon, type ActionKind } from '../components/store/StoreParts';
import { Chip } from '../components/ui';
import ModuleJournalView from '../components/store/ModuleJournalView';
import { moduleStoreApi } from '../services/moduleStoreService';

type View = 'home' | 'apps' | 'downloads' | 'library' | 'admin' | 'journal';

export default function StoreScreen() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const user = useStore((s) => s.user) as any;
  const { listings, loaded, offline, error, busy, local } = useModuleStore();
  const [view, setView] = useState<View>('home');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [suggest, setSuggest] = useState(false);
  const [dialog, setDialog] = useState<StoreDialog>(null);
  const [toast, setToast] = useState('');
  // Разработчик видит журнал своих программ (без людей); право проверяет сервер, здесь только показ пункта
  const [develop, setDevelop] = useState(false);
  React.useEffect(() => { void moduleStoreApi.me().then((m) => setDevelop(!!m.develop)).catch(() => setDevelop(false)); }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const isAdmin = user?.role === 'OWNER' || user?.role === 'ADMIN';
  const openId = params.get('module');
  const current = openId ? listings.find((l) => l.moduleId === openId) || null : null;
  // Новая страница открывается сверху: прежняя прокрутка не должна сразу сжимать шапку
  useLayoutEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [openId, view, category]);
  const updates = listings.filter(updateAvailable).length;
  const downloads = Object.keys(busy).length + updates;

  const found = useMemo(() => searchListings(listings.filter((l) => l.status === 'admitted' || l.mine || isAdmin), query), [listings, query, isAdmin]);
  const go = (next: View) => { setView(next); setQuery(''); setCategory(''); if (openId) setParams({}); };
  const open = (l: StoreListing) => { setSuggest(false); setParams({ module: l.moduleId }); };
  const onAct = (l: StoreListing, kind: ActionKind) => {
    if (kind === 'open') navigate(moduleHref(l.moduleId));
    else if (kind === 'install' || kind === 'update') setDialog({ kind, listing: l });
  };
  const report = (l: StoreListing) => window.dispatchEvent(new CustomEvent('flux:report-module', { detail: { moduleId: l.moduleId, name: l.name, version: l.version, channel: l.channel, apiVersion: String(l.manifest.contractVersion), developer: l.developer } }));

  const nav = (id: View, label: string, icon: React.ReactNode, count = 0) => <button type="button" className="stx-nav" aria-current={!openId && view === id ? 'page' : undefined}
    data-testid={`stx-nav-${id}`} onClick={() => go(id)}>{icon}<span>{label}</span>{count > 0 && <span className="stx-count">{count}</span>}</button>;

  const body = () => {
    if (current) return <StoreModulePage listing={current} onBack={() => setParams({})} onAct={(k) => onAct(current, k)} onReport={() => report(current)} />;
    if (query.trim()) return <><div className="stx-h">Результаты: «{query.trim()}»</div>
      {found.length ? <div className="stx-grid">{found.map((l, i) => <StoreCard key={l.moduleId} listing={l} index={i} onOpen={open} onAct={onAct} />)}</div> : <div className="stx-note">Ничего не найдено.</div>}</>;
    if (view === 'home') return <StoreHome listings={listings} onOpen={open} onAct={onAct} />;
    if (view === 'apps') {
      const list = listings.filter((l) => (l.status === 'admitted' || l.mine) && (!category || l.category === category));
      return <><div className="stx-h">Программы</div>
        <div className="mb-3 flex flex-wrap gap-2"><Chip tone={category ? 'slate' : 'emerald'} onClick={() => setCategory('')}>Все</Chip>
          {STORE_CATEGORIES.map((c) => <Chip key={c.id} tone={category === c.id ? 'emerald' : 'slate'} onClick={() => setCategory(c.id)}>{c.name}</Chip>)}</div>
        {list.length ? <div className="stx-grid">{list.map((l, i) => <StoreCard key={l.moduleId} listing={l} index={i} onOpen={open} onAct={onAct} />)}</div>
          : <div className="stx-note">В категории «{categoryName(category)}» пока пусто.</div>}</>;
    }
    if (view === 'admin' && isAdmin) return <StoreAdmin />;
    if (view === 'journal' && develop && !isAdmin) return <ModuleJournalView moduleNames={Object.fromEntries(listings.map((l) => [l.moduleId, l.name]))} />;
    return <StoreLibrary key={view} initialTab={view === 'downloads' ? 'updates' : 'installed'} listings={listings} onOpen={open} onAct={onAct} onRemove={(l) => setDialog({ kind: 'remove', listing: l })} />;
  };

  return <div className="stx fx-glass" data-testid="stx">
    <nav className="stx-rail" aria-label="Store">
      {nav('home', 'Главная', <Home />)}
      {nav('apps', 'Программы', <LayoutGrid />)}
      <span className="stx-rail-sp" />
      {isAdmin && nav('admin', 'Админ', <Shield />)}
      {develop && !isAdmin && nav('journal', 'Журнал', <ScrollText />)}
      {nav('downloads', 'Загрузки', <Download />, downloads)}
      {nav('library', 'Библиотека', <Library />)}
    </nav>
    <div className="stx-main">
      <div className="stx-top">
        <div className="stx-search"><Search aria-hidden="true" />
          <input type="search" placeholder="Поиск программ" aria-label="Поиск программ" value={query} data-testid="stx-search"
            onChange={(e) => { setQuery(e.target.value); setSuggest(true); }} onFocus={() => setSuggest(true)} onBlur={() => setTimeout(() => setSuggest(false), 120)} />
          {suggest && query.trim() && found.length > 0 && <div className="stx-suggest" role="listbox">{found.slice(0, 5).map((l) =>
            <button key={l.moduleId} type="button" role="option" aria-selected="false" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(''); open(l); }}><ModuleIcon listing={l} size={28} />{l.name}<span className="ml-auto text-xs" style={{ color: 'var(--flux-text-muted)' }}>{categoryName(l.category)}</span></button>)}</div>}
        </div>
        <div className="stx-me">{user?.name}</div>
      </div>
      <div className="stx-scroll" ref={scroller}>
        {(offline || error) && <div className="stx-note" role="status">{offline ? 'Нет связи с базой: показано, что было загружено. Установленные программы работают с кэша, возврат к прошлой версии доступен.' : error}</div>}
        {toast && <div className="stx-note" role="status">{toast}</div>}
        {!local && loaded && <div className="stx-note">Этот Flux открыт в браузере: программы можно смотреть, а ставить — в программе Flux на компьютере.</div>}
        {!loaded ? <div className="stx-note">Загрузка витрины…</div> : body()}
      </div>
    </div>
    <StoreDialogs dialog={dialog} onClose={() => setDialog(null)} onDone={setToast} />
  </div>;
}
