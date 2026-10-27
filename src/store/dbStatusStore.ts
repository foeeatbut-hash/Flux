/**
 * Опрос связи с базой — один на всё приложение.
 *
 * Панелей задач может быть несколько (по одной на монитор), а замер должен
 * быть один: иначе три монитора — три опроса и три тоста об одном обрыве.
 * Опрос живёт, пока смонтирован хоть один индикатор (`subscribe`).
 */
import { create } from 'zustand';
import { useToastStore } from './toastStore';
import { pollDelay, pushSample, stateOf, type DbSample, type DbState } from '../lib/dbStatus';

interface Info { version: string; mode: string; dialect: string; uptime: number }

interface DbStatusState {
  samples: DbSample[];
  state: DbState;
  info: Info | null;
  checkNow: () => Promise<void>;
  subscribe: () => () => void;
}

const TIMEOUT_MS = 8_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let users = 0;
let inflight: Promise<void> | null = null;

export const useDbStatusStore = create<DbStatusState>((set, get) => {
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (!users) { timer = null; return; }
    timer = setTimeout(() => { void get().checkNow(); }, pollDelay(get().state));
  };

  const measure = async (): Promise<{ sample: DbSample; info: Info | null }> => {
    const at = Date.now();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const started = performance.now();
    try {
      const r = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
      const rtt = Math.round(performance.now() - started);
      const d = await r.json().catch(() => ({} as any));
      const dbMs = typeof d?.dbMs === 'number' ? d.dbMs : null;
      return {
        sample: { at, reached: true, dbOk: r.ok && d?.ok !== false, rtt, dbMs },
        info: { version: String(d?.version || ''), mode: String(d?.databaseMode || ''), dialect: String(d?.dialect || ''), uptime: Number(d?.uptime) || 0 },
      };
    } catch {
      return { sample: { at, reached: false, dbOk: false, rtt: null, dbMs: null }, info: null };
    } finally {
      clearTimeout(t);
    }
  };

  return {
    samples: [],
    state: 'checking',
    info: null,

    checkNow: () => {
      if (inflight) return inflight;
      inflight = (async () => {
        const { sample, info } = await measure();
        const before = get().state;
        const samples = pushSample(get().samples, sample);
        const state = stateOf(samples);
        set({ samples, state, ...(info ? { info } : {}) });
        announce(before, state);
      })().finally(() => { inflight = null; schedule(); });
      return inflight;
    },

    subscribe: () => {
      users++;
      if (users === 1) {
        void get().checkNow();
        // Сеть вернулась или окно снова на виду — проверить сразу, а не ждать опроса
        window.addEventListener('online', onWake);
        document.addEventListener('visibilitychange', onWake);
      }
      return () => {
        users = Math.max(0, users - 1);
        if (!users) {
          if (timer) clearTimeout(timer);
          timer = null;
          window.removeEventListener('online', onWake);
          document.removeEventListener('visibilitychange', onWake);
        }
      };
    },
  };
});

function onWake() {
  if (document.visibilityState === 'visible') void useDbStatusStore.getState().checkNow();
}

const BAD: DbState[] = ['offline', 'db-down'];

/**
 * Обрыв нельзя показывать только точкой в углу: человек продолжит печатать
 * и потеряет правку. Поэтому смена «есть связь → нет» и обратно — тостом,
 * один раз на переход, а не на каждый замер
 */
function announce(before: DbState, after: DbState) {
  if (before === after) return;
  const toast = useToastStore.getState().addToast;
  if (BAD.includes(after) && !BAD.includes(before)) {
    toast(after === 'offline'
      ? 'Связь с сервером потеряна. Изменения не сохранятся, пока она не вернётся.'
      : 'Сервер не может достучаться до базы. Изменения не сохранятся — сообщите администратору.', 'error', undefined, 'db-status');
  } else if (!BAD.includes(after) && BAD.includes(before) && before !== 'checking') {
    toast('Связь с базой восстановлена.', 'success', undefined, 'db-status');
  }
}
