/**
 * Состояние Flux Guide (ТЗ v3 §17, §4).
 *
 * Раздельные вещи хранятся раздельно: режим оболочки и черновики ввода по
 * режимам, история вопросов текущего сеанса с серверным сохранением,
 * избранное и недавние статьи справочника, активная демонстрация, структури-
 * рованный контекст последнего ответа («их», «а без тегов», «выгрузи»).
 * Настройки — по пользователю. Пустой чат на сервер не попадает.
 */
import { create } from 'zustand';
import { TOURS, type Tour } from './support/tours';
import { canAdvanceTour, withProjectContext } from './tourRuntime';
import { answerQuestion, type AskContext, type LastResult } from './engine';
import {
  guideProjects, guideChats, guideChatOpen, guideChatSave,
  guideChatArchive, guideChatRestore,
  type GuideProject, type GuideChatInfo,
} from './projects';
import { uid, type GuideMessage, type GuideAction } from './types';
import { useWindowStore } from '../store/windowStore';
import { resolveSectionHref, resolveSectionPath } from '../lib/sectionAliases';

const GUIDE_NAV = 'flux_guide_state';
let chatSaveQueue: Promise<void> = Promise.resolve();

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${GUIDE_NAV}_${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function writeLocal(key: string, value: unknown): void {
  try { localStorage.setItem(`${GUIDE_NAV}_${key}`, JSON.stringify(value)); } catch { /* приватный режим */ }
}

/** Настройки и списки — по пользователю, не глобально (ТЗ §17). */
const scoped = (userId: string): string => `u_${userId || 'anon'}`;

function persistSnapshot(userId: string, id: string, projectId: string | null, messages: GuideMessage[]): Promise<void> {
  const save = async () => {
    const title = messages.find((m) => m.role === 'user')?.text || 'Вопрос';
    await guideChatSave(userId, id, { title, projectId: projectId || '', messages });
  };
  const queued = chatSaveQueue.catch(() => undefined).then(save);
  chatSaveQueue = queued;
  return queued;
}

export type GuideMode = 'handbook' | 'questions';

interface GuideState {
  mode: GuideMode;
  setMode: (mode: GuideMode) => void;
  /** Черновики строки ввода — по режимам, смена режима ничего не теряет */
  draftHandbook: string;
  draftQuestions: string;
  setDraft: (mode: GuideMode, text: string) => void;

  /** Внедряемые оболочкой функции (App.tsx) */
  navigator: ((path: string) => void) | null;
  userGetter: (() => { id: string; name?: string } | null) | null;
  actorId: string;
  activeProjectGetter: (() => { id: string; name: string } | null) | null;
  setNavigator: (fn: (path: string) => void) => void;
  setUserGetter: (fn: () => { id: string; name?: string } | null) => void;
  setActiveProjectGetter: (fn: () => { id: string; name: string } | null) => void;

  /** Проект для вопросов: явно выбранный; null — не выбран */
  projectId: string | null;
  projectName: string;
  setProject: (id: string | null, name: string) => Promise<void>;
  projects: GuideProject[];
  projectsError: string;
  loadProjects: () => Promise<void>;
  reconcileProjectAccess: () => Promise<void>;

  /** Вопросы: сеанс + серверная история */
  messages: GuideMessage[];
  asking: boolean;
  ask: (text: string) => Promise<void>;
  saveChat: () => Promise<void>;
  chatSaveState: 'idle' | 'saving' | 'saved' | 'error';
  chatSaveError: string;
  runAction: (action: GuideAction) => void;
  clearQuestions: () => void;
  lastResult: LastResult | null;

  chatId: string | null;
  chats: GuideChatInfo[];
  archivedChats: GuideChatInfo[];
  historyArchived: boolean;
  chatsOpen: boolean;
  historyError: string;
  loadChats: (archived?: boolean) => Promise<void>;
  openChat: (id: string) => Promise<boolean>;
  startNewChat: () => Promise<void>;
  archiveChat: (id: string) => Promise<void>;
  restoreChat: (id: string) => Promise<void>;
  setHistoryArchived: (archived: boolean) => void;

  /** Справочник: избранное и недавние статьи (по пользователю) */
  favorites: string[];
  recent: string[];
  toggleFavorite: (articleId: string) => void;
  rememberArticle: (articleId: string) => void;

  /** Демонстрация */
  activeTour: Tour | null;
  tourStepIndex: number;
  highlightSelector: string | null;
  tourPaused: boolean;
  tourStepCompleted: boolean;
  startTour: (tourId: string) => void;
  advanceTour: () => void;
  backTour: () => void;
  pauseTour: () => void;
  skipTourStep: () => void;
  completeTourStep: () => void;
  cancelTour: () => void;
  setHighlight: (selector: string | null) => void;
}

export const useGuideStore = create<GuideState>((set, get) => ({
  mode: 'handbook',
  setMode: (mode) => set({ mode }),
  draftHandbook: '',
  draftQuestions: '',
  setDraft: (mode, text) => set(mode === 'handbook' ? { draftHandbook: text } : { draftQuestions: text }),

  navigator: null,
  userGetter: null,
  actorId: '',
  activeProjectGetter: null,
  setNavigator: (fn) => set({ navigator: fn }),
  setUserGetter: (fn) => {
    const next = fn()?.id || '';
    if (get().actorId !== next) {
      // Never let a pending request or conversation from one signed-in account
      // appear in the next account's Guide session. Drafts are account scoped.
      set({ userGetter: fn, actorId: next, activeProjectGetter: null, projectId: null, projectName: '', projects: [], projectsError: '',
        messages: [], asking: false, lastResult: null, chatId: null, chatSaveState: 'idle', chatSaveError: '',
        chats: [], archivedChats: [], historyArchived: false, historyError: '',
        draftHandbook: '', draftQuestions: '', favorites: [], recent: [] });
    } else set({ userGetter: fn, actorId: next });
  },
  setActiveProjectGetter: (fn) => {
    set({ activeProjectGetter: fn });
    // Выбранный проект по умолчанию — активный проект Flux, если он доступен.
    // Иного скрытого выбора нет: null остаётся null
    const active = fn();
    if (active) set({ projectId: active.id, projectName: active.name });
  },

  projectId: null,
  projectName: '',
  setProject: async (id, name) => {
    // Смена проекта отделяет прежний контекст: ответы старого проекта больше
    // не участвуют ни в чём (ТЗ §11.1)
    if (id === get().projectId) return;
    if (get().messages.some((m) => m.role === 'user')) {
      await get().saveChat();
      if (get().chatSaveState !== 'saved') return;
      set({ messages: [], chatId: null, chatSaveState: 'idle', chatSaveError: '' });
    }
    set({ projectId: id, projectName: name, lastResult: null });
  },
  projects: [],
  projectsError: '',
  loadProjects: async () => {
    const userId = get().userGetter?.()?.id || '';
    try {
      const res = await guideProjects(userId);
      if ((get().userGetter?.()?.id || '') === userId) set({ projects: res.projects, projectsError: '' });
    } catch { if ((get().userGetter?.()?.id || '') === userId) set({ projectsError: 'Список проектов не загрузился. Проверьте соединение и повторите.' }); }
  },
  reconcileProjectAccess: async () => {
    const userId = get().userGetter?.()?.id || '';
    try {
      const res = await guideProjects(userId);
      if ((get().userGetter?.()?.id || '') !== userId) return;
      const selectedId = get().projectId;
      const remains = !selectedId || res.projects.some((p) => p.id === selectedId);
      set({ projects: res.projects, projectsError: '' });
      if (selectedId && !remains) {
        // Сервер подтвердил отзыв доступа. Удаляем чувствительный контекст,
        // даже если его текущая беседа ещё не успела сохраниться. Черновик
        // строки вопроса остаётся нетронутым.
        set({ projectId: null, projectName: '', messages: [], chatId: null, lastResult: null,
          chatSaveState: 'idle', chatSaveError: '' });
      }
    } catch {
      // Ошибка сети не является отзывом доступа: сохраняем выбранный проект,
      // сообщения, контекст и черновик, показывая возможность повторить.
      if ((get().userGetter?.()?.id || '') === userId) set({ projectsError: 'Доступ к проектам не удалось проверить. Проверьте соединение и повторите.' });
    }
  },

  messages: [],
  asking: false,
  lastResult: null,
  chatId: null,
  chatSaveState: 'idle',
  chatSaveError: '',
  chats: [],
  archivedChats: [],
  historyArchived: false,
  chatsOpen: false,
  historyError: '',
  loadChats: async (archived = get().historyArchived) => {
    const userId = get().userGetter?.()?.id || '';
    try {
      const chats = await guideChats(userId, { archived });
      if ((get().userGetter?.()?.id || '') !== userId) return;
      set(archived ? { archivedChats: chats, historyError: '' } : { chats, historyError: '' });
    } catch {
      if ((get().userGetter?.()?.id || '') === userId) set(archived ? { historyError: 'Историю загрузить не удалось. Проверьте соединение и повторите.' } : { historyError: 'Историю загрузить не удалось. Проверьте соединение и повторите.' });
    }
  },
  setHistoryArchived: (archived) => {
    set({ historyArchived: archived });
    void get().loadChats(archived);
  },
  openChat: async (id) => {
    const current = get();
    if (current.chatId !== id && current.messages.some((m) => m.role === 'user') && current.chatSaveState !== 'saved') {
      await current.saveChat();
      if (get().chatSaveState !== 'saved') return false;
    }
    const userId = get().userGetter?.()?.id || '';
    try {
      const { chat } = await guideChatOpen(userId, id);
      if ((get().userGetter?.()?.id || '') !== userId) return;
      const messages = chat.messages as GuideMessage[];
      const projects = get().projects;
      const latestScoped = [...messages].reverse().find((m) => m.role === 'guide'
        && m.context?.projectId && projects.some((p) => p.id === m.context!.projectId)
        && (!m.projectId || m.projectId === m.context?.projectId));
      const activeId = latestScoped?.context?.projectId
        || (chat.projectId && projects.some((p) => p.id === chat.projectId) ? chat.projectId : null);
      const p = projects.find((x) => x.id === activeId);
      const lastResult = activeId ? latestScoped?.context || null : null;
      set({ projectId: activeId, projectName: p?.name || '', messages, chatId: chat.id, lastResult,
        chatsOpen: false, chatSaveState: 'saved', chatSaveError: '', historyError: '' });
      return true;
    } catch {
      if ((get().userGetter?.()?.id || '') === userId) set({ historyError: 'Разговор недоступен или его не удалось загрузить.' });
      return false;
    }
  },
  startNewChat: async () => {
    const current = get();
    if (current.messages.some((m) => m.role === 'user') && current.chatSaveState !== 'saved') {
      await current.saveChat();
      if (get().chatSaveState !== 'saved') return;
    }
    // Старая переписка сохранена на сервере; новый сеанс пуст до первого вопроса
    set({ messages: [], chatId: null, lastResult: null, chatsOpen: false, chatSaveState: 'idle', chatSaveError: '' });
  },
  archiveChat: async (id) => {
    if (get().chatId === id && get().messages.some((m) => m.role === 'user') && get().chatSaveState !== 'saved') {
      await get().saveChat();
      if (get().chatSaveState !== 'saved') return;
    }
    const userId = get().userGetter?.()?.id || '';
    const actorId = get().userGetter?.()?.id || '';
    try {
      await guideChatArchive(userId, id);
      if ((get().userGetter?.()?.id || '') !== actorId) return;
      set((s) => ({
        chats: s.chats.filter((c) => c.id !== id),
        ...(s.chatId === id ? { messages: [], chatId: null, lastResult: null, chatSaveState: 'idle' as const, chatSaveError: '' } : {}),
      }));
      void get().loadChats(true);
    } catch { if ((get().userGetter?.()?.id || '') === actorId) set({ historyError: 'Разговор не удалось отправить в архив.' }); }
  },
  restoreChat: async (id) => {
    const userId = get().userGetter?.()?.id || '';
    const actorId = userId;
    try {
      await guideChatRestore(userId, id);
      if ((get().userGetter?.()?.id || '') !== actorId) return;
      set((s) => ({ archivedChats: s.archivedChats.filter((c) => c.id !== id) }));
      void get().loadChats(false);
    } catch { if ((get().userGetter?.()?.id || '') === actorId) set({ historyError: 'Разговор не удалось восстановить.' }); }
  },

  ask: async (text) => {
    const clean = String(text || '').trim();
    if (!clean || get().asking) return;
    const initial = get();
    const user = initial.userGetter?.();
    const userId = scoped(user?.id || '');
    const targetChatId = initial.chatId || `gchat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const userMessage: GuideMessage = { id: uid(), role: 'user', text: clean, projectId: initial.projectId || undefined };
    const ctx: AskContext = {
      userId,
      projectId: initial.projectId,
      projectName: initial.projectName,
      lastResult: initial.lastResult,
    };
    set({ messages: [...initial.messages, userMessage], asking: true, chatId: targetChatId });
    try {
      const rawAnswers = await answerQuestion(clean, ctx);
      const answers = rawAnswers.map((m) => {
        if (m.projectId) return m;
        if (m.source?.projectId) return { ...m, projectId: m.source.projectId };
        if (m.status === 'permission' && ctx.projectId) return { ...m, projectId: ctx.projectId };
        return m;
      });
      const scopedQuestion = userMessage;
      const snapshot = [...initial.messages, scopedQuestion, ...answers];
      const current = get();
      if (scoped(current.userGetter?.()?.id || '') !== userId) return;
      const stillCurrent = current.chatId === targetChatId && current.projectId === ctx.projectId;
      if (answers.some((m) => m.status === 'permission')) {
        if (stillCurrent) {
          // 403 — подтверждённый отказ. Не оставляем в активном окне ранее
          // показанные строки проекта и контекст продолжения.
          set({ messages: [scopedQuestion, ...answers], asking: false, lastResult: null,
            chatId: null, chatSaveState: 'idle', chatSaveError: '' });
        } else {
          set({ asking: false });
        }
        return;
      }
      // Структурированный контекст последнего ответа — для продолжения вопроса
      const newLast = answers.reduce<LastResult | null>((acc, m) => (m as any).context ?? acc, null);
      if (stillCurrent) {
        set({ messages: snapshot, asking: false, lastResult: newLast ?? current.lastResult });
        void get().saveChat();
      } else {
        set({ asking: false });
        await persistSnapshot(userId, targetChatId, ctx.projectId, snapshot);
      }
    } catch (error: any) {
      const unavailable: GuideMessage = {
          id: uid(), role: 'guide', status: 'unavailable',
          text: 'Данные проекта сейчас недоступны.',
          actions: [{ kind: 'ask', label: 'Повторить вопрос', query: clean }],
          source: { label: 'Flux Guide', at: new Date().toLocaleTimeString('ru-RU') },
      };
      const current = get();
      if (scoped(current.userGetter?.()?.id || '') !== userId) return;
      if (current.chatId === targetChatId && current.projectId === ctx.projectId) {
        set({ messages: [...current.messages, unavailable], asking: false });
        void get().saveChat();
      } else {
        set({ asking: false });
        if (error?.status !== 403) {
          await persistSnapshot(userId, targetChatId, ctx.projectId, [...initial.messages, userMessage, unavailable]);
        }
      }
    }
  },

  saveChat: async () => {
    const s = get();
    if (!s.messages.some((m) => m.role === 'user')) return; // пустой чат не сохраняется
    const userId = scoped(s.userGetter?.()?.id || '');
    const actorId = s.userGetter?.()?.id || '';
    const id = s.chatId || `gchat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const title = s.messages.find((m) => m.role === 'user')?.text || 'Вопрос';
    if (!s.chatId) set({ chatId: id });
    set({ chatSaveState: 'saving', chatSaveError: '' });
    const save = async () => {
      try {
        await guideChatSave(userId, id, { title, projectId: s.projectId || '', messages: s.messages });
        if ((get().userGetter?.()?.id || '') === actorId && get().chatId === id && get().messages === s.messages) set({ chatSaveState: 'saved', chatSaveError: '' });
        void get().loadChats(false);
      } catch (error) {
        if ((get().userGetter?.()?.id || '') === actorId && get().chatId === id && get().messages === s.messages) {
          if ((error as any)?.status === 403) {
            set({ projectId: null, projectName: '', messages: [{ id: uid(), role: 'guide', status: 'permission',
              text: 'Доступ к проекту отозван. Сохранённые ответы и контекст проекта очищены.' }],
              lastResult: null, chatId: null, chatSaveState: 'idle', chatSaveError: '',
              projectsError: 'Доступ к выбранному проекту изменился. Список проектов обновлён.' });
            void get().reconcileProjectAccess();
          } else {
            set({ chatSaveState: 'error', chatSaveError: error instanceof Error ? error.message : 'Сохранить разговор не удалось.' });
          }
        }
      }
    };
    const queued = chatSaveQueue.catch(() => undefined).then(save);
    chatSaveQueue = queued;
    await queued;
  },

  runAction: (action) => {
    const { navigator: nav } = get();
    // Переход в ДРУГУЮ программу открывает её окно (или поднимает уже открытое):
    // окно Guide при этом остаётся собой. Подменять Guide целевым разделом
    // нельзя — сотрудник теряет справку (ТЗ v3 §36.3)
    const openWindow = (route?: string) => {
      if (!route) return;
      useWindowStore.getState().open(resolveSectionHref(route));
    };
    switch (action.kind) {
      case 'navigate':
        openWindow(action.route);
        return;
      case 'open-article':
        if (action.route && nav) nav(action.route);
        else set({ mode: 'handbook' });
        return;
      case 'tour':
        get().startTour(action.tourId || '');
        return;
      case 'ask':
        void get().ask(action.query || action.label);
        return;
      case 'focus-tag':
        // Реестр тегов сам разбирает ?tag=<код> и подсвечивает позицию
        openWindow(`/registry?tag=${encodeURIComponent(action.code || action.tagId || '')}`);
        return;
      case 'focus-equipment':
        try {
          sessionStorage.setItem('flux_equip_focus', JSON.stringify({ componentId: action.componentId, ts: Date.now() }));
        } catch { /* приватный режим */ }
        openWindow('/equipment');
        return;
      case 'open-export':
        openWindow('/equipment-export');
        return;
      case 'export-table':
      case 'clarify':
        return;
      default:
        return;
    }
  },
  clearQuestions: () => set({ messages: [], chatId: null, lastResult: null }),

  favorites: [],
  recent: [],
  toggleFavorite: (articleId) => {
    const userId = scoped(get().userGetter?.()?.id || '');
    const cur = readLocal<string[]>(`fav_${userId}`, []);
    const next = cur.includes(articleId) ? cur.filter((x) => x !== articleId) : [articleId, ...cur].slice(0, 30);
    writeLocal(`fav_${userId}`, next);
    set({ favorites: next });
  },
  rememberArticle: (articleId) => {
    const userId = scoped(get().userGetter?.()?.id || '');
    const cur = readLocal<string[]>(`recent_${userId}`, []);
    const next = [articleId, ...cur.filter((x) => x !== articleId)].slice(0, 25);
    writeLocal(`recent_${userId}`, next);
    set({ recent: next });
  },

  activeTour: null,
  tourStepIndex: 0,
  highlightSelector: null,
  tourPaused: false,
  tourStepCompleted: false,
  setHighlight: (selector) => set({ highlightSelector: selector }),
  startTour: (tourId) => {
    const definition = TOURS.find((t) => t.id === tourId);
    if (!definition) return;
    const tour: Tour = withProjectContext(definition, !!get().activeProjectGetter?.());
    // §35.2: если раздел из navigate-шагов уже открыт на столе — не заставляем
    // открывать его повторно, стартуем с первого содержательного шага
    const openPaths = new Set(useWindowStore.getState().windows.map((w) => w.path));
    let start = 0;
    while (start < tour.steps.length && tour.steps[start].action === 'navigate' && tour.steps[start].route && openPaths.has(resolveSectionPath(tour.steps[start].route!))) {
      start += 1;
    }
    set({ activeTour: tour, tourStepIndex: start, tourPaused: false, tourStepCompleted: false });
    const step = tour.steps[start];
    const skipped = start > 0 ? '\n\n(Раздел уже открыт — начинаем с шага ' + (start + 1) + '.)' : '';
    set((s) => ({
      messages: [...s.messages, {
        id: uid(), role: 'guide',
        text: `▶ Демонстрация «${tour.title}»\n\nШаг ${start + 1} из ${tour.steps.length}: ${step.text}${skipped}`,
      }],
    }));
    if (step.route && get().navigator) get().navigator!(step.route);
    get().setHighlight(step.target || null);
  },
  advanceTour: () => {
    const { activeTour, tourStepIndex } = get();
    if (!activeTour) return;
    if (!canAdvanceTour(activeTour.steps[tourStepIndex], get().tourStepCompleted)) return;
    const nextIndex = tourStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      set({ activeTour: null, tourStepIndex: 0, highlightSelector: null, tourPaused: false, tourStepCompleted: false });
      return;
    }
    const step = activeTour.steps[nextIndex];
    set((s) => ({
      tourStepIndex: nextIndex, tourStepCompleted: false,
      messages: [...s.messages, {
        id: uid(), role: 'guide',
        text: `Шаг ${nextIndex + 1} из ${activeTour.steps.length}: ${step.text}`,
      }],
    }));
    if (step.route && get().navigator) get().navigator!(step.route);
    get().setHighlight(step.target || null);
  },
  backTour: () => {
    const { activeTour, tourStepIndex } = get();
    if (!activeTour || tourStepIndex === 0) return;
    const index = tourStepIndex - 1;
    set({ tourStepIndex: index, tourStepCompleted: false, tourPaused: false });
    const step = activeTour.steps[index];
    // Возврат меняет только позицию Guide: он не повторяет и не запускает действия в программе.
    get().setHighlight(step.target || null);
  },
  pauseTour: () => set((s) => ({ tourPaused: !s.tourPaused })),
  skipTourStep: () => {
    const { activeTour, tourStepIndex } = get();
    if (!activeTour) return;
    if (activeTour.steps[tourStepIndex].requiredContext) return;
    if (tourStepIndex >= activeTour.steps.length - 1) { get().cancelTour(); return; }
    set({ tourStepCompleted: true });
    get().advanceTour();
  },
  completeTourStep: () => set({ tourStepCompleted: true }),
  cancelTour: () => set({ activeTour: null, tourStepIndex: 0, highlightSelector: null, tourPaused: false, tourStepCompleted: false }),
}));

/** Гидратация пользовательских списков после входа. */
export function hydrateGuideUser(userId: string): void {
  const key = scoped(userId);
  useGuideStore.setState({
    favorites: readLocal<string[]>(`fav_${key}`, []),
    recent: readLocal<string[]>(`recent_${key}`, []),
  });
}
