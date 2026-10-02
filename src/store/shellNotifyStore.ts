/**
 * Уведомления в оболочке: всплывашки, отложенное и тихий режим.
 *
 * Раздельно с notificationStore нарочно. Тот отвечает на вопрос «что мне
 * пришло» и разговаривает с сервером; этот — на вопрос «что показать сейчас и
 * чем это можно отодвинуть». Второе личное, живёт на этом рабочем месте и
 * серверу неизвестно: тихий режим — настройка внимания, а не событие проекта.
 *
 * Счёт — в src/lib/notifCenter.ts, там же он и проверяется.
 */
import { create } from 'zustand';
import {
  isQuiet, quietUntil, snoozeUntil, dueSnoozed,
  type NotifLike, type QuietId, type SnoozeId,
} from '../lib/notifCenter';

/** Всплывашка живёт своей жизнью: уведомление могло прийти и от напоминания */
export interface ShellToast {
  id: string;
  title: string;
  body?: string;
  /** Куда ведёт «Открыть» */
  route?: string;
  /** Откуда: уведомление программы или личное напоминание */
  source: 'notif' | 'reminder';
  /**
   * Своя кнопка карточки. Заведена ради встречи: напоминание за пять минут
   * бесполезно, если после него надо идти искать ссылку в переписке.
   */
  action?: { label: string; url: string };
  category?: string;
  at: number;
}

/** Отложенная карточка хранится целиком: среди напоминаний бывают не только уведомления сервера. */
export interface SnoozedToast { until: number; toast?: Omit<ShellToast, 'at'> }

const QUIET_KEY = 'flux_quiet_until';
const SNOOZE_KEY = 'flux_snoozed';

interface ShellNotifyState {
  toasts: ShellToast[];
  /** До какого времени молчим; null — слышно всё */
  quiet: number | null;
  /** Отложенные: номер уведомления → до какого времени спрятано */
  snoozed: Record<string, SnoozedToast>;

  /** Показать всплывашку. В тихом режиме — молча пропустить */
  push: (t: Omit<ShellToast, 'at'>) => void;
  dismiss: (id: string) => void;
  /** Отложить: убрать с глаз и вернуть в назначенный час */
  snooze: (id: string, choice: SnoozeId) => void;
  /** Вернуть отложенное, которому пора */
  releaseDue: () => { id: string; toast?: Omit<ShellToast, 'at'> }[];
  setQuiet: (choice: QuietId | null) => void;
}

const num = (key: string): number | null => {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? Number(raw) : 0;
    return v > Date.now() ? v : null;
  } catch (_) { return null; }
};

const loadSnoozed = (): Record<string, SnoozedToast> => {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, SnoozedToast> = {};
    for (const [id, value] of Object.entries(parsed)) {
      // Старые настройки хранили только срок. Сохраняем его до истечения;
      // новую карточку целиком записываем при следующем откладывании.
      const entry = typeof value === 'number' ? { until: value } : value as SnoozedToast;
      if (typeof entry?.until === 'number' && entry.until > Date.now()) {
        out[id] = { until: entry.until, ...(entry.toast ? { toast: entry.toast } : {}) };
      }
    }
    return out;
  } catch (_) { return {}; }
};

const saveSnoozed = (v: Record<string, SnoozedToast>) => {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(v)); } catch (_) { /* приватный режим */ }
};

export const useShellNotifyStore = create<ShellNotifyState>((set, get) => ({
  toasts: [],
  quiet: num(QUIET_KEY),
  snoozed: loadSnoozed(),

  push: (t) => {
    const { quiet, snoozed, toasts } = get();
    if (isQuiet(quiet)) return;
    if (snoozed[t.id]?.until > Date.now()) return;
    if (toasts.some((x) => x.id === t.id)) return;
    // Больше трёх на экране — это уже не уведомление, а стена: держим последние
    const next = [...toasts, { ...t, at: Date.now() }].slice(-3);
    set({ toasts: next });
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  snooze: (id, choice) => {
    const toast = get().toasts.find((t) => t.id === id);
    const snoozed = { ...get().snoozed, [id]: {
      until: snoozeUntil(choice),
      ...(toast ? { toast: (({ at: _at, ...payload }) => payload)(toast) } : {}),
    } };
    saveSnoozed(snoozed);
    set((s) => ({ snoozed, toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  releaseDue: () => {
    const entries = get().snoozed;
    const due = dueSnoozed(Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, value.until])));
    if (!due.length) return [];
    const snoozed = { ...get().snoozed };
    const released = due.map((id) => ({ id, toast: snoozed[id]?.toast }));
    for (const id of due) delete snoozed[id];
    saveSnoozed(snoozed);
    set({ snoozed });
    return released;
  },

  setQuiet: (choice) => {
    if (!choice) {
      try { localStorage.removeItem(QUIET_KEY); } catch (_) { /* приватный режим */ }
      set({ quiet: null });
      return;
    }
    const until = quietUntil(choice);
    try { localStorage.setItem(QUIET_KEY, String(until)); } catch (_) { /* приватный режим */ }
    // Всплывашки, висящие сейчас, убираем сразу: «не беспокоить» должно
    // замолчать немедленно, а не после того, как догорят прежние
    set({ quiet: until, toasts: [] });
  },
}));

/** Уведомление в всплывашку: одно место сборки на все источники */
export const toastOf = (n: NotifLike): Omit<ShellToast, 'at'> => ({
  id: n.id,
  title: n.title,
  body: n.body,
  route: n.targetRoute && n.targetRoute !== '#' ? n.targetRoute : undefined,
  source: 'notif',
  category: n.category,
});
