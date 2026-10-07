import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onWindowsFilesSearch, windowsFilesRequest, type WindowsFileRef, type WindowsSearchHit, type WindowsSearchStop } from '../../lib/windowsFiles';
import type { Place, PlaceCatalog } from './places';
import { NO_FILTERS, toBridgeFilters, type SearchUi } from './searchFilters';

/**
 * Поиск по месту через мост: запрос уходит сразу, результаты приходят страницами
 * событием, остановить можно в любой момент.
 *
 * Номер запроса задаёт интерфейс, а не мост: событие с чужим номером (старый
 * поиск, другое окно) отбрасывается, и результаты прошлого запроса не
 * смешиваются с новыми. Вышел из места — поиск гаснет, как в Проводнике.
 */

const MAX_HITS = 5000;
let counter = 0;
const nextId = () => `s-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export interface SearchResults {
  /** Поиск «включён»: в окне вместо папки показывают результаты */
  active: boolean;
  query: string;
  status: 'idle' | 'running' | 'done';
  hits: WindowsSearchHit[];
  scanned: number;
  reason?: WindowsSearchStop;
  error: string;
}
const IDLE: SearchResults = { active: false, query: '', status: 'idle', hits: [], scanned: 0, error: '' };

/** Где искать: у папки — она сама, у виртуальных мест — их содержимое. */
export function searchScopes(place: Place, catalog: PlaceCatalog, pinned: WindowsFileRef[] = []): WindowsFileRef[] {
  if (place.ref) return [place.ref];
  if (place.kind === 'computer') return catalog.volumes.filter((volume) => volume.kind !== 'network').map((volume) => ({ rootId: volume.root.id, relativePath: '' }));
  if (place.kind === 'network') {
    const roots = [...catalog.volumes.filter((volume) => volume.kind === 'network').map((volume) => volume.root.id), ...catalog.roots.filter((root) => root.network).map((root) => root.id)];
    return [...new Set(roots)].map((rootId) => ({ rootId, relativePath: '' }));
  }
  return pinned;
}

export function useExplorerSearch(scopes: WindowsFileRef[], scopeKey: string) {
  const [results, setResults] = useState<SearchResults>(IDLE);
  const [ui, setUi] = useState<SearchUi>(NO_FILTERS);
  const [query, setQuery] = useState('');
  const open = useRef(new Set<string>());
  const reasons = useRef<WindowsSearchStop[]>([]);
  const scopesRef = useRef(scopes); scopesRef.current = scopes;

  const cancel = useCallback(() => {
    const ids = [...open.current];
    // Остановили сами: страницы, что уже пришли, остаются, а «закончено» объявляем без ожидания
    open.current = new Set();
    for (const requestId of ids) void windowsFilesRequest({ action: 'searchCancel', requestId });
    setResults((state) => state.status === 'running' ? { ...state, status: 'done', reason: 'canceled' } : state);
  }, []);

  const clear = useCallback(() => {
    for (const requestId of open.current) void windowsFilesRequest({ action: 'searchCancel', requestId });
    open.current = new Set(); reasons.current = [];
    setResults(IDLE); setQuery(''); setUi(NO_FILTERS);
  }, []);

  const run = useCallback((text: string, filters: SearchUi) => {
    for (const requestId of open.current) void windowsFilesRequest({ action: 'searchCancel', requestId });
    open.current = new Set(); reasons.current = [];
    const bridgeFilters = toBridgeFilters(filters);
    const empty = !text.trim() && !Object.keys(bridgeFilters).length;
    if (empty) { setResults(IDLE); return; }
    const targets = scopesRef.current;
    if (!targets.length) { setResults({ ...IDLE, active: true, query: text, status: 'done', error: 'Здесь нечего искать: место не содержит папок Windows.' }); return; }
    const ids = targets.map(() => nextId());
    ids.forEach((id) => open.current.add(id));
    setResults({ active: true, query: text, status: 'running', hits: [], scanned: 0, error: '' });
    targets.forEach((ref, index) => {
      void windowsFilesRequest({ action: 'search', ref, requestId: ids[index], query: text.trim(), filters: bridgeFilters }).then((answer) => {
        if (!('error' in answer) || !open.current.has(ids[index])) return;
        // Мост отказал сразу (нет прав, нет папки): этот запрос закончен, остальные продолжают
        open.current.delete(ids[index]);
        setResults((state) => ({ ...state, status: open.current.size ? state.status : 'done', error: answer.error.message }));
      });
    });
  }, []);

  useEffect(() => onWindowsFilesSearch((event) => {
    if (!open.current.has(event.requestId)) return;
    if (event.done) { open.current.delete(event.requestId); if (event.reason) reasons.current.push(event.reason); }
    setResults((state) => {
      const hits = event.hits.length ? [...state.hits, ...event.hits].slice(0, MAX_HITS) : state.hits;
      const finished = event.done && open.current.size === 0;
      const reason = finished ? (reasons.current.find((item) => item !== 'complete') ?? 'complete') : state.reason;
      return { ...state, hits, scanned: event.scanned, status: finished ? 'done' : state.status, reason, error: event.error?.message || state.error };
    });
  }), []);

  // Ушли в другое место — поиск и его строка гаснут; закрыли окно — останавливаем то, что ещё идёт
  useEffect(() => { clear(); }, [scopeKey, clear]);
  useEffect(() => () => { for (const requestId of open.current) void windowsFilesRequest({ action: 'searchCancel', requestId }); }, []);

  return useMemo(() => ({ results, query, ui, setQuery, setUi, run, cancel, clear }), [results, query, ui, run, cancel, clear]);
}

export type ExplorerSearch = ReturnType<typeof useExplorerSearch>;
