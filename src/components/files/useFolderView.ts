import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import { DEFAULT_VIEW, normalizeFolderView, type FolderView } from './viewModel';

const SAVE_DELAY = 350;
const storageKeyFor = (scope: string) => {
  const encoded = encodeURIComponent(scope);
  if (encoded.length <= 250) return `explorer.folderView.v1:${encoded}`;
  // Ключи моста ограничены 300 символами; длинный путь не должен отключать сохранение вида.
  let first = 14695981039346656037n; let second = 1099511628211n;
  for (const character of scope) { const code = BigInt(character.codePointAt(0)!); first = BigInt.asUintN(64, (first ^ code) * 1099511628211n); second = BigInt.asUintN(64, (second ^ code) * 14029467366897019727n); }
  return `explorer.folderView.v1:long:${first.toString(16)}:${second.toString(16)}`;
};
type Snapshot = { key: string; view: FolderView; hydrated: boolean };

/** Сохраняет вид папки и игнорирует запоздалый ответ для уже сменившейся папки. */
export function useFolderView(scope: string) {
  const key = useMemo(() => storageKeyFor(scope), [scope]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const sequence = useRef(0);
  const view = snapshot?.key === key ? snapshot.view : DEFAULT_VIEW;
  const hydrated = snapshot?.key === key && snapshot.hydrated;

  useEffect(() => {
    const request = ++sequence.current;
    let active = true;
    setSnapshot({ key, view: { ...DEFAULT_VIEW, columns: [...DEFAULT_VIEW.columns], widths: { ...DEFAULT_VIEW.widths } }, hydrated: false });
    void windowsFilesRequest<Record<string, unknown>>({ action: 'viewStateGet', keys: [key] }).then((answer) => {
      if (!active || sequence.current !== request) return;
      const saved = answer.ok ? answer.data[key] : undefined;
      setSnapshot({ key, view: normalizeFolderView(saved), hydrated: true });
    }).catch(() => {
      if (active && sequence.current === request) setSnapshot({ key, view: normalizeFolderView(undefined), hydrated: true });
    });
    return () => { active = false; };
  }, [key]);

  useEffect(() => {
    if (!hydrated || snapshot?.key !== key) return;
    const viewToSave = snapshot.view;
    const timer = setTimeout(() => {
      void windowsFilesRequest({ action: 'viewStateSet', entries: { [key]: viewToSave } });
    }, SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [key, hydrated, snapshot]);

  const setView = useCallback((next: FolderView | ((current: FolderView) => FolderView)) => {
    sequence.current++;
    setSnapshot((current) => {
      const base = current?.key === key ? current.view : DEFAULT_VIEW;
      const updated = typeof next === 'function' ? next(base) : next;
      return { key, view: normalizeFolderView(updated), hydrated: true };
    });
    // Помечает незавершённую загрузку устаревшей; токен проверяется при получении ответа.
  }, [key]);

  return { view, setView, storageKey: key, ready: hydrated };
}

export { storageKeyFor as folderViewStorageKey };
