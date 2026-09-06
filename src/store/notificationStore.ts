import { create } from 'zustand';
import { dataService, AppNotification } from '../services/dataService';
import { freshOnes } from '../lib/notifCenter';

/**
 * Кому рассказать про новое уведомление — назначает оболочка.
 *
 * Хранилище не показывает всплывашек само: оно не знает ни про тихий режим, ни
 * про отложенное, и знать не должно — иначе состояние потянуло бы за собой
 * интерфейс. Оно только говорит «вот это пришло впервые».
 */
let freshSink: ((list: AppNotification[]) => void) | null = null;
export const onFreshNotifications = (fn: (list: AppNotification[]) => void) => { freshSink = fn; };

/** Что уже видели: по первому опросу всплывашек не показываем вовсе */
let seenIds: Set<string> | null = null;

// Ключ диалога из targetRoute уведомления ЧАТ: from=<id> или group=<id>
function convKey(n: AppNotification): string | null {
  const m = (n.targetRoute || '').match(/[?&](from|group)=([^&]+)/);
  return m ? `${m[1]}=${m[2]}` : null;
}

interface NotifState {
  personal: AppNotification[];
  unread: number;        // всего непрочитанных
  chatUnread: number;    // от скольких диалогов пришли сообщения
  /** Непрочитанные по диалогам: ключ «from=<id>» или «group=<id>» */
  chatUnreadByKey: Record<string, number>;
  loading: boolean;
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  togglePanel: () => void;
  fetch: (userId: string) => Promise<void>;
  /** Уведомление, пришедшее сокетом: тот же путь, что и у опроса */
  ingest: (list: AppNotification[]) => void;
  markAllRead: (userId: string) => Promise<void>;
  markConversationRead: (userId: string, key: string) => Promise<void>;
  startPolling: (userId: string) => void;
  stopPolling: () => void;
}

let pollTimer: any = null;
/** Как редко страховать толчок опросом */
export const POLL_MS = 60000;

const recompute = (list: AppNotification[]) => {
  const unread = list.filter(n => !n.isRead).length;
  // Считаем не только сколько диалогов ждут ответа, но и сколько в каждом:
  // без этого в списке чатов не показать, где именно накопилось
  const byKey: Record<string, number> = {};
  for (const n of list) {
    if (!n.isRead && n.category === 'ЧАТ') {
      const k = convKey(n);
      if (k) byKey[k] = (byKey[k] || 0) + 1;
    }
  }
  return { unread, chatUnread: Object.keys(byKey).length, chatUnreadByKey: byKey };
};

export const useNotificationStore = create<NotifState>((set, get) => ({
  personal: [],
  unread: 0,
  chatUnread: 0,
  chatUnreadByKey: {},
  loading: false,
  panelOpen: false,
  setPanelOpen: (v) => set({ panelOpen: v }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  fetch: async (userId) => {
    if (!userId) { seenIds = null; set({ personal: [], unread: 0, chatUnread: 0, chatUnreadByKey: {} }); return; }
    set({ loading: true });
    try {
      const list = await dataService.getNotifications(userId);
      // Первый опрос только запоминает: показать разом всё непрочитанное за
      // неделю — лучший способ добиться, чтобы уведомления закрывали не глядя
      if (seenIds === null) seenIds = new Set(list.map(n => n.id));
      else {
        const fresh = freshOnes(seenIds, list);
        for (const n of list) seenIds.add(n.id);
        if (fresh.length && freshSink) freshSink(fresh);
      }
      set({ personal: list, ...recompute(list), loading: false });
    } catch {
      set({ loading: false });
    }
  },
  /**
   * Принять уведомление, пришедшее толчком с сервера.
   *
   * Делает ровно то же, что `fetch` делает с полученным списком: отмечает
   * новое, пересчитывает счётчики, зовёт `freshSink`. Иначе всплывашка,
   * звук и окно Windows пришлось бы поднимать во втором месте, и два места
   * рано или поздно разошлись бы.
   *
   * Пока не было ни одного опроса (`seenIds === null`), толчок только
   * запоминается: показывать всплывашку до того, как человек увидел список,
   * — тот же случай, из-за которого первый опрос ничего не показывает.
   */
  ingest: (list) => {
    const incoming = (list || []).filter(Boolean);
    if (!incoming.length) return;
    const known = new Set(get().personal.map((n) => n.id));
    const added = incoming.filter((n) => !known.has(n.id));
    if (!added.length) return;
    if (seenIds === null) seenIds = new Set(added.map((n) => n.id));
    else {
      const fresh = freshOnes(seenIds, added);
      for (const n of added) seenIds.add(n.id);
      if (fresh.length && freshSink) freshSink(fresh);
    }
    // Новое сверху: список приходит от сервера в том же порядке
    const next = [...added, ...get().personal];
    set({ personal: next, ...recompute(next) });
  },

  markAllRead: async (userId) => {
    if (!userId) return;
    try {
      await dataService.markNotificationsRead(userId);
      const list = get().personal.map(n => ({ ...n, isRead: true }));
      set({ personal: list, ...recompute(list) });
    } catch {}
  },
  // Пометить прочитанными уведомления конкретного диалога (from=X / group=Y)
  markConversationRead: async (userId, key) => {
    if (!userId || !key) return;
    const toMark = get().personal.filter(n => !n.isRead && n.category === 'ЧАТ' && convKey(n) === key);
    if (toMark.length === 0) return;
    try {
      for (const n of toMark) { await dataService.markNotificationsRead(userId, n.id); }
      const ids = new Set(toMark.map(n => n.id));
      const list = get().personal.map(n => ids.has(n.id) ? { ...n, isRead: true } : n);
      set({ personal: list, ...recompute(list) });
    } catch {}
  },
  /**
   * Опрос — страховка, а не способ доставки.
   *
   * Основной путь теперь толчок сокетом (`notify:new` → `ingest`). Опрос
   * оставлен на случай, когда связи не было в самый миг события, и потому
   * стал редким; пока окно скрыто, страховать нечего — никто не смотрит.
   */
  startPolling: (userId) => {
    if (pollTimer) clearInterval(pollTimer);
    get().fetch(userId);
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      get().fetch(userId);
    }, POLL_MS);
  },
  stopPolling: () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } },
}));
