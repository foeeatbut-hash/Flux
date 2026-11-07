/**
 * Подпрограммы из Flux Store в реестре разделов.
 *
 * Встроенные разделы объявлены в `sections.tsx` один раз, а установленные из
 * Store меняются в живой сессии: поставил — появилась в «Пуске», удалил —
 * исчезла. Поэтому реестр дополняется на лету, а версия реестра лежит в
 * крошечном хранилище без зависимостей: от неё зависят списки разделов
 * (`useAppContext`), и подтянуть сюда `sections.tsx` значило бы получить
 * круговой импорт.
 */
import { create } from 'zustand';
import type { ModuleManifest } from '../../modules/contract';

export interface InstalledModule { manifest: ModuleManifest; version: string; channel: 'test' | 'production'; author?: string }

interface SectionsVersion { version: number; items: InstalledModule[]; bump: (items: InstalledModule[]) => void }

/** Версия растёт при каждом изменении набора установленных; на неё подписаны списки разделов */
export const useSectionsVersion = create<SectionsVersion>((set) => ({
  version: 0, items: [],
  bump: (items) => set((s) => ({ version: s.version + 1, items })),
}));

/** Установленные подпрограммы — для карточек оборудования и тегов (ModuleLaunchActions) и ModuleHost */
export const installedModules = (): InstalledModule[] => useSectionsVersion.getState().items;
export const useInstalledModules = (): InstalledModule[] => useSectionsVersion((s) => s.items);

/** Новый набор не перерисовывает ничего, если он тот же: id, версия и название */
export const sameInstalled = (a: InstalledModule[], b: InstalledModule[]) =>
  a.length === b.length && a.every((x, i) => x.manifest.id === b[i].manifest.id && x.version === b[i].version && x.manifest.name === b[i].manifest.name && x.channel === b[i].channel && x.author === b[i].author);
