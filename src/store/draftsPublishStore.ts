/**
 * Запрос на публикацию черновиков: что и куда. Его ставит Проводник (drop на
 * папку), дерево папок и меню панели; единственное окно подтверждения живёт
 * в слое панели «Черновики» (DraftPublishDialog). Так Проводнику не нужно
 * знать ни про окно, ни про порядок «перенести и опубликовать».
 */
import { create } from 'zustand';
import type { WindowsFileRef } from '../lib/windowsFiles';
import type { DraftDragItem } from '../lib/draftsActions';
import { useDraftsSettings } from './draftsSettingsStore';
import { useToastStore } from './toastStore';

export interface DraftPublishRequest {
  items: DraftDragItem[];
  /** Папка назначения; null — та, где черновик лежит сейчас («Отобразить в Windows») */
  parent: WindowsFileRef | null;
  /** «Оставить копию» отмечена заранее — перетаскивание с Ctrl */
  keepCopy: boolean;
}

interface State {
  request: DraftPublishRequest | null;
  ask: (request: DraftPublishRequest) => void;
  clear: () => void;
}

export const useDraftsPublishStore = create<State>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  clear: () => set({ request: null }),
}));

/**
 * Черновик отпустили на папку Windows: Проводник и дерево зовут это одно место.
 * Выключенная настройка «Перетаскивание на папку публикует» не молчит: человек
 * увидит, почему ничего не произошло, и где это включить.
 */
export function offerDraftDrop(items: DraftDragItem[], parent: WindowsFileRef, keepCopy: boolean) {
  if (!useDraftsSettings.getState().dropPublish) {
    useToastStore.getState().addToast('Публикация перетаскиванием выключена в настройках панели «Черновики». Опубликуйте через меню черновика.', 'info');
    return;
  }
  useDraftsPublishStore.getState().ask({ items, parent, keepCopy });
}
