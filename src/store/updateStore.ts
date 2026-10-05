/**
 * Обновление программы: одно состояние на всю оболочку.
 *
 * Раньше про обновление знал только виджет в настройках, и потому узнать о нём
 * можно было, лишь зайдя в настройки и нажав «Проверить». Значку у часов
 * (панель задач) неоткуда было взять «доступно обновление», а виджету —
 * показать, что дело идёт, если человек ушёл в другой раздел.
 *
 * Поэтому состояние здесь, а не в разметке: и значок в трее, и раздел
 * настроек смотрят в одно место и говорят одно и то же.
 *
 * Установка — одно действие от начала до конца: скачать, проверить, закрыться,
 * подменить программу, запуститься заново. Человек нажимает один раз; всё
 * остальное — наше дело, а не его.
 */
import { create } from 'zustand';
import { getServerBaseUrl, getAuthToken } from '../config/env';
import { isNewer, fileUrlOf, blocker, type Phase } from '../lib/updates';
import { prepareSessionClose } from '../lib/closeGuard';

export interface Release {
  version: string;
  changelog: string;
  fileUrl: string;
  size?: number;
  /** Подпись владельца программы (FLUXUPD1…); без неё обновление не ставится */
  signature?: string;
}

/** Опубликованный релиз, у которого на сервере нет файла */
export interface BrokenRelease {
  version: string;
  why: string;
}

interface UpdateState {
  phase: Phase;
  percent: number;
  latest: Release | null;
  /** Публикации без файла: их видно администратору, чтобы он их отозвал */
  broken: BrokenRelease[];
  error: string;
  /** Версия, которая работает прямо сейчас */
  current: string;
  packaged: boolean;
  portable: boolean;
  /** Человек уже посмотрел на это обновление — значок в трее гасить не надо,
   *  но подпрыгивать он больше не будет */
  seen: boolean;

  init: (current: string) => Promise<void>;
  check: (silent: boolean) => Promise<void>;
  /** Скачать и поставить: одно нажатие доводит дело до конца */
  install: (campaignId?: string) => Promise<void>;
  prepare: () => Promise<boolean>;
  markSeen: () => void;
  /** Убрать публикацию, у которой нет файла (только администратор) */
  revoke: (version: string) => Promise<string>;
}

let initialized = false;
let preparing: Promise<boolean> | null = null;
let checking = false;
const elec = (): any => (typeof window !== 'undefined' ? (window as any).electron : undefined);

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: 'idle',
  percent: 0,
  latest: null,
  broken: [],
  error: '',
  current: '0.0.0',
  packaged: false,
  portable: false,
  seen: false,

  init: async (current) => {
    if (initialized) return;
    initialized = true;
    set({ current });
    const e = elec();
    if (!e) return;
    try {
      const [packaged, portable, version] = await Promise.all([
        e.isPackaged?.() ?? false,
        e.isPortable?.() ?? { portable: false },
        e.getAppVersion?.() ?? '',
      ]);
      set({
        packaged: !!packaged,
        portable: !!portable?.portable,
        current: version || current,
      });
    } catch (_) { /* старая сборка без этих ответов — работаем как есть */ }

    // Ход дела приходит из главного процесса: он качает файл, а не окно
    e.onUpdaterStatus?.((state: string, data?: { percent?: number }) => {
      if (state === 'downloading') set({ phase: 'downloading', percent: Math.round(data?.percent || 0) });
      else if (state === 'verifying') set({ phase: 'verifying' });
      else if (state === 'downloaded') set({ phase: 'ready', percent: 100 });
    });
    e.onUpdaterError?.((msg: string) => set({ phase: 'failed', error: String(msg || '') }));
  },

  check: async (silent) => {
    if (checking || ['downloading', 'verifying', 'ready', 'saving', 'installing'].includes(get().phase)) return;
    checking = true;
    if (!silent) set({ phase: 'checking', error: '' });
    try {
      const res = await fetch('/api/updates/latest', { signal: AbortSignal.timeout(15000) });
      const d = await res.json().catch(() => ({}));
      if (['downloading', 'verifying', 'ready', 'saving', 'installing'].includes(get().phase)) return;
      if (!res.ok) throw new Error(d.error || `Сервер ответил ${res.status}`);
      // Публикации без файла сервер не предлагает как обновление, но и не
      // прячет: администратор должен их увидеть и отозвать
      set({ broken: Array.isArray(d.broken) ? d.broken : [] });
      if (!d.version || !isNewer(d.version, get().current)) {
        set({ phase: 'idle', latest: null });
        return;
      }
      set({
        latest: { version: d.version, changelog: d.changelog || '', fileUrl: d.fileUrl || '', size: d.size, signature: d.signature || '' },
        phase: 'available',
        seen: get().latest?.version === d.version ? get().seen : false,
        error: '',
      });
    } catch (err: any) {
      if (['downloading', 'verifying', 'ready', 'saving', 'installing'].includes(get().phase)) return;
      set({ phase: 'idle', error: silent ? '' : (err?.message || 'Не удалось проверить обновления') });
    } finally { checking = false; }
  },

  markSeen: () => set({ seen: true }),

  revoke: async (version) => {
    try {
      const res = await fetch(`/api/updates/${encodeURIComponent(version)}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return d.error || `Сервер ответил ${res.status}`;
      set({ broken: get().broken.filter((b) => b.version !== version) });
      await get().check(true);
      return '';
    } catch (err: any) {
      return String(err?.message || err || 'Не удалось отозвать релиз');
    }
  },

  prepare: async () => {
    if (preparing) return preparing;
    if (get().phase === 'ready') return true;
    if (['saving', 'installing'].includes(get().phase)) return false;
    const run = async () => {
      const { latest, packaged, portable } = get();
      if (!latest) return false;
      const base = getServerBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
      const url = fileUrlOf(latest.fileUrl, base);
      const stop = blocker({ electron: !!elec(), packaged, portable, fileUrl: url });
      if (stop && !stop.includes('установщик')) { set({ phase: 'failed', error: stop }); return false; }
      set({ phase: 'downloading', percent: 0, error: '' });
      try {
        await elec().startDownload({ url, version: latest.version, token: getAuthToken(), server: base, signature: latest.signature || '' });
        set({ phase: 'ready', percent: 100 }); return true;
      } catch (err: any) {
        set({ phase: 'failed', error: String(err?.message || 'Не удалось скачать обновление') }); return false;
      }
    };
    preparing = run().finally(() => { preparing = null; });
    return preparing;
  },

  install: async (campaignId) => {
    if (['saving', 'installing'].includes(get().phase)) return;
    if (!await get().prepare()) return;
    set({ phase: 'saving', error: '' });
    if (!await prepareSessionClose()) {
      set({ phase: 'ready', error: 'Обновление отложено: не удалось сохранить все документы. Сохраните их и повторите.' });
      return;
    }
    set({ phase: 'installing' });
    try {
      const r = await elec().quitAndInstall(campaignId);
      // Главный процесс мог сбросить скачанный файл после отказа проверки.
      // Повтор должен заново скачать и проверить выпуск, а не застрять в ready.
      if (r?.success === false) set({ phase: 'failed', error: r.error || 'Не удалось запустить установку' });
    } catch (err: any) { set({ phase: 'failed', error: String(err?.message || err) }); }
  },
}));

/** Есть ли что ставить — по этому и светится значок у часов */
export const updateReady = (s: UpdateState): boolean =>
  !!s.latest && (s.phase === 'available' || s.phase === 'failed');
