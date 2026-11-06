/**
 * Состояние Flux Store в окне: витрина с сервера и что стоит на этом компьютере.
 *
 * Установленные подпрограммы отсюда же попадают в реестр разделов
 * (`syncInstalledSections`): поставил — появилась в «Пуске» и карточках.
 */
import { create } from 'zustand';
import type { StoreListing } from '../../modules/store/model';
import type { LocalState } from '../services/moduleStoreService';
import { syncInstalledSections } from '../workspace/sections';

interface ModuleStoreState {
  listings: StoreListing[];
  autoUpdate: boolean;
  local: LocalState | null;
  loaded: boolean;
  /** Нет связи с сервером: показано то, что было, а установленное работает с кэша */
  offline: boolean;
  error: string;
  /** moduleId → что идёт сейчас («Скачивание…», «Проверка подписи…»); есть ключ — идёт загрузка */
  busy: Record<string, string>;
  set: (patch: Partial<ModuleStoreState>) => void;
  setBusy: (moduleId: string, text: string | null) => void;
  setLocal: (local: LocalState | null) => void;
}

export const useModuleStore = create<ModuleStoreState>((set) => ({
  listings: [], autoUpdate: false, local: null, loaded: false, offline: false, error: '', busy: {},
  set: (patch) => set(patch),
  setBusy: (moduleId, text) => set((s) => {
    const busy = { ...s.busy };
    if (text === null) delete busy[moduleId]; else busy[moduleId] = text;
    return { busy };
  }),
  setLocal: (local) => {
    set({ local });
    // Запускается только проверенное главным процессом: его манифесты и попадают в «Пуск»
    syncInstalledSections((local?.runnable || []).map((r) => ({ manifest: r.manifest, version: r.version, channel: r.channel, author: r.author })));
  },
}));
