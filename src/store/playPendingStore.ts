/**
 * Что человек нажал, но сервер ещё не подтвердил.
 *
 * Отдельно от подтверждённого состояния (`playStore`), и это главное решение
 * обоих файлов. Смешав их, мы получили бы экран, на котором «Приглашение
 * отправлено» написано раньше, чем оно отправлено; после отказа сервера
 * надпись пришлось бы забирать обратно, и человек видел бы, как программа
 * передумывает. Поэтому ожидание показывается ожиданием: «Отправляем…» —
 * и только ответ сервера превращает его в «Приглашение отправлено».
 *
 * Ключ идемпотентности живёт здесь же и не меняется между повторами одного и
 * того же намерения. Это и делает повтор повтором: тот же ключ — тот же
 * ответ, а не второе действие. Новый ключ заводится, когда человек нажал
 * снова ПОСЛЕ ответа, — это уже другое намерение.
 */
import { create } from 'zustand';
import { newKey } from '../services/playService';

/** Чем сейчас занята одна кнопка. */
export type Phase = 'idle' | 'sending' | 'done' | 'failed';

export interface Pending {
  phase: Phase;
  /** Ключ идемпотентности этого намерения */
  key: string;
  /** Отказ словами — рядом с той кнопкой, которую нажимали */
  message: string;
  /** Когда ответ получен: по нему «Отправлено» гаснет само */
  at: number;
}

const IDLE: Pending = { phase: 'idle', key: '', message: '', at: 0 };

/** Сколько держать отметку об успехе. Дольше — она превращается в мусор. */
export const DONE_MS = 2500;

interface PendingState {
  /** Состояние по действию: «invite:<userId>», «lobby.ready», … */
  byAction: Record<string, Pending>;
  /** Взять состояние действия; неизвестное — покой */
  of: (action: string) => Pending;
  /**
   * Выполнить действие один раз.
   *
   * Ключ выдаётся при первом нажатии и переиспользуется, пока ответа нет:
   * повторное нажатие «пока думает» не заводит второго действия — сервер
   * узнаёт тот же ключ и отвечает тем же.
   */
  run: <T>(action: string, work: (key: string) => Promise<{ ok: boolean; message?: string; result?: T }>) => Promise<T | null>;
  clear: (action: string) => void;
  reset: () => void;
}

export const usePlayPendingStore = create<PendingState>((set, get) => ({
  byAction: {},

  of: (action) => get().byAction[action] || IDLE,

  run: async (action, work) => {
    const cur = get().of(action);
    // Уже отправляем — второе нажатие ничего не меняет и ничего не портит
    if (cur.phase === 'sending') return null;

    const key = cur.phase === 'failed' && cur.key ? cur.key : newKey();
    set((s) => ({ byAction: { ...s.byAction, [action]: { phase: 'sending', key, message: '', at: 0 } } }));

    const res = await work(key);
    set((s) => ({
      byAction: {
        ...s.byAction,
        [action]: {
          phase: res.ok ? 'done' : 'failed',
          key,
          message: res.ok ? '' : String(res.message || 'Не получилось'),
          at: Date.now(),
        },
      },
    }));
    return res.ok ? ((res.result as any) ?? null) : null;
  },

  clear: (action) => set((s) => {
    const next = { ...s.byAction };
    delete next[action];
    return { byAction: next };
  }),

  reset: () => set({ byAction: {} }),
}));
