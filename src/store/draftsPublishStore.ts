/**
 * Запрос на публикацию черновиков: что и куда. Его ставит Проводник (drop на
 * папку), дерево папок и меню панели; единственное окно подтверждения живёт
 * в слое панели «Черновики» (DraftPublishDialog). Так Проводнику не нужно
 * знать ни про окно, ни про порядок «перенести и опубликовать».
 */
import { create } from 'zustand';
import type { WindowsFileRef } from '../lib/windowsFiles';
import type { DraftDragItem } from '../lib/draftsActions';

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
