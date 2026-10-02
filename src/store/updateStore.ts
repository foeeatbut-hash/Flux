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
  install: () => Promise<void>;
  markSeen: () => void;
  /** Убрать публикацию, у которой нет файла (только администратор) */
  revoke: (version: string) => Promise<string>;
}

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
      else if (state === 'downloaded') set({ phase: 'installing', percent: 100 });
    });
    e.onUpdaterError?.((msg: string) => set({ phase: 'failed', error: String(msg || '') }));
  },

  check: async (silent) => {
    if (['downloading', 'verifying', 'installing'].includes(get().phase)) return;
    if (!silent) set({ phase: 'checking', error: '' });
    try {
      const res = await fetch('/api/updates/latest');
      const d = await res.json().catch(() => ({}));
      if (['downloading', 'verifying', 'installing'].includes(get().phase)) return;
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
        seen: false,
        error: '',
      });
    } catch (err: any) {
      if (['downloading', 'verifying', 'installing'].includes(get().phase)) return;
      set({ phase: 'idle', error: silent ? '' : (err?.message || 'Не удалось проверить обновления') });
    }
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

  install: async () => {
    if (['downloading', 'verifying', 'installing'].includes(get().phase)) return;
    const { latest, packaged, portable } = get();
    if (!latest) return;
    const base = getServerBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    const url = fileUrlOf(latest.fileUrl, base);
    const stop = blocker({ electron: !!elec(), packaged, portable, fileUrl: url });
    // «Непортативная сборка» — не отказ, а предупреждение: там сработает
    // обычный установщик, и это тоже обновление
    if (stop && !stop.includes('установщик')) {
      set({ phase: 'failed', error: stop });
      return;
    }

    set({ phase: 'downloading', percent: 0, error: '' });
    try {
      // Подпись владельца проверяет главный процесс до запуска (electron/updateSignature.ts)
      await elec().startDownload({ url, version: latest.version, token: getAuthToken(), server: base, signature: latest.signature || '' });
    } catch (err: any) {
      // Причину уже прислал главный процесс через onUpdaterError; здесь она
      // повторяется на случай, если событие не дошло
      set({ phase: 'failed', error: String(err?.message || err || 'Не удалось скачать обновление') });
      return;
    }

    // Скачано и проверено — ставим сразу, без второго нажатия: человек уже
    // сказал, чего хочет, и ждать от него подтверждения дважды незачем
    set({ phase: 'installing' });
    try {
      const r = await elec().quitAndInstall();
      if (r && r.success === false) set({ phase: 'failed', error: r.error || 'Не удалось запустить установку' });
    } catch (err: any) {
      set({ phase: 'failed', error: String(err?.message || err) });
    }
  },
}));

/** Есть ли что ставить — по этому и светится значок у часов */
export const updateReady = (s: UpdateState): boolean =>
  !!s.latest && (s.phase === 'available' || s.phase === 'failed');
