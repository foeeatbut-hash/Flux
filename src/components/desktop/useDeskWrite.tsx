/**
 * Запись файла со стола с показом отказа: переименовать, убрать в корзину, переложить на общий стол.
 *
 * Стол шлёт версию файла, какой его показывал (`desktopStore`). Файл успел изменить или убрать
 * коллега — сервер отказывает, стол перечитывается, а здесь отказ открывается окном с перечнем
 * «поле: было → стало». Показанным считается файл, каким он был в столе в момент действия:
 * после перечитывания он уже чужой, поэтому берём его ДО записи. Окно и перечень — общие
 * (`components/equipment`), тексты — только от сервера; прочий отказ (сеть, нет права) — строка,
 * как раньше.
 */
import { useDesktopStore } from '../../store/desktopStore';
import { useRefusalDialog } from '../equipment/useRefusalDialog';
import type { WriteResult } from '../equipment/versionedWrite';
import type { DeskItem } from '../../lib/desktop';
import { fileRefusalOf, runWrite } from './desktopWrite';

export function useDeskWrite(projectId: string, toast: (text: string, kind: 'error') => void) {
  const refusals = useRefusalDialog(toast);

  const run = async (id: string, fallbackItem: DeskItem | undefined, title: string, fallback: string, write: () => Promise<void>): Promise<WriteResult> => {
    const state = useDesktopStore.getState();
    const shown = state.items.find((i) => i.id === id) ?? fallbackItem;
    const result = await runWrite(write, fallback);
    // Папки стола — те, что были при действии: перечитывание их не меняет, но берём до него
    const why = fileRefusalOf(result, shown, { sharedFolderId: state.sharedFolderId, personalFolderId: state.personalFolderId }, fallback);
    if (why) refusals.show(title, why);
    return result;
  };

  return {
    /** Переименовать; исход нужен полю имени: после отказа оно остаётся с набранным */
    rename: (id: string, name: string) =>
      run(id, undefined, 'Файл не переименован', 'Не удалось переименовать', () => useDesktopStore.getState().rename(id, name, projectId)),
    trash: (item: DeskItem) =>
      run(item.id, item, 'Файл не убран со стола', 'Не удалось убрать', () => useDesktopStore.getState().remove(item.id, projectId)),
    share: (item: DeskItem, to: 'SHARED' | 'PERSONAL') =>
      run(item.id, item, 'Файл не перенесён', 'Не удалось перенести', () => useDesktopStore.getState().share(item.id, to, projectId)),
    element: refusals.element,
  };
}
