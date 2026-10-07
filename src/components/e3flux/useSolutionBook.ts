/**
 * Книга типовых решений в окне: чтение, запись «по версии» и ответ на чужую
 * правку. Все вкладки каталога пишут через `run`, чтобы устаревшая версия
 * везде вела себя одинаково: книга перечитывается, действие не применяется.
 */
import { useCallback, useEffect, useState } from 'react';
import type { E3SolutionBook } from '../../../e3/solutionTypes';
import { e3SolutionsService as svc, E3SolutionVersionError } from '../../services/e3SolutionsService';

// Серверный текст 409 кончается словом «Обновите»: окно само перечитывает книгу, так что говорит, что уже сделано
export const STALE = 'Каталог типовых решений изменён коллегой — он перечитан, повторите действие.';

export function useSolutionBook() {
  const [book, setBook] = useState<E3SolutionBook | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { setBook(await svc.load()); setError(''); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

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
