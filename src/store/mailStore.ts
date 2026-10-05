import { create } from 'zustand';
import { mailService, type MailAccount, type MailFolder, type MailThread } from '../services/mailService';

/**
 * Состояние раздела «Почта».
 *
 * Здесь живёт то, что переживает переключение вкладок рабочего стола: какой
 * ящик и какая папка выбраны, что найдено, что отмечено. Тела писем сюда не
 * кладём — они тяжёлые и нужны только открытой переписке.
 *
 * Хранилище не знает про React-компоненты: это правило слоёв, и оно же делает
 * состояние проверяемым без браузера.
 */

export type MailFilter = 'all' | 'unread' | 'flagged';

interface MailState {
  accounts: MailAccount[];
  accountId: string;
  folders: MailFolder[];
  folderId: string;

  threads: MailThread[];
  total: number;
  /** Ключ открытой переписки; пусто — открыт список */
  openKey: string;
  /** Снимок строки открытой переписки: unread-фильтр может убрать её из списка после чтения */
  activeThread: MailThread | null;
  /** Отмеченные переписки — по ключу */
  picked: string[];

  query: string;
  filter: MailFilter;

  loading: boolean;
  syncing: boolean;
  error: string;
  /** Где лежит ключ шифрования — показываем в настройках ящика */
  keyIn: 'system' | 'file';
  /** Открыт общий ящик компании — вокруг него другая механика */
  shared: boolean;
  /** Может ли этот сотрудник заводить общий ящик */
  mayShared: boolean;
  /** Непрочитанные по ящикам — для списка слева */
  unreadByAccount: Record<string, number>;

  loadAccounts: () => Promise<void>;
  chooseAccount: (id: string) => Promise<void>;
  loadFolders: () => Promise<void>;
  chooseFolder: (id: string) => Promise<void>;
  loadThreads: () => Promise<void>;
  sync: (opts?: { deep?: boolean }) => Promise<void>;

  setQuery: (q: string) => void;
  setFilter: (f: MailFilter) => void;
  open: (key: string) => void;
  togglePick: (key: string) => void;
  pickAll: (on: boolean) => void;
  clearPicked: () => void;

  /** Взять переписку в работу или отпустить — только в общем ящике */
  claim: (threadKey: string, on: boolean) => Promise<void>;
  markSeen: (ids: string[], on: boolean) => Promise<void>;
  markFlagged: (ids: string[], on: boolean) => Promise<void>;
  moveTo: (ids: string[], to: 'TRASH' | 'ARCHIVE' | 'INBOX') => Promise<void>;
}

const LAST_ACCOUNT = 'flux_mail_account';
const LAST_FOLDER = 'flux_mail_folder';
let foldersRequestVersion = 0;
let threadsRequestVersion = 0;

export function selectOpenMailThread(threads: MailThread[], openKey: string, activeThread: MailThread | null): MailThread | null {
  if (!openKey) return null;
  return threads.find((thread) => thread.threadKey === openKey)
    || (activeThread?.threadKey === openKey ? activeThread : null);
}

const remember = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch (_) { /* приватный режим */ }
};
const recall = (key: string) => {
  try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
};

export const useMailStore = create<MailState>((set, get) => ({
  accounts: [],
  accountId: '',
  folders: [],
  folderId: '',
  threads: [],
  total: 0,
  openKey: '',
  activeThread: null,
  picked: [],
  query: '',
  filter: 'all',
  loading: false,
  syncing: false,
  error: '',
  keyIn: 'file',
  shared: false,
  mayShared: false,
  unreadByAccount: {},

  loadAccounts: async () => {
    try {
      const { accounts, keyIn, mayShared } = await mailService.accounts();
      set({ accounts, keyIn, mayShared: Boolean(mayShared), error: '' });
      if (!accounts.length) { set({ accountId: '', folders: [], threads: [], openKey: '', activeThread: null }); return; }
      // Возвращаемся к тому ящику, что был открыт в прошлый раз
      const saved = recall(LAST_ACCOUNT);
      const pick = accounts.find((a) => a.id === saved) || accounts[0];
      if (get().accountId !== pick.id) await get().chooseAccount(pick.id);
    } catch (err: any) {
      set({ error: err?.message || 'Не удалось получить список ящиков' });
    }
  },

  chooseAccount: async (id) => {
    foldersRequestVersion++;
    threadsRequestVersion++;
    set({ accountId: id, folders: [], threads: [], openKey: '', activeThread: null, picked: [] });
    remember(LAST_ACCOUNT, id);
    await get().loadFolders();
  },

  loadFolders: async () => {
    const { accountId } = get();
    if (!accountId) return;
    const requestVersion = ++foldersRequestVersion;
    try {
      const { folders, shared } = await mailService.folders(accountId);
      if (requestVersion !== foldersRequestVersion || get().accountId !== accountId) return;
      // Счётчик у ящика — сумма по папкам, но без «Отправленных», «Корзины» и
      // «Спама»: непрочитанное там человека не касается
      const counted = folders
        .filter((f) => !['SENT', 'TRASH', 'SPAM', 'DRAFTS'].includes(f.kind))
        .reduce((sum, f) => sum + (f.unread || 0), 0);
      set({
        folders,
        shared: Boolean(shared),
        unreadByAccount: { ...get().unreadByAccount, [accountId]: counted },
      });
      // «Входящие» — если не выбрано ничего другого
      const saved = recall(LAST_FOLDER);
      const current = get().folderId;
      const stillThere = folders.some((f) => f.id === current);
      if (!stillThere) {
        const pick = folders.find((f) => f.id === saved)
          || folders.find((f) => f.kind === 'INBOX')
          || folders[0];
        if (pick) { set({ folderId: pick.id }); remember(LAST_FOLDER, pick.id); }
      }
      await get().loadThreads();
    } catch (err: any) {
      if (requestVersion !== foldersRequestVersion || get().accountId !== accountId) return;
      set({ error: err?.message || 'Не удалось получить папки' });
    }
  },

  chooseFolder: async (id) => {
    threadsRequestVersion++;
    set({ folderId: id, openKey: '', activeThread: null, picked: [], threads: [] });
    remember(LAST_FOLDER, id);
    await get().loadThreads();
  },

  loadThreads: async () => {
    const { accountId, folderId, query, filter } = get();
    if (!accountId) return;
    const requestVersion = ++threadsRequestVersion;
    set({ loading: true });
    try {
      const { threads, total, shared } = await mailService.threads({
        accountId,
        // Поиск идёт по всему ящику, а не по папке: так же ведёт себя Gmail,
        // и это то, чего человек ждёт от строки поиска
        folderId: query ? undefined : folderId,
        q: query || undefined,
        unread: filter === 'unread',
        flagged: filter === 'flagged',
        limit: 60,
      });
      const current = get();
      if (requestVersion !== threadsRequestVersion
        || current.accountId !== accountId
        || current.folderId !== folderId
        || current.query !== query
        || current.filter !== filter) return;
      set((state) => ({
        threads,
        total,
        shared: Boolean(shared),
        loading: false,
        error: '',
        // Refreshing an unread list after opening a message removes its row.
        // Keep the selected summary until the user closes it or navigates.
        activeThread: state.openKey
          ? threads.find((thread) => thread.threadKey === state.openKey) || state.activeThread
          : null,
      }));
    } catch (err: any) {
      const current = get();
      if (requestVersion !== threadsRequestVersion || current.accountId !== accountId
        || current.folderId !== folderId || current.query !== query || current.filter !== filter) return;
      set({ loading: false, error: err?.message || 'Не удалось получить письма' });
    }
  },

  sync: async (opts = {}) => {
    const { accountId } = get();
    if (!accountId || get().syncing) return;
    set({ syncing: true, error: '' });
    try {
      const { report } = await mailService.sync(accountId, opts);
      set({ syncing: false, error: report.error || '' });
      await get().loadFolders();
    } catch (err: any) {
      set({ syncing: false, error: err?.message || 'Синхронизация не удалась' });
    }
  },

  setQuery: (q) => { threadsRequestVersion++; set({ query: q, openKey: '', activeThread: null, picked: [] }); void get().loadThreads(); },
  setFilter: (f) => { threadsRequestVersion++; set({ filter: f, openKey: '', activeThread: null, picked: [] }); void get().loadThreads(); },
  open: (key) => set((state) => ({
    openKey: key,
    activeThread: key
      ? state.threads.find((thread) => thread.threadKey === key) || (state.openKey === key ? state.activeThread : null)
      : null,
    picked: [],
  })),

  togglePick: (key) => set((s) => ({
    picked: s.picked.includes(key) ? s.picked.filter((k) => k !== key) : [...s.picked, key],
  })),
  pickAll: (on) => set((s) => ({ picked: on ? s.threads.map((t) => t.threadKey) : [] })),
  clearPicked: () => set({ picked: [] }),

  claim: async (threadKey, on) => {
    const { accountId } = get();
    if (!accountId || !threadKey) return;
    try {
      const { state } = await mailService.claim(accountId, threadKey, on);
      if (get().accountId !== accountId) return;
      set({
        threads: get().threads.map((t) => (t.threadKey === threadKey ? { ...t, state } : t)),
        activeThread: get().activeThread?.threadKey === threadKey ? { ...get().activeThread!, state } : get().activeThread,
        error: '',
      });
    } catch (err: any) {
      if (get().accountId !== accountId) return;
      // Отказ «переписку уже ведёт другой» — не поломка, а нужное сообщение
      set({ error: err?.message || 'Не удалось изменить состояние переписки' });
    }
  },

  markSeen: async (ids, on) => {
    if (!ids.length) return;
    const accountId = get().accountId;
    // Отмечаем сразу у себя: ждать сеть, чтобы увидеть «прочитано», незачем
    set((s) => ({
      threads: s.threads.map((t) => (t.ids.some((i) => ids.includes(i)) ? { ...t, unread: !on } : t)),
      activeThread: s.activeThread?.ids.some((id) => ids.includes(id)) ? { ...s.activeThread, unread: !on } : s.activeThread,
    }));
    try {
      await mailService.flag(ids, 'seen', on);
      if (get().accountId !== accountId) return;
      await get().loadFolders();
    } catch (err: any) {
      if (get().accountId !== accountId) return;
      set({ error: err?.message || 'Отметку не удалось сохранить' });
      await get().loadThreads();
    }
  },

  markFlagged: async (ids, on) => {
    if (!ids.length) return;
    set((s) => ({
      threads: s.threads.map((t) => (t.ids.some((i) => ids.includes(i)) ? { ...t, flagged: on } : t)),
      activeThread: s.activeThread?.ids.some((id) => ids.includes(id)) ? { ...s.activeThread, flagged: on } : s.activeThread,
    }));
    try {
      await mailService.flag(ids, 'flagged', on);
    } catch (err: any) {
      set({ error: err?.message || 'Отметку не удалось сохранить' });
      await get().loadThreads();
    }
  },

  moveTo: async (ids, to) => {
    if (!ids.length) return;
    set((s) => ({
      threads: s.threads.filter((t) => !t.ids.some((i) => ids.includes(i))),
      openKey: '',
      activeThread: null,
      picked: [],
    }));
    try {
      await mailService.move(ids, to);
      await get().loadFolders();
    } catch (err: any) {
      set({ error: err?.message || 'Письма не удалось перенести' });
      await get().loadThreads();
    }
  },
}));
