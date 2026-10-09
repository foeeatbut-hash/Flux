import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onWindowsFilesChanged, windowsFilesRequest, type WindowsFileEntry, type WindowsFileRef, type WindowsRoot } from '../../lib/windowsFiles';

/**
 * Список папки через мост: страницы, наблюдатель за изменениями, обновление без
 * потерь.
 *
 * Раньше обновление (`loadList(0)`) заменяло список первой страницей: всё, что
 * человек успел подгрузить кнопкой «Показать ещё», исчезало, а вместе с ним
 * терялась и прокрутка. Здесь обновление перечитывает столько страниц, сколько
 * уже показано, и возвращает прокрутку на место; выделение держит
 * `useSelection` по `fileId` и имени, ему достаточно получить новый список.
 */

export type FolderListing = { root?: WindowsRoot; entries: WindowsFileEntry[]; nextOffset: number | null; truncated: boolean };
const PAGE = 200;
// Один и тот же пустой список: новый массив на каждый рендер перезапускал бы всё, что на него смотрит
const NONE: WindowsFileEntry[] = [];

/** Папка как ключ: пока он тот же, обновление тихое, когда другой — список сбрасывается. */
export const folderKey = (ref: WindowsFileRef | null) => ref ? `${ref.rootId}\u0000${ref.relativePath}\u0000${ref.draftId || ''}` : '';

/** Событие касается этой папки: изменился её состав или она сама. */
export function changeTouches(ref: WindowsFileRef, change: { rootId: string; relativePath: string }): boolean {
  if (change.rootId !== ref.rootId) return false;
  const parent = change.relativePath.split('/').slice(0, -1).join('/');
  return parent === ref.relativePath || change.relativePath === ref.relativePath;
}

export function useFolder(ref: WindowsFileRef | null, enabled: boolean) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const reached = useRef<number | null>(null);
  const savedScroll = useRef<number | null>(null);
  const key = folderKey(ref);
  const hadListing = useRef(false);
  const refRef = useRef(ref); refRef.current = ref;

  /**
   * Прочитать папку сначала до позиции `until` (null — до конца). Позиция, а не
   * число объектов: мост отсчитывает страницы по своему списку, и объекты,
   * которые он не смог прочитать, сдвинули бы счёт.
   */
  const fetchPages = useCallback(async (folder: WindowsFileRef, until: number | null): Promise<FolderListing> => {
    let result: FolderListing | null = null;
    const entries: WindowsFileEntry[] = [];
    let offset: number | null = 0;
    while (offset !== null && (result === null || until === null || offset < until)) {
      const response = await windowsFilesRequest<FolderListing>({ action: 'list', ref: folder, offset, limit: PAGE });
      if ('error' in response) throw new Error(response.error.message);
      result = response.data; entries.push(...response.data.entries); offset = response.data.nextOffset;
    }
    return { ...result!, entries, nextOffset: offset };
  }, []);

  const load = useCallback(async (mode: 'fresh' | 'refresh' | 'more') => {
    const folder = refRef.current;
    if (!folder) return;
    const id = ++request.current;
    setLoading(true); setError('');
    try {
      let data: FolderListing;
      if (mode === 'more') {
        if (reached.current === null) return;
        const next = await windowsFilesRequest<FolderListing>({ action: 'list', ref: folder, offset: reached.current, limit: PAGE });
        if ('error' in next) throw new Error(next.error.message);
        if (id !== request.current) return;
        setListing((previous) => previous ? { ...next.data, entries: [...previous.entries, ...next.data.entries] } : next.data);
        return;
      }
      // Тихое обновление: сколько показано, столько и перечитываем, прокрутку запоминаем
      if (mode === 'refresh') savedScroll.current = scrollRef.current?.scrollTop ?? null;
      data = await fetchPages(folder, mode === 'refresh' && hadListing.current ? reached.current : 0);
      if (id !== request.current) return;
      setListing(data);
    } catch (cause: any) {
      if (id === request.current) { setListing(null); setError(cause?.message || 'Не удалось прочитать папку'); }
    } finally { if (id === request.current) setLoading(false); }
  }, [fetchPages]);

  reached.current = listing?.nextOffset ?? null;
  hadListing.current = !!listing;

  // Другая папка — список с нуля: чужие объекты не должны мелькать в новой
  useEffect(() => {
    request.current++; savedScroll.current = null;
    setListing(null); setError(''); setLoading(false);
    if (ref && enabled) void load('fresh');
  }, [key, enabled, load]);

  // Прокрутка возвращается после того, как новый список лёг в разметку
  useLayoutEffect(() => {
    if (savedScroll.current !== null && scrollRef.current) scrollRef.current.scrollTop = savedScroll.current;
    savedScroll.current = null;
  }, [listing]);

  // Наблюдатель: подписка на папку в мосту и перечитывание при её изменении
  useEffect(() => {
    if (!ref || !enabled) return;
    const watched = ref;
    void windowsFilesRequest({ action: 'watch', ref: watched });
    const stop = onWindowsFilesChanged((change) => { if (changeTouches(watched, change)) void load('refresh'); });
    return () => { stop(); void windowsFilesRequest({ action: 'unwatch', ref: watched }); };
  }, [key, enabled, load]);

  const loadAll = useCallback(async () => {
    const folder = refRef.current; if (!folder) return;
    const id = ++request.current; setLoading(true); setError('');
    try { const data = await fetchPages(folder, null); if (id === request.current) setListing(data); }
    catch (cause: any) { if (id === request.current) setError(cause?.message || 'Не удалось прочитать папку целиком'); }
    finally { if (id === request.current) setLoading(false); }
  }, [fetchPages]);
  return {
    loadAll, listing, entries: listing?.entries ?? NONE, loading, error, setError, scrollRef,
    nextOffset: listing?.nextOffset ?? null,
    reload: useCallback(() => load('refresh'), [load]),
    loadMore: useCallback(() => load('more'), [load]),
  };
}
