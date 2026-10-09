/**
 * Книга типовых решений в окне: чтение, запись «по версии» и ответ на чужую
 * правку. Все вкладки каталога пишут через `run`, чтобы устаревшая версия
 * везде вела себя одинаково: книга перечитывается, действие не применяется.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { E3SolutionBook } from '../../../e3/solutionTypes';
import { e3SolutionsService as svc, E3SolutionVersionError } from '../../services/e3SolutionsService';
import { onE3Changed } from '../../lib/e3Changed';

// Серверный текст 409 кончается словом «Обновите»: окно само перечитывает книгу, так что говорит, что уже сделано
export const STALE = 'Каталог типовых решений изменён коллегой — он перечитан, повторите действие.';

export function useSolutionBook() {
  const [book, setBook] = useState<E3SolutionBook | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const liveReloadPending = useRef(false);

  const reload = useCallback(async () => {
    try { setBook(await svc.load()); setError(''); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const hasOpenDialog = () => !!document.querySelector('[role="dialog"]');
    const refresh = (detail?: { entity?: string }) => {
      if (detail?.entity && detail.entity !== 'solutions') return;
      if (hasOpenDialog()) { liveReloadPending.current = true; return; }
      liveReloadPending.current = false;
      void reload();
    };
    const off = onE3Changed(refresh);
    const observer = new MutationObserver(() => {
      if (liveReloadPending.current && !hasOpenDialog()) refresh({ entity: 'solutions' });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { off(); observer.disconnect(); };
  }, [reload]);

  /** Одна запись. `onError` получает текст, если действие идёт из диалога со своей строкой ошибки */
  const run = useCallback(async (op: (version: number) => Promise<{ book: E3SolutionBook }>, onError?: (text: string) => void): Promise<boolean> => {
    if (!book) return false;
    setBusy(true);
    try {
      const r = await op(book.version);
      setBook(r.book); setError(''); onError?.('');
      return true;
    } catch (e: any) {
      const stale = e instanceof E3SolutionVersionError;
      (onError || setError)(stale ? STALE : e.message);
      if (stale) await reload();
      return false;
    } finally { setBusy(false); }
  }, [book, reload]);

  return { book, setBook, error, setError, busy, setBusy, reload, run };
}
export type SolutionBookState = ReturnType<typeof useSolutionBook>;
