/**
 * Сколько обращений ждут этого человека.
 *
 * Счётчик живёт в общей базе, а не в памяти окна: в отделе у каждого свой
 * встроенный сервер, и «сколько непрочитанного» — вопрос к базе, а не к своему
 * процессу. Сокет здесь только ускоряет: он подсказывает «пересчитай», а число
 * всё равно приходит из базы. Потерянный толчок поэтому ничего не ломает —
 * опрос догонит.
 *
 * Опрос редкий и по видимости окна: значок на панели задач не стоит того,
 * чтобы дёргать базу каждые пять секунд с полусотни рабочих мест.
 */

import { create } from 'zustand';
import { getUnread } from '../feedback/feedbackApi';

/** Как часто спрашивать только ради значка. */
export const BADGE_POLL_MS = 30000;
/** Скрытое окно спрашивает вдвое реже. */
export const HIDDEN_POLL_MS = 60000;

interface Unread { mine: number; queue: number; total: number }

interface FeedbackState {
  unread: Unread;
  /** Растёт на каждое изменение: по нему открытые списки перечитывают себя. */
  revision: number;
  refresh: () => Promise<void>;
  /** Пришло событие об изменении карточки. */
  touched: () => void;
  startPolling: () => void;
  stopPolling: () => void;
  reset: () => void;
}

let timer: any = null;
let onVisible: (() => void) | null = null;

export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  unread: { mine: 0, queue: 0, total: 0 },
  revision: 0,

  refresh: async () => {
    try {
      const counts = await getUnread();
      set({ unread: {
        mine: Math.max(0, counts?.mine | 0),
        queue: Math.max(0, counts?.queue | 0),
        total: Math.max(0, counts?.total | 0),
      } });
    } catch (_) {
      // Сервер не ответил — оставляем прежнее число. Обнулять его значит
      // сказать «всё разобрано», чего никто не проверял
    }
  },

  touched: () => {
    set((state) => ({ revision: state.revision + 1 }));
    void get().refresh();
  },

  startPolling: () => {
    get().stopPolling();
    const tick = () => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!hidden) void get().refresh();
      timer = setTimeout(tick, hidden ? HIDDEN_POLL_MS : BADGE_POLL_MS);
    };
    void get().refresh();
    timer = setTimeout(tick, BADGE_POLL_MS);
    // Вернулись к окну — перечитываем сразу: ждать полминуты после возврата
    // человек воспринимает как «программа не знает про новое»
    onVisible = () => { if (document.visibilityState === 'visible') void get().refresh(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  },

  stopPolling: () => {
    clearTimeout(timer);
    timer = null;
    if (onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    onVisible = null;
  },

  reset: () => { get().stopPolling(); set({ unread: { mine: 0, queue: 0, total: 0 }, revision: 0 }); },
}));
