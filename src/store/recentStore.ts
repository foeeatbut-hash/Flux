/**
 * Где живёт список недавних вещей.
 *
 * Правила — в src/lib/recentDocs.ts, здесь только хранение: список у каждого
 * свой и лежит в браузере. Это память рук, а не данные проекта: отправлять её
 * на сервер незачем, а делить с коллегами — тем более.
 *
 * Один список на все четыре редактора Flux Office. Заводить по списку на
 * редактор значило бы, что «недавние» в таблице и в просмотре разные, и
 * человек ищет документ там, где его нет.
 */
import { create } from 'zustand';
import { addRecent, forgetRecent, type RecentDoc } from '../lib/recentDocs';

const KEY = 'flux_recent_docs';

/**
 * Документы Конструктора (?doc=, ?fromFile=) уходят вместе с ним: Flux Office
 * правит файлы. Такая запись в Пуске вела бы в никуда — отбрасываем при чтении
 */
const live = (d: RecentDoc): boolean => !!d && typeof d.href === 'string' && !/[?&](doc|fromFile)=/.test(d.href);

const read = (): RecentDoc[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(live) : [];
  } catch (_) { return []; }
};

const write = (list: RecentDoc[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* приватный режим */ }
};

interface RecentState {
  docs: RecentDoc[];
  /** Запомнить открытое: зовётся самим редактором, когда документ уже назван */
  remember: (doc: RecentDoc) => void;
  forget: (href: string) => void;
}

export const useRecentStore = create<RecentState>((set, get) => ({
  docs: read(),
  remember: (doc) => {
    const docs = addRecent(get().docs, doc);
    if (docs === get().docs) return;
    write(docs);
    set({ docs });
  },
  forget: (href) => {
    const docs = forgetRecent(get().docs, href);
    write(docs);
    set({ docs });
  },
}));

/** Короткий путь для редакторов: звать из useEffect, когда имя уже известно */
export function rememberDoc(doc: RecentDoc): void {
  useRecentStore.getState().remember(doc);
}
