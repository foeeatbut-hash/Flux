/**
 * Каталог в окне: одна копия на все разделы.
 *
 * Каталог нужен и «Каталогу», и «Конструктору», и открыт может быть в
 * нескольких окнах сразу. Грузить его в каждое окно своим запросом — значит
 * держать несколько разных копий справочника, и правка в одном окне не
 * доезжала бы до подбора в другом. Здесь одна копия и метка версии: окно
 * перечитывает каталог, только когда метка на сервере сменилась.
 */
import { create } from 'zustand';
import type { Catalog, Family, EquipmentClass } from '../../catalog/model';
import type { Learned } from '../../catalog/match';
import { catalogService, type CatalogMeta, type StoredTemplate } from '../services/catalogService';

const EMPTY: Catalog = { classes: [], manufacturers: [], families: [], components: [], tagRules: [] };

interface CatalogState {
  catalog: Catalog;
  meta: CatalogMeta;
  stamp: string;
  loaded: boolean;
  loading: boolean;
  error: string;
  learned: Array<Learned & { id: string; classId: string }>;
  templates: StoredTemplate[];
  /** Перечитать, если на сервере другая версия (или принудительно) */
  load: (force?: boolean) => Promise<void>;
  loadLearned: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  /** Правка своей рукой — подставить сразу, не дожидаясь перечитывания */
  putFamily: (f: Family) => void;
}

let inflight: Promise<void> | null = null;

export const useCatalogStore = create<CatalogState>((set, get) => ({
  catalog: EMPTY,
  meta: {},
  stamp: '',
  loaded: false,
  loading: false,
  error: '',
  learned: [],
  templates: [],

  load: async (force = false) => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (get().loaded && !force) {
          const { stamp } = await catalogService.stamp();
          if (stamp === get().stamp) return;
        }
        set({ loading: true, error: '' });
        const res = await catalogService.catalog();
        const { meta, stamp, ...cat } = res as any;
        set({ catalog: cat as Catalog, meta: meta || {}, stamp: stamp || '', loaded: true, loading: false });
      } catch (e: any) {
        set({ loading: false, error: e?.message || 'Каталог не загрузился' });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  loadLearned: async () => {
    try { set({ learned: (await catalogService.learned()).learned }); } catch { /* подбор обойдётся без выученного */ }
  },

  loadTemplates: async () => {
    try { set({ templates: (await catalogService.templates()).templates }); } catch (e: any) { set({ error: e?.message || '' }); }
  },

  putFamily: (f) => {
    const cat = get().catalog;
    const families = cat.families.some((x) => x.id === f.id) ? cat.families.map((x) => (x.id === f.id ? f : x)) : [...cat.families, f];
    set({ catalog: { ...cat, families } });
  },
}));

/** Семейство по id без подписки на весь каталог */
export const familyOf = (c: Catalog, id?: string): Family | undefined => (id ? c.families.find((f) => f.id === id) : undefined);
export const classOf = (c: Catalog, id?: string): EquipmentClass | undefined => (id ? c.classes.find((x) => x.id === id) : undefined);
