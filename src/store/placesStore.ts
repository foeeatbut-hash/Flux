/**
 * Места Проводника: подключённые корни, диски, облачные папки и Быстрый доступ
 * Windows. Их читают панель навигации и адресная строка, и читать каждой по
 * отдельности значило бы дважды спрашивать мост об одном и том же.
 *
 * Список общий на всё приложение: Быстрый доступ и диски не принадлежат окну.
 * Закрепление идёт через мост, а список после него перечитывается — так
 * человек видит то, что записала Windows, а не то, что мы себе вообразили.
 */
import { create } from 'zustand';
import {
  windowsFilesRequest,
  type WindowsCloudRoot, type WindowsCloudRoots, type WindowsFileRef, type WindowsQuickAccessItem, type WindowsQuickAccessList,
  type WindowsRoot, type WindowsVolume,
} from '../lib/windowsFiles';

interface PlacesState {
  roots: WindowsRoot[];
  volumes: WindowsVolume[];
  cloud: WindowsCloudRoot[];
  quick: WindowsQuickAccessItem[];
  /** false — Windows не отдала Быстрый доступ (не Windows или помощник не отвечает): панель покажет известные папки */
  quickSupported: boolean;
  loaded: boolean;
  error: string;
  load: (force?: boolean) => Promise<void>;
  pin: (ref: WindowsFileRef, pinned: boolean) => Promise<{ ok: boolean; message?: string }>;
  /** Окно выбора папки; выбранная становится подключённым местом. null — человек передумал или мост отказал */
  connect: () => Promise<WindowsRoot | null>;
}

let running: Promise<void> | null = null;

export const usePlacesStore = create<PlacesState>((set, get) => ({
  roots: [], volumes: [], cloud: [], quick: [], quickSupported: false, loaded: false, error: '',
  load: (force = false) => {
    if (running) return running;
    if (get().loaded && !force) return Promise.resolve();
    running = (async () => {
      // Четыре независимых вопроса: сбой облачных папок не должен прятать диски
      const [roots, volumes, cloud, quick] = await Promise.all([
        windowsFilesRequest<WindowsRoot[]>({ action: 'roots' }),
        windowsFilesRequest<WindowsVolume[]>({ action: 'volumes' }),
        windowsFilesRequest<WindowsCloudRoots>({ action: 'cloudRoots' }),
        windowsFilesRequest<WindowsQuickAccessList>({ action: 'quickAccess' }),
      ]);
      const cloudList = 'data' in cloud && cloud.data.supported ? cloud.data.items : [];
      const quickList = 'data' in quick && quick.data.supported ? quick.data.items : [];
      set({
        roots: 'data' in roots ? roots.data : [],
        volumes: 'data' in volumes ? volumes.data : [],
        cloud: cloudList,
        quick: quickList,
        quickSupported: 'data' in quick && quick.data.supported,
        loaded: true,
        error: 'error' in roots ? roots.error.message : '',
      });
    })().finally(() => { running = null; });
    return running;
  },
  pin: async (ref, pinned) => {
    const answer = await windowsFilesRequest({ action: 'quickAccessPin', ref, pinned });
    if ('error' in answer) return { ok: false, message: answer.error.message };
    await get().load(true);
    return { ok: true };
  },
  connect: async () => {
    const answer = await windowsFilesRequest<WindowsRoot | { canceled: true }>({ action: 'addRoot' });
    if (!('data' in answer) || 'canceled' in answer.data) return null;
    await get().load(true);
    return answer.data;
  },
}));
