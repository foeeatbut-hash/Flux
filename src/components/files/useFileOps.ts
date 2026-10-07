import { useCallback, useState, useSyncExternalStore } from 'react';
import { useToastStore } from '../../store/toastStore';
import { windowsFilesRequest, type WindowsFileEntry, type WindowsFileRef } from '../../lib/windowsFiles';
import type { BridgeRequest } from './createEntry';
import { getClip, makeClip, pasteClip, setClip, subscribeClip, trashEntries, trashQuestion, type OpResult } from './fileOps';

/**
 * Буфер обмена и корзина для экрана файлов: вызывает `fileOps`, сообщает
 * человеку итог и просит экран перечитать папку.
 */
export function useFileOps({ rootId, folder, names, reload, request = windowsFilesRequest, confirm = (text: string) => window.confirm(text) }: {
  rootId: string;
  /** Открытая папка: в неё вставляют */
  folder: WindowsFileRef | null;
  /** Имена в ней — для свободного имени копии */
  names: string[];
  reload: () => Promise<void> | void;
  request?: BridgeRequest;
  confirm?: (text: string) => boolean;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const clip = useSyncExternalStore(subscribeClip, getClip, getClip);
  const [working, setWorking] = useState(false);

  /** Итог одним сообщением: удача и неудача не должны теряться друг за другом. */
  const report = useCallback((result: OpResult, success: string) => {
    if (result.done && !result.failed.length) addToast(success, 'success');
    if (result.failed.length) {
      const first = result.failed.slice(0, 3).map((item) => `«${item.name}»: ${item.message}`).join('; ');
      const rest = result.failed.length > 3 ? ` и ещё ${result.failed.length - 3}` : '';
      addToast(`${result.done ? `Выполнено: ${result.done}. ` : ''}Не удалось: ${first}${rest}`, 'error');
    }
  }, [addToast]);

  const run = useCallback(async (job: () => Promise<OpResult>, success: string): Promise<OpResult | null> => {
    setWorking(true);
    try { const result = await job(); report(result, success); return result; }
    catch (cause: any) { addToast(cause?.message || 'Не удалось выполнить действие', 'error'); return null; }
    finally { setWorking(false); await reload(); }
  }, [addToast, reload, report]);

  const take = useCallback(async (entries: WindowsFileEntry[], cut: boolean) => {
    if (!rootId || !entries.length) return;
    setClip(await makeClip(request, entries, rootId, cut));
  }, [rootId, request]);

  const paste = useCallback(async () => {
    const clipped = getClip();
    if (!clipped || !folder) return;
    const single = clipped.items.length === 1;
    const result = await run(() => pasteClip(request, clipped, folder, names), clipped.cut ? (single ? 'Объект перемещён' : `Перемещено объектов: ${clipped.items.length}`) : (single ? 'Копия создана' : `Скопировано объектов: ${clipped.items.length}`));
    // Вырезанное уехало — буфер выполнил своё; в нём остаются только те, что не удалось перенести.
    // Скопированное остаётся целиком: вставлять можно снова
    if (clipped.cut && result) {
      const left = clipped.items.filter((item) => result.failed.some((failed) => failed.name === item.name));
      setClip(left.length ? { ...clipped, items: left } : null);
    }
  }, [folder, names, request, run]);

  const trash = useCallback(async (entries: WindowsFileEntry[]) => {
    if (!rootId || !entries.length || !confirm(trashQuestion(entries))) return false;
    await run(() => trashEntries(request, rootId, entries), entries.length === 1 ? 'Объект перемещён в корзину' : `В корзину перемещено объектов: ${entries.length}`);
    return true;
  }, [rootId, request, confirm, run]);

  return {
    clip, working, paste, trash,
    copy: (entries: WindowsFileEntry[]) => take(entries, false),
    cut: (entries: WindowsFileEntry[]) => take(entries, true),
    clear: () => setClip(null),
  };
}
