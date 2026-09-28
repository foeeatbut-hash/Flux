import { create } from 'zustand';
import { findKnowledge } from '../assistant/knowledge';
import { TOURS, Tour } from '../assistant/tours';
import { getSection } from '../assistant/sections';
import { allowEntitlement } from './policyStore';
import { applyRename } from '../assistant/renameDialog';
import { exportTableToExcel, exportTableToWord } from '../assistant/tableExport';
import { saveNewFile, editorHref } from '../lib/officeFiles';
import {
  fetchAssistantData, invalidateDataCache, renameTagApi, validateTagCode, setDataProjectGetter,
} from '../assistant/data';
import {
  describeContext, contextHint, needsContext, asksAboutContext, rememberInto,
  type OpenThing, type WorkContext,
} from '../assistant/context';
import { fileCard } from '../assistant/fileCard';
import {
  uid, toAction,
  type AssistantAction, type AssistantTable, type AssistantMessage, type LastResult, type PendingInput,
} from '../assistant/types';
import { helloText, savedWho, type Greeted } from '../assistant/greeting';
import { fixKeyboardLayout } from '../assistant/inputRepair';
import { resolveQueryWith } from '../assistant/resolve';

export type {
  AssistantAction, AssistantTable, AssistantListItem, AssistantMessage,
} from '../assistant/types';


interface AssistantState {
  isOpen: boolean;
  messages: AssistantMessage[];
  loading: boolean;
  demoMode: boolean;          // режим «Демонстрация»: любой вопрос → ближайшая демонстрация
  currentRoute: string;
  greetedRoutes: Record<string, boolean>;

  // Состояние демонстрации (тура)
  activeTour: Tour | null;
  tourStepIndex: number;
  highlightSelector: string | null;

  // Последняя выборка для экспорта
  lastTable: AssistantTable | null;
  // Контекст диалога — последний найденный список (для «а сколько их / выгрузи / первый»)
  lastResult: LastResult | null;
  // Ожидание ввода (диалоговое действие, например переименование тега)
  pendingInput: PendingInput;
  /**
   * Объект, прикреплённый к разговору: файл, брошенный в окно помощника.
   * Разговор ведётся «про него», пока не открепят, — это короче, чем каждый
   * раз называть словами, какой именно из трёх чертежей имеется в виду.
   */
  attached: { id: string; title: string; kind: string } | null;
  /**
   * Короткая память: три последних дела человека. Длинная история — это уже
   * Журнал (§32), у него своё место и своё право доступа.
   */
  recentDeeds: string[];

  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  /** Поздороваться по имени, когда вход уже случился */
  greet: (who: Greeted | null | undefined) => void;
  toggleDemoMode: () => void;
  setRoute: (route: string) => void;
  ask: (text: string) => Promise<void>;
  runAction: (action: AssistantAction) => void;
  runSuggestion: (s: { kind: 'ask' | 'tour'; query?: string; tourId?: string }) => void;
  describeCurrentSection: () => void;
  startTour: (tourId: string) => void;
  advanceTour: () => void;
  cancelTour: () => void;
  setHighlight: (selector: string | null) => void;
  attach: (v: { id: string; title: string; kind: string } | null) => void;
  /** Начать разговор заново: приветствие остаётся, прикреплённое снимается */
  clearTalk: () => void;
  /** Рассказать про брошенный в разговор файл и прикрепить его */
  askAbout: (fileId: string) => Promise<void>;
  /** Запомнить дело человека — из него складывается ответ «что я делал» */
  remember: (what: string) => void;
  /** Обстановка целиком: раздел, проект, открытые окна, последние дела */
  scene: () => WorkContext;
}

let navigateFn: ((path: string) => void) | null = null;
export function setAssistantNavigator(fn: (path: string) => void) {
  navigateFn = fn;
}

let getActiveProjectId: (() => string | null) | null = null;
export function setAssistantProjectGetter(fn: () => string | null) {
  getActiveProjectId = fn;
  // Тот же проект нужен слою данных: два независимых источника «текущего
  // проекта» однажды разошлись бы, и помощник отвечал бы про чужой
  setDataProjectGetter(fn);
}

/**
 * Обстановка: что открыто и как называется проект.
 *
 * Помощник не лезет в хранилища оболочки сам — оболочка сообщает ему сама, тем
 * же способом, каким сообщает адрес перехода. Иначе помощник знал бы про окна
 * больше, чем про них знает рама, и они разошлись бы.
 */
let getOpenThings: (() => OpenThing[]) | null = null;
let getProjectName: (() => string) | null = null;
export function setAssistantSceneGetter(open: () => OpenThing[], projectName: () => string) {
  getOpenThings = open;
  getProjectName = projectName;
}



// Разбор вопроса ушёл в assistant/resolve, а проверка прав на статьи руководства
// осталась здесь: она живёт в policyStore, которого слой assistant знать не должен.
// Под прежним именем и с прежними параметрами — им пользуются и хранилище, и проверки.
export const resolveQuery = (
  text: string, demoMode?: boolean, lastResult?: LastResult | null,
  injectedData?: Parameters<typeof resolveQueryWith>[4],
) => resolveQueryWith(allowEntitlement, text, demoMode, lastResult, injectedData);

export const useAssistantStore = create<AssistantState>((set, get) => ({
  isOpen: false,
  messages: [{
    id: uid(),
    role: 'assistant',
    text: helloText(savedWho()),
    actions: [
      { label: 'Покажи дубли', kind: 'ask', query: 'покажи дубли' },
      { label: 'Что не заказано', kind: 'ask', query: 'что не заказано' },
      { label: 'Что ты умеешь?', kind: 'navigate', route: '__help' },
    ],
  }],
  loading: false,
  demoMode: false,
  currentRoute: '/',
  greetedRoutes: {},
  activeTour: null,
  tourStepIndex: 0,
  highlightSelector: null,
  lastTable: null,
  lastResult: null,
  pendingInput: null,
  attached: null,
  recentDeeds: [],

  toggleOpen: () => set(s => ({ isOpen: !s.isOpen })),

  /**
   * Переписываем приветствие, когда стал известен вошедший, — но только пока
   * разговор не начался. Иначе имя вписалось бы поверх реплики, на которую
   * человек уже ответил, и переписка задним числом изменилась бы сама.
   */
  greet: (who) => set((s) => {
    if (s.messages.length !== 1 || s.messages[0].role !== 'assistant') return {};
    const text = helloText(who);
    if (s.messages[0].text === text) return {};
    return { messages: [{ ...s.messages[0], text }] };
  }),
  setOpen: (open) => set({ isOpen: open }),
  toggleDemoMode: () => set(s => ({ demoMode: !s.demoMode })),

  setRoute: (route) => {
    const prev = get().currentRoute;
    set({ currentRoute: route });
    // Встречаем пользователя при заходе в новый раздел (один раз за сессию),
    // только в режиме «Демонстрация» и при открытом чате
    if (route !== prev && get().isOpen && get().demoMode) {
      const sec = getSection(route, allowEntitlement);
      if (sec && !get().greetedRoutes[route]) {
        set(s => ({
          greetedRoutes: { ...s.greetedRoutes, [route]: true },
          messages: [...s.messages, {
            id: uid(), role: 'assistant',
            text: `${sec.emoji} ${sec.greeting}`,
            actions: sec.suggestions.map(toAction),
          }],
        }));
      }
    }
  },

  setHighlight: (selector) => set({ highlightSelector: selector }),

  describeCurrentSection: () => {
    const sec = getSection(get().currentRoute, allowEntitlement);
    if (!sec) return;
    set(s => ({
      messages: [...s.messages, {
        id: uid(), role: 'assistant',
        text: `${sec.emoji} Раздел «${sec.title}»\n\n${sec.description}`,
        actions: sec.suggestions.map(toAction),
      }],
    }));
  },

  runSuggestion: (s) => {
    if (s.kind === 'tour' && s.tourId) {
      get().startTour(s.tourId);
    } else if (s.kind === 'ask' && s.query) {
      get().ask(s.query);
    }
  },

  ask: async (text) => {
    const clean = text.trim();
    if (!clean) return;
    const userMsg: AssistantMessage = { id: uid(), role: 'user', text: clean };

    // Диалоговый режим: ждём значение для начатого действия (переименование)
    const pending = get().pendingInput;
    if (pending) {
      set(s => ({ messages: [...s.messages, userMsg], loading: true }));
      const post = (m: AssistantMessage) => set(s => ({ messages: [...s.messages, m], loading: false }));
      // Отмена по ключевым словам
      if (/^(отмена|отмени|отменить|стоп|cancel|назад|не надо|нет)$/i.test(clean)) {
        set({ pendingInput: null });
        post({ id: uid(), role: 'assistant', text: 'Хорошо, отменил. Чем ещё помочь?' });
        return;
      }
      if (pending.kind === 'rename-tag') {
        // Правила разговора — в assistant/renameDialog: неверный код не
        // выбрасывает из диалога, тот же код — не ошибка, дубль — предупреждение
        const out = await applyRename({ tagId: pending.tagId, oldCode: pending.oldCode }, clean, {
          validate: validateTagCode,
          countSame: async (code, exceptId) => {
            const data = await fetchAssistantData();
            const n = data.tags.filter(
              (t) => t.id !== exceptId && (t.identifier || '').trim().toLowerCase() === code.toLowerCase(),
            ).length;
            invalidateDataCache();
            return n;
          },
          rename: renameTagApi,
        });
        if (out.kind !== 'retry') set({ pendingInput: null });
        post({
          id: uid(), role: 'assistant', text: out.text,
          actions: out.kind === 'done' ? [
            { label: 'Показать на Схеме', kind: 'focus-tag', tagId: out.tagId },
            { label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' },
          ] : undefined,
        });
        return;
      }
    }

    set(s => ({ messages: [...s.messages, userMsg], loading: true }));

    // «Что открыто?», «где я?», «что я делал?» — про обстановку, и отвечать на
    // них надо обстановкой, а не поиском по тегам
    if (asksAboutContext(clean)) {
      set(s => ({
        loading: false,
        messages: [...s.messages, { id: uid(), role: 'assistant', text: describeContext(get().scene()) }],
      }));
      return;
    }

    try {
      // Понимаем запросы с перепутанной раскладкой («gjrf;b ntub» → «покажи теги»)
      const fixed = fixKeyboardLayout(clean);
      const { message, result, pending } = await resolveQuery(fixed, get().demoMode, get().lastResult);
      if (fixed !== clean) {
        message.text = `🌐 Понял как: «${fixed}»\n\n${message.text}`;
      }
      // В вопросе указательное слово — «этот», «здесь», «его». Раньше на них
      // помощник переспрашивал «какой именно?», хотя нужное было открыто перед
      // человеком. Теперь он говорит, что именно имеет в виду, и человек сразу
      // видит, если помощник понял не то
      if (needsContext(clean)) {
        const hint = contextHint(get().scene());
        if (hint) message.text = `${message.text}\n\n${hint}`;
      }
      set(s => ({
        messages: [...s.messages, message],
        loading: false,
        lastTable: message.table || s.lastTable,
        lastResult: result !== undefined ? result : s.lastResult,
        pendingInput: pending !== undefined ? pending : s.pendingInput,
      }));
    } catch (err: any) {
      set(s => ({
        messages: [...s.messages, { id: uid(), role: 'assistant', text: `Не удалось обработать запрос: ${err.message}` }],
        loading: false,
      }));
    }
  },

  attach: (v) => set({ attached: v }),

  remember: (what) => set((st) => ({ recentDeeds: rememberInto(st.recentDeeds, what) })),

  /**
   * Обстановка: раздел, проект, открытые окна, последние дела.
   *
   * Собирается на каждый вопрос, а не хранится: окна открывают и закрывают
   * мимо помощника, и его собственная копия сцены устарела бы на первом же
   * закрытом документе.
   */
  scene: () => {
    const route = get().currentRoute;
    const sec = getSection(route, allowEntitlement);
    return {
      route,
      section: sec?.title || '',
      projectName: getProjectName ? getProjectName() : '',
      open: getOpenThings ? getOpenThings() : [],
      recent: get().recentDeeds,
    };
  },

  clearTalk: () => set(s => ({
    messages: s.messages.slice(0, 1),
    attached: null, lastResult: null, lastTable: null, pendingInput: null,
  })),

  /** Про брошенный в разговор файл: карточку собирает assistant/fileCard */
  askAbout: async (fileId) => {
    set({ loading: true });
    try {
      // Карточке нужны имя, тип и теги, а не содержимое: файл может весить
      // сотни мегабайт, и тащить его в разговор незачем
      const r = await fetch(`/api/files/${fileId}?meta=1`);
      if (!r.ok) throw new Error('файл не найден');
      const body = await r.json();
      const card = fileCard(body.file || body);
      set(s => ({ loading: false, attached: card.attached, messages: [...s.messages, card.message] }));
    } catch (err: any) {
      set(s => ({
        loading: false,
        messages: [...s.messages, { id: uid(), role: 'assistant', text: `Не смог посмотреть этот файл: ${err.message}` }],
      }));
    }
  },

  runAction: (action) => {
    // Выгрузка ответа помощника — файл во Flux («Выгрузки»), а не скачивание
    // мимо программы: его тут же открывает тот же экран Flux Office
    const exportTable = async (build: () => Promise<{ bytes: Uint8Array; name: string }> | { bytes: Uint8Array; name: string }) => {
      try {
        const file = await build();
        const made = await saveNewFile(file.bytes, file.name);
        set(s => ({ messages: [...s.messages, { id: uid(), role: 'assistant', text: `«${made.name}» — в «Выгрузки», открываю…` }] }));
        if (navigateFn) navigateFn(editorHref(made));
      } catch (err: any) {
        set(s => ({ messages: [...s.messages, { id: uid(), role: 'assistant', text: `Не выгрузилось: ${err?.message || err}` }] }));
      }
    };
    if (action.kind === 'tour' && action.tourId) {
      get().startTour(action.tourId);
    } else if (action.kind === 'ask' && action.query) {
      get().ask(action.query);
    } else if (action.kind === 'export-excel' && get().lastTable) {
      exportTable(() => exportTableToExcel(get().lastTable!));
    } else if (action.kind === 'export-word' && get().lastTable) {
      exportTable(() => exportTableToWord(get().lastTable!));
    } else if (action.kind === 'navigate' || action.kind === 'open-section') {
      if (action.route === '__help') {
        const ans = findKnowledge('что умеешь');
        set(s => ({ messages: [...s.messages, { id: uid(), role: 'assistant', text: ans || '' }] }));
      } else if (action.route && navigateFn) {
        navigateFn(action.route);
      }
    } else if (action.kind === 'prompt-rename-tag' && action.tagId) {
      // Начинаем диалог переименования: следующая реплика — новый код
      set(s => ({
        pendingInput: { kind: 'rename-tag', tagId: action.tagId!, oldCode: action.code || '' },
        messages: [...s.messages, {
          id: uid(), role: 'assistant',
          text: `Введите новый код для тега «${action.code || ''}». Связи и комментарии сохранятся.\n(или напишите «отмена»)`,
          actions: [{ label: 'Отмена', kind: 'cancel-input' }],
        }],
      }));
    } else if (action.kind === 'cancel-input') {
      if (get().pendingInput) {
        set(s => ({ pendingInput: null, messages: [...s.messages, { id: uid(), role: 'assistant', text: 'Отменил. Чем ещё помочь?' }] }));
      }
    } else if (action.kind === 'focus-tag' && action.tagId && navigateFn) {
      // Глубокая ссылка: раздел прочитает ?focus= и центрирует/подсветит позицию
      navigateFn(`/registry?focus=${encodeURIComponent(action.tagId)}`);
    } else if (action.kind === 'focus-equipment' && action.componentId && navigateFn) {
      // Переход к конкретному элементу оборудования с подсветкой характеристики
      try {
        sessionStorage.setItem('flux_equip_focus', JSON.stringify({
          componentId: action.componentId,
          specKey: action.specKey || '',
          ts: Date.now(),
        }));
      } catch (_) {}
      navigateFn('/equipment');
    } else if (action.kind === 'find-duplicates' && action.code && navigateFn) {
      navigateFn(`/registry?dup=${encodeURIComponent(action.code)}`);
    } else if (action.kind === 'create-note' && navigateFn) {
      // Заметки теперь в студии (Конструктор → вкладка «Заметки»)
      navigateFn(`/notes?new=${encodeURIComponent(action.noteTitle || 'Новая заметка')}`);
    }
  },

  startTour: (tourId) => {
    const tour = TOURS.find(t => t.id === tourId);
    if (!tour) return;
    set({ activeTour: tour, tourStepIndex: 0 });
    const step = tour.steps[0];
    set(s => ({
      messages: [...s.messages, { id: uid(), role: 'assistant', text: `▶ Демонстрация «${tour.title}»\n\nШаг 1 из ${tour.steps.length}: ${step.text}` }],
    }));
    if (step.route && navigateFn) navigateFn(step.route);
    get().setHighlight(step.target || null);
  },

  advanceTour: () => {
    const { activeTour, tourStepIndex } = get();
    if (!activeTour) return;
    const nextIndex = tourStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      set({ activeTour: null, tourStepIndex: 0, highlightSelector: null });
      return;
    }
    const step = activeTour.steps[nextIndex];
    set(s => ({
      tourStepIndex: nextIndex,
      messages: [...s.messages, { id: uid(), role: 'assistant', text: `Шаг ${nextIndex + 1} из ${activeTour.steps.length}: ${step.text}` }],
    }));
    if (step.route && navigateFn) navigateFn(step.route);
    get().setHighlight(step.target || null);
  },

  cancelTour: () => set({ activeTour: null, tourStepIndex: 0, highlightSelector: null }),
}));
