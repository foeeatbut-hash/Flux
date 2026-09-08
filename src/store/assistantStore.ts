import { create } from 'zustand';
import { ENV_CONFIG } from '../config/env';
import { findKnowledge, matchKnowledge } from '../assistant/knowledge';
import { TOURS, findBestTour, Tour } from '../assistant/tours';
import { getSection } from '../assistant/sections';
import { applyRename } from '../assistant/renameDialog';
import { exportTableToExcel, exportTableToWord } from '../assistant/tableExport';
import {
  fetchAssistantData, invalidateDataCache, renameTagApi, validateTagCode, setDataProjectGetter,
  type AssistantData,
} from '../assistant/data';
import {
  describeContext, contextHint, needsContext, asksAboutContext, rememberInto,
  type OpenThing, type WorkContext,
} from '../assistant/context';
import { parse, hasIntent, fieldMatchesStems, Parsed } from '../assistant/nlp';
import { FIELDS, FieldDef } from '../import/dictionary';
import { askedField, specForField, findComponentByCode, tagWithoutEquipment } from '../assistant/specAnswers';
import { asksWhereWritten } from '../assistant/handbookAnswers';
import { fileCard } from '../assistant/fileCard';
import { asksToFindMail } from '../assistant/mailQueries';
import { handbookMessage, mailSearchMessage } from '../assistant/answers';
import { uid, type AssistantAction, type AssistantTable, type AssistantListItem, type AssistantMessage } from '../assistant/types';
import { helloText, savedWho, type Greeted } from '../assistant/greeting';

export type {
  AssistantAction, AssistantTable, AssistantListItem, AssistantMessage,
} from '../assistant/types';

// Ожидание ввода в диалоге: следующая реплика пользователя — не запрос,
// а значение для начатого действия (например, новый код переименовываемого тега)
type PendingInput =
  | { kind: 'rename-tag'; tagId: string; oldCode: string }
  | null;


// Последний результат — для follow-up вопросов («а сколько их?», «выгрузи», «первый на холсте»)
interface LastResult {
  kind: 'tags' | 'components' | 'duplicates';
  ids: string[];
  label: string;
}

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



// Стоп-слова: их выкидываем при выделении искомого термина
const STOPWORDS = new Set([
  'покажи', 'показать', 'дай', 'мне', 'нужны', 'нужен', 'нужно', 'все', 'всё', 'весь',
  'вся', 'список', 'найди', 'найти', 'сколько', 'выгрузи', 'выведи', 'хочу', 'это',
  'и', 'в', 'на', 'по', 'для', 'с', 'со', 'про', 'теги', 'тег', 'тегов', 'тега',
  'оборудование', 'оборудования', 'компоненты', 'компонент', 'компонентов',
  'есть', 'какие', 'какой', 'что', 'a', 'the',
]);

function tokensFrom(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\wа-яё\s-]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Грубое сопоставление с учётом русских окончаний: совпадает, если поле
// содержит токен или его «корень» (токен без 1-2 последних букв)
function fieldMatches(fieldValue: string | undefined, token: string): boolean {
  if (!fieldValue) return false;
  const f = fieldValue.toLowerCase();
  if (f.includes(token)) return true;
  if (token.length > 4) {
    const stem = token.slice(0, token.length - 2);
    if (stem.length >= 3 && f.includes(stem)) return true;
  }
  return false;
}

// Преобразование подсказки раздела в кнопку-действие сообщения
function toAction(s: { label: string; kind: 'ask' | 'tour'; query?: string; tourId?: string }): AssistantAction {
  return s.kind === 'tour'
    ? { label: s.label, kind: 'tour', tourId: s.tourId }
    : { label: s.label, kind: 'ask', query: s.query };
}

// ── Исправление перепутанной раскладки клавиатуры ────────────────────────────
// «gjrf;b ntub» → «покажи теги», «покажи ntub» → «покажи теги», «щзут» → «open».
// Конвертируем только те слова, которые после конвертации становятся знакомыми,
// или явно выглядят как «мусор» в текущей раскладке (латиница без гласных).
const EN2RU: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  '[': 'х', ']': 'ъ', a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о',
  k: 'л', l: 'д', ';': 'ж', "'": 'э', z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и',
  n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'ё',
};
const RU2EN: Record<string, string> = {};
for (const [en, ru] of Object.entries(EN2RU)) RU2EN[ru] = en;

function convertLayout(word: string, map: Record<string, string>): string {
  let out = '';
  for (const ch of word) {
    const lower = ch.toLowerCase();
    const rep = map[lower];
    out += rep === undefined ? ch : (ch === lower ? rep : rep.toUpperCase());
  }
  return out;
}

// Знакомые русские слова: команды помощника + синонимы полей словаря
let VOCAB_RU: string[] | null = null;
function vocabRu(): string[] {
  if (!VOCAB_RU) {
    const words = new Set<string>([
      'покажи', 'показать', 'найди', 'найти', 'сколько', 'выгрузи', 'выведи', 'открой',
      'характеристики', 'данные', 'параметры', 'оборудование', 'теги', 'тег', 'дубли',
      'дубликаты', 'проект', 'проекты', 'файл', 'файлы', 'папка', 'заметка', 'заметки',
      'чат', 'сотрудники', 'критичные', 'позиции', 'позиция', 'этап', 'заказан', 'куплен',
      'закупки', 'менеджмент', 'проводник', 'блокнот', 'справочник', 'помощь', 'привет',
      'умеешь', 'создай', 'создать', 'вентилятор', 'вентиляторы', 'клапан', 'клапаны',
      'фильтр', 'нагреватель', 'охладитель', 'установка', 'кондиционер', 'сводка', 'демонстрация',
    ]);
    for (const f of FIELDS) {
      for (const w of f.label.toLowerCase().split(/\s+/)) if (w.length >= 3) words.add(w);
      for (const syn of f.synonyms) for (const w of syn.split(/\s+/)) if (w.length >= 3) words.add(w);
    }
    VOCAB_RU = [...words];
  }
  return VOCAB_RU;
}
function isKnownRu(token: string): boolean {
  if (token.length < 3) return false;
  const p = Math.min(5, token.length);
  const head = token.slice(0, p);
  return vocabRu().some(w => w.slice(0, p) === head);
}
const VOCAB_EN = ['show', 'open', 'find', 'help', 'tags', 'tag', 'files', 'file', 'create',
  'equipment', 'project', 'projects', 'chat', 'notes', 'note', 'export', 'excel', 'word', 'demo'];

export function fixKeyboardLayout(text: string): string {
  return text.split(/(\s+)/).map(tok => {
    const t = tok.trim();
    // Коды/теги (3700-B02…), короткие слова и числа не трогаем
    if (!t || t.length < 3 || /\d/.test(t) || /-/.test(t)) return tok;
    if (/^[a-z\[\];',.`]+$/i.test(t)) {
      // Латиница: возможно, русское слово в английской раскладке
      const conv = convertLayout(t, EN2RU);
      if (/^[а-яё]+$/i.test(conv)) {
        if (isKnownRu(conv.toLowerCase())) return conv;
        // без гласных в латинице, но с гласными после конвертации — почти наверняка раскладка
        if (!/[aeiouy]/i.test(t) && /[аеёиоуыэюя]/i.test(conv)) return conv;
      }
    } else if (/^[а-яё]+$/i.test(t)) {
      // Кириллица: возможно, английское слово в русской раскладке
      const conv = convertLayout(t, RU2EN).toLowerCase();
      if (/^[a-z]+$/.test(conv) && VOCAB_EN.includes(conv) && !isKnownRu(t.toLowerCase())) return conv;
    }
    return tok;
  }).join('');
}

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
      const sec = getSection(route);
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
    const sec = getSection(get().currentRoute);
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
    const sec = getSection(route);
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
    if (action.kind === 'tour' && action.tourId) {
      get().startTour(action.tourId);
    } else if (action.kind === 'ask' && action.query) {
      get().ask(action.query);
    } else if (action.kind === 'export-excel' && get().lastTable) {
      exportTableToExcel(get().lastTable!);
    } else if (action.kind === 'export-word' && get().lastTable) {
      exportTableToWord(get().lastTable!);
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

// Результат распознавания: сообщение + (опционально) контекст последнего списка
// + (опционально) переход в режим ожидания ввода (диалоговое действие)
interface Resolved { message: AssistantMessage; result?: LastResult | null; pending?: PendingInput; }
const msg = (text: string, extra: Partial<AssistantMessage> = {}): Resolved =>
  ({ message: { id: uid(), role: 'assistant', text, ...extra } });

const EXPORT_ACTIONS: AssistantAction[] = [
  { label: 'Выгрузить в Excel', kind: 'export-excel' },
  { label: 'Выгрузить в Word', kind: 'export-word' },
];

// Разделы для навигационных команд «открой …»
const ROUTE_WORDS: { stems: string[]; route: string; name: string }[] = [
  { stems: ['менеджмент', 'закупк'], route: '/management', name: 'Менеджмент' },
  { stems: ['тег', 'реестр', 'схем', 'холст', 'граф'], route: '/registry', name: 'Теги' },
  { stems: ['оборудован'], route: '/equipment', name: 'Оборудование' },
  { stems: ['проводник', 'файл'], route: '/explorer', name: 'Проводник' },
  { stems: ['блокнот', 'заметк'], route: '/notes', name: 'Блокнот' },
  // «конструктор» остаётся в стемах намеренно: программа переименована, а
  // привычка — нет, и «открой конструктор» обязано работать
  { stems: ['таблиц', 'конструктор', 'эксел', 'книг', 'ведомост'], route: '/sheet', name: 'Таблица' },
  { stems: ['документ', 'ворд', 'записк', 'текстов'], route: '/doc', name: 'Документ' },
  { stems: ['справочник', 'словар'], route: '/directory', name: 'Справочник' },
  { stems: ['чат', 'переписк'], route: '/chat', name: 'Рабочий чат' },
  { stems: ['проект'], route: '/projects', name: 'Проекты' },
];

// Ответы про характеристики позиции («какой расход у 3700-…») собраны
// в src/assistant/specAnswers.ts — там же словарь величин и справочник обозначений
// ═══════════ Живая речь ═══════════
// Помощник работает без интернета и без языковой модели: он разбирает
// запрос правилами. Чтобы это не выглядело общением с автоматом, здесь
// три вещи: понимание разговорных оборотов, починка опечаток и внятный
// ответ, когда вопрос действительно не про программу.

/** Расстояние Дамерау—Левенштейна с ранним выходом: опечатки в одно-два касания. */
function editDistance(a: string, b: string, limit = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > limit) return limit + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Словарь, по которому чиним опечатки: разделы, поля, частые глаголы. */
function repairVocabulary(): string[] {
  const words = new Set<string>();
  for (const r of ROUTE_WORDS) for (const st of r.stems) words.add(st);
  for (const w of ['покажи', 'открой', 'найди', 'выгрузи', 'сколько', 'дубли', 'заказано',
    'закупки', 'просрочено', 'вентилятор', 'насос', 'расход', 'напор', 'мощность',
    'ревизия', 'статус', 'отдел', 'проект', 'шаблон', 'подстановки', 'корзина']) words.add(w);
  try { for (const w of vocabRu()) if (w.length >= 5) words.add(w); } catch (_) {}
  return [...words];
}
let REPAIR_CACHE: string[] | null = null;

/**
 * Чинит очевидные опечатки: «покожи вентилчторы» → «покажи вентиляторы».
 * Правим только слова длиннее четырёх букв и только на одну-две ошибки,
 * иначе можно «исправить» осмысленное слово в чужое.
 */
export function repairTypos(text: string): string {
  if (!REPAIR_CACHE) REPAIR_CACHE = repairVocabulary();
  return text.split(/(\s+)/).map((chunk) => {
    const w = chunk.toLowerCase();
    if (w.length < 5 || !/^[а-яё-]+$/i.test(w)) return chunk;
    // Известное слово не трогаем: иначе «можешь» превращается в «модель».
    if (isKnownRu(w) || STOPWORDS.has(w)) return chunk;
    if (REPAIR_CACHE!.some((v) => w.startsWith(v) || v.startsWith(w))) return chunk;
    let best: string | null = null, bestD = 3;
    for (const v of REPAIR_CACHE!) {
      if (Math.abs(v.length - w.length) > 2) continue;
      // Две ошибки правим только когда слово начинается одинаково: иначе
      // «подсказать» «чинится» в «показать», а это другое слово и другой
      // ответ. Опечатки в первых буквах редки — там смотрит глаз.
      const d = editDistance(w, v, 2);
      if (d >= 2 && w.slice(0, 3) !== v.slice(0, 3)) continue;
      if (d < bestD) { bestD = d; best = v; }
    }
    return bestD <= 2 && best ? best : chunk;
  }).join('');
}

/** Разговорные обороты, на которые нельзя отвечать «не понял». */
const SMALL_TALK: { test: RegExp; reply: () => string }[] = [
  { test: /^(привет|здравств|добрый (день|вечер|утр)|хай)/i,
    reply: () => 'Здравствуйте. Спрашивайте про данные проекта обычными словами — найду и покажу.' },
  { test: /(спасиб|благодар|отлично|супер|класс|понятно)/i,
    reply: () => 'Рад помочь. Если что-то ещё нужно найти — спрашивайте.' },
  { test: /(как дела|как ты|ты живой|ты человек|кто ты|ты бот|ты робот)/i,
    reply: () => 'Я помощник внутри программы: работаю на этом компьютере, без интернета. Языковой модели во мне нет — я разбираю вопрос по словам и ищу в данных проекта. Поэтому лучше всего отвечаю на вопросы про теги, оборудование, закупки, документы и файлы.' },
  { test: /(^пока$|до свидан|всего доброго)/i,
    reply: () => 'До связи. Ctrl+K — и я снова тут.' },
  { test: /(извин|прости|сорри)/i,
    reply: () => 'Ничего страшного. Что найти?' },
  { test: /(ты (можешь|умеешь) (всё|все)|любой вопрос|что угодно)/i,
    reply: () => 'Отвечу не на всё: я не языковая модель и не выхожу в интернет. Зато знаю данные этого проекта — теги, оборудование, закупки, документы, файлы — и разделы программы. Спросите, например: «что не заказано» или «где 3700-K02».' },
];

function smallTalkAnswer(lower: string): string | null {
  for (const st of SMALL_TALK) if (st.test.test(lower)) return st.reply();
  return null;
}

/**
 * Вежливая обёртка вокруг запроса: убираем «а можешь», «слушай»,
 * «будь добр» — они мешают разбору, но по-человечески их пишут постоянно.
 */
export function stripPoliteness(text: string): string {
  // Границы слова задаём через просмотр назад/вперёд: \b в JavaScript
  // считает буквой только латиницу, и на кириллице просто не срабатывает.
  const W = '(?<![\\p{L}])';
  const E = '(?![\\p{L}])';
  const drop = (body: string, tail = '[,\\s]*') =>
    new RegExp(`${W}(?:${body})${E}${tail}`, 'giu');
  return text
    // Формы «подсказать», «подскажешь», «подскажи-ка» пишут не реже
    // повелительного «подскажи», поэтому убираем корень целиком.
    .replace(drop('слушай(?:те)?|скажи(?:те)?|подскаж[а-яё]*|подсказ[а-яё]*|будь добр[а-яё]*|будьте добры|плиз'), '')
    .replace(drop('а\\s+(?:можешь|можете|мог бы|могли бы)'), '')
    .replace(drop('можешь|можете|не мог бы ты|не могли бы вы|мог бы ты|могли бы вы'), '')
    .replace(drop('пожалуйста|будьте любезны|очень нужно|хотел[аи]? бы узнать|хочу узнать'), '')
    .replace(/^[\s,]+/, '')
    .replace(/\s*,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Служебные слова запроса: домен («тег», «оборудование»), команда («покажи»),
 * название среза («дубли», «закупки»). Фильтром поиска они быть не могут —
 * иначе «покажи все теги» ищет теги, в названии которых есть слово «тег».
 *
 * Сравниваем по началу слова, а не на равенство: стеммер оставляет короткие
 * слова как есть, поэтому «теги» так и остаётся «теги» и мимо списка из
 * точных совпадений проходило насквозь.
 */
const SERVICE_WORDS = [
  'тег', 'оборудован', 'компонент', 'покажи', 'показ', 'список', 'найд', 'сколько', 'выгруз',
  'критичн', 'внимани', 'проблем', 'конфликт', 'дубл', 'закупк', 'этап', 'поставщик',
  'заметк', 'запис', 'истори', 'изменени', 'изменил', 'сводк', 'статус',
  'позици', 'позиц', 'штук', 'заказан', 'куплен', 'закуплен', 'утвержд', 'добавлен',
  'осталось', 'просроч', 'требует', 'требуют', 'экспорт', 'вывед', 'собер',
  // форматы выгрузки: «выгрузи в эксель» — это про формат, а не про то,
  // что искать; иначе помощник отвечал «по запросу „эксел“ теги не найдены»
  'эксел', 'ексел', 'excel', 'xlsx', 'ворд', 'word', 'docx', 'pdf',
];
function isServiceWord(s: string): boolean {
  return SERVICE_WORDS.some(w => s.startsWith(w) || w.startsWith(s));
}

// --- Распознавание запроса (полностью локальное) ---
// injectedData — тестовый шов: подставить данные вместо обращения к серверу.
export async function resolveQuery(
  text: string, demoMode = false, lastResult: LastResult | null = null,
  injectedData?: AssistantData,
): Promise<Resolved> {
  // Живая речь: убираем вежливые обороты, чиним опечатки, отвечаем на
  // разговорное — и только потом разбираем как запрос к данным.
  const talk = smallTalkAnswer(text.toLowerCase());
  if (talk) return msg(talk);
  // Дальше по всей функции работаем с очищенным текстом: иначе разбор
  // спотыкается о «слушай», «а можешь», «пожалуйста» — их пишут постоянно.
  text = repairTypos(stripPoliteness(text));
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  const p = parse(text);
  const getData = () => injectedData ? Promise.resolve(injectedData) : fetchAssistantData();

  // Режим «Демонстрация»: любой вопрос → ближайшая по смыслу демонстрация
  if (demoMode) {
    const m = findBestTour(text);
    if (m && m.tour) {
      return msg(
        m.score >= 1.5 ? m.tour.intro : `Похоже, вам подойдёт демонстрация «${m.tour.title}». ${m.tour.intro}`,
        { actions: [{ label: '▶ Показать демонстрацию', kind: 'tour', tourId: m.tour.id }] }
      );
    }
    return msg('Не нашёл подходящую демонстрацию. Попробуйте, например, «как добавить тег» или «как импортировать оборудование».');
  }

  // A0. Поиск по почте: «покажи все письма про 20-PT-001», «письма от Иванова».
  //
  // Ищем по всем ящикам, до которых у человека есть доступ, а не только по
  // открытому: в каком ящике лежит нужное письмо — вопрос не к спрашивающему.
  if (asksToFindMail(text)) return { message: await mailSearchMessage(text) };

  // A1. «Где в руководстве написано про …» — руководство отвечает первым
  if (asksWhereWritten(text)) {
    const hb = handbookMessage(text, 2);
    if (hb) return { message: hb };
  }

  // A. Навигационная команда: «открой/перейди в <раздел>»
  if (/(^|\s)(открой|открыть|перейд|зайд|покажи раздел|переключ)/.test(lower)) {
    for (const r of ROUTE_WORDS) {
      if (hasIntent(p, r.stems)) {
        return msg(`Открываю раздел «${r.name}».`, {
          actions: [{ label: `Перейти в «${r.name}»`, kind: 'open-section', route: r.route }],
        });
      }
    }
  }

  // B. Команда «создай заметку [про X]»
  if (/(создай|создать|新)\s*(заметк|запис)/.test(lower) || /(заметк|запис).*(создай|добав|нов)/.test(lower)) {
    // \w в JavaScript не включает кириллицу: с ним «заметку про П1» давало
    // заголовок «у про П1» — окончание слова оставалось в тексте заметки.
    const about = text.replace(/^.*?(?:заметк[а-яё]*|запис[а-яё]*)\s*(?:про|об|о)?\s*/i, '').trim();
    const title = about && about.length < 60 ? about : 'Новая заметка';
    return msg(`Создаю заметку${about ? ` «${title}»` : ''} в блокноте.`, {
      actions: [{ label: 'Открыть блокнот', kind: 'create-note', noteTitle: title }],
    });
  }

  // C. Вопрос-определение → справка
  if (/(что так|что эт|для чего|зачем|расскажи|объясни|чем отлич|что значит|как работает)/.test(lower)) {
    const knowledge = findKnowledge(lower);
    if (knowledge) return msg(knowledge);
  }

  // D. Демонстрация: «как …»
  const wantsTour = /(^|[^а-яёa-z])как([^а-яёa-z]|$)/i.test(lower)
    || /(демонстрац|научи|инструкц|покажи как|пошагов)/.test(lower);
  if (wantsTour) {
    const tourM = findBestTour(lower);
    const knowM = matchKnowledge(lower);
    // Демонстрация подбирается по пересечению слов, и одного общего слова
    // хватало, чтобы перебить справку: на «как вернуть удалённый файл»
    // открывался показ загрузки файлов — просто потому, что там есть
    // слово «файл». Поэтому когда статья справки зацепилась за длинное
    // конкретное слово, демонстрация должна быть увереннее обычного.
    const strongKnowledge = !!knowM && knowM.score >= 6;
    const need = strongKnowledge ? 3 : 1.5;
    if (tourM && tourM.score >= need) {
      return msg(tourM.tour.intro, { actions: [{ label: '▶ Показать демонстрацию', kind: 'tour', tourId: tourM.tour.id }] });
    }
    if (strongKnowledge) {
      // Демонстрацию не теряем — предлагаем её кнопкой рядом с ответом.
      const extra: AssistantAction[] = tourM && tourM.score >= 1.5
        ? [{ label: '▶ Показать демонстрацию', kind: 'tour', tourId: tourM.tour.id }] : [];
      return msg(knowM!.answer, { actions: extra });
    }
  }

  // D2. Переименование тега: «переименуй 3700-A», «смени код 3700-A на 3700-B»,
  // «поменяй тег 3700-A → 3700-B». Связи сохраняются (хранятся по id тега).
  const renameIntent = /(переимен|renam)/.test(lower)
    || (/(смен|помен|замен|исправ|переправ)\w*/.test(lower) && /(тег|код|назван|номер|марк)/.test(lower));
  if (renameIntent && p.codes.length > 0) {
    const data = await getData();
    const oldCode = p.codes[0];
    const matches = data.tags.filter(t => (t.identifier || '').trim().toLowerCase() === oldCode.toLowerCase());
    if (matches.length === 0) {
      return msg(`Не нашёл тег «${oldCode}» в проекте. Проверьте код или скажите «покажи теги».`);
    }
    // Код-дубликат: нужно выбрать конкретный экземпляр
    if (matches.length > 1) {
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `Код «${oldCode}» встречается ${matches.length} раз — выберите, какой тег переименовать:`,
          list: matches.map(t => ({
            id: t.id, title: t.identifier || oldCode, subtitle: t.mainName || t.department || '', badge: 'дубль',
            actions: [
              { label: 'Переименовать', kind: 'prompt-rename-tag', tagId: t.id, code: t.identifier || oldCode },
              { label: 'На Схеме', kind: 'focus-tag', tagId: t.id },
            ],
          })),
        },
      };
    }
    const tag = matches[0];
    // Явно указан новый код → переименовываем сразу
    if (p.codes.length >= 2) {
      const v = validateTagCode(p.codes[1]);
      if (!v.ok) return msg(`Не могу применить код «${p.codes[1]}»: ${v.error}.`);
      if (v.code.toLowerCase() === oldCode.toLowerCase()) return msg('Новый код совпадает со старым — менять нечего.');
      try {
        const collision = data.tags.filter(t => t.id !== tag.id && (t.identifier || '').trim().toLowerCase() === v.code.toLowerCase()).length;
        await renameTagApi(tag.id, v.code);
        const warn = collision > 0 ? `\n⚠ Такой код уже есть у ${collision} тег(ов) — образовался новый дубль.` : '';
        return {
          message: {
            id: uid(), role: 'assistant',
            text: `✅ Переименовал: «${oldCode}» → «${v.code}». Связи и комментарии сохранены.${warn}`,
            actions: [
              { label: 'Показать на Схеме', kind: 'focus-tag', tagId: tag.id },
              { label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' },
            ],
          },
        };
      } catch (err: any) {
        return msg(`Не удалось переименовать: ${err.message}`);
      }
    }
    // Новый код не указан → входим в диалог: следующая реплика станет новым кодом
    return {
      message: {
        id: uid(), role: 'assistant',
        text: `Введите новый код для тега «${tag.identifier || oldCode}». Связи и комментарии сохранятся.\n(или напишите «отмена»)`,
        actions: [{ label: 'Отмена', kind: 'cancel-input' }],
      },
      pending: { kind: 'rename-tag', tagId: tag.id, oldCode: tag.identifier || oldCode },
    };
  }

  // E0. Характеристики позиции из «Оборудования»: «какой расход у 3700-…»,
  // «характеристики 3700-…», «собери расход и мощность у …» (в т.ч. по нескольким тегам)
  if (p.codes.length > 0) {
    const field = askedField(lower, text);
    const wantsSpecs = !!field || /(характеристик|данные|парам|собери|выпиши|сведени)/.test(lower);
    if (wantsSpecs) {
      const data = await getData();

      // Одна позиция + конкретное поле → короткий ответ
      if (p.codes.length === 1 && field) {
        const comp = findComponentByCode(data.components, p.codes[0]);
        if (comp && comp.specs) {
          const sv = specForField(comp.specs, field);
          if (sv) {
            return msg(`${field.label} у ${p.codes[0]}: ${sv.value}${sv.unit ? ' ' + sv.unit : ''}.`,
              { actions: [{ label: 'Показать в оборудовании', kind: 'focus-equipment', componentId: comp.id, specKey: sv.key }] });
          }
          return msg(`У «${p.codes[0]}» характеристику «${field.label}» не нашёл — показать все характеристики?`,
            { actions: [{ label: 'Все характеристики', kind: 'ask', query: `характеристики ${p.codes[0]}` }] });
        }
        // Характеристики живут у изделия, а не у тега. Спросили про величину,
        // а изделия за тегом нет — так и говорим: раньше здесь молча
        // показывалась карточка тега с этапом закупки, и человек считал, что
        // расход у позиции действительно такой.
        const noComp = tagWithoutEquipment(data, p.codes[0]);
        if (noComp) return { message: noComp };
      }

      // Одна позиция без конкретного поля → все её характеристики
      if (p.codes.length === 1 && !field) {
        const comp = findComponentByCode(data.components, p.codes[0]);
        if (comp && comp.specs && comp.specs.length) {
          const table: AssistantTable = {
            title: `Характеристики ${p.codes[0]}`,
            columns: ['Характеристика', 'Значение', 'Ед.'],
            rows: comp.specs.map(s => [s.key, s.value, s.unit]),
          };
          // Список приходит обрезанным — говорим об этом прямо, иначе обрыв
          // читается как «больше у позиции ничего нет»
          const total = comp.specsTotal ?? comp.specs.length;
          const shown = total > comp.specs.length
            ? `${comp.specs.length} из ${total}`
            : `${comp.specs.length}`;
          return { message: { id: uid(), role: 'assistant', text: `Характеристики «${comp.name || p.codes[0]}»: показано ${shown} параметр(ов).`, table,
            actions: [{ label: 'Показать в оборудовании', kind: 'focus-equipment', componentId: comp.id }, ...EXPORT_ACTIONS] }, result: null };
        }
        const noComp = tagWithoutEquipment(data, p.codes[0]);
        if (noComp) return { message: noComp };
      }

      // Несколько позиций → сводная таблица (по указанному полю или ключевым)
      if (p.codes.length > 1) {
        const cols = field ? [field] : ['airflow', 'pressure', 'power'].map(id => FIELDS.find(f => f.id === id)).filter(Boolean) as FieldDef[];
        const rows: (string | number)[][] = p.codes.map(code => {
          const comp = findComponentByCode(data.components, code);
          return [code, ...cols.map(f => {
            const sv = comp && comp.specs ? specForField(comp.specs, f) : null;
            return sv ? `${sv.value}${sv.unit ? ' ' + sv.unit : ''}` : '—';
          })];
        });
        const table: AssistantTable = { title: field ? `${field.label} по позициям` : 'Характеристики позиций', columns: ['Тег', ...cols.map(f => f.label)], rows };
        return { message: { id: uid(), role: 'assistant', text: `Собрал данные по ${p.codes.length} позиц.`, table, actions: EXPORT_ACTIONS }, result: null };
      }
    }
  }

  // E. Прямой код тега/марки → карточка позиции
  if (p.codes.length > 0) {
    const data = await getData();
    const code = p.codes[0];
    const found = data.tags.filter(t => (t.identifier || '').toLowerCase() === code.toLowerCase()
      || (t.identifier || '').toLowerCase().includes(code.toLowerCase())
      || (t.brand || '').toLowerCase().includes(code.toLowerCase()));
    if (found.length) {
      const t = found[0];
      const dup = data.duplicates.find(d => d.code === (t.identifier || '').trim());
      const actions: AssistantAction[] = [
        { label: 'Открыть на Схеме', kind: 'focus-tag', tagId: t.id },
        { label: 'Показать в Менеджменте', kind: 'open-section', route: '/management' },
      ];
      if (dup) actions.push({ label: `Найти дубли (${dup.count})`, kind: 'find-duplicates', code: dup.code });
      const lines = [
        `${t.identifier}${t.mainName ? ` — ${t.mainName}` : ''}`,
        t.brand ? `Марка: ${t.brand}` : '',
        t.department ? `Отдел: ${t.department}` : '',
        `Актуальность: ${ACTUALITY_RU[t.actuality || 'draft'] || t.actuality}`,
        `Этап закупки: ${t.stageLabel || '—'}${t.supplier ? `, поставщик: ${t.supplier}` : ''}`,
        dup ? `⚠ Дубль кода: встречается ${dup.count} раз(а)` : '',
      ].filter(Boolean);
      return { message: { id: uid(), role: 'assistant', text: lines.join('\n'), actions }, result: { kind: 'tags', ids: found.map(f => f.id), label: code } };
    }
  }

  // F. Follow-up: «а сколько их / выгрузи / покажи их» по прошлому результату
  if (lastResult && /^(а\s+)?(сколько|скольк).{0,6}(их| их\?)?$|^выгруз|^экспорт|^покажи их|^их$/.test(lower.trim())) {
    if (/выгруз|экспорт/.test(lower)) {
      return msg(`Готовлю выгрузку по предыдущему списку «${lastResult.label}» — нажмите кнопку.`, { actions: EXPORT_ACTIONS });
    }
    return msg(`В предыдущем списке «${lastResult.label}»: ${lastResult.ids.length}.`);
  }

  // F2. Вопрос про саму программу: «где корзина», «куда делся файл»,
  // «почему не вижу подборки». Такие вопросы перехватывал поиск по данным
  // и отвечал «по запросу „корзи“ теги не найдены» — человек спрашивал про
  // раздел, а получал пустой список. Поэтому справку с уверенным
  // совпадением спрашиваем до поиска, но только если в вопросе нет кода
  // тега (тогда это точно запрос к данным).
  if (p.codes.length === 0
      && /(^|[^а-яе])(где|куда|откуда|почему|зачем|что делать|не могу найти|не нахожу|не вижу|не работает)([^а-яе]|$)/u.test(lower)) {
    const k = matchKnowledge(lower);
    if (k && k.score >= 6) return msg(k.answer);
  }

  // G. Домены данных
  const wantsData =/(покажи|показать|список|сколько|количеств|выгруз|экспорт|найд|дай|выведи|собери|все|всё|скольк)/.test(lower)
    || hasIntent(p, ['тег', 'оборудован', 'компонент', 'вентилятор', 'установк', 'клапан', 'проект', 'систем', 'дубл', 'закупк', 'критичн', 'внимани', 'проблем', 'заметк', 'этап', 'поставщик'])
    || /не заказан|не куплен|куплен|закуплен|заказан|утвержд|просроч|что изменилос|кто менял|что менял|последн.*(действ|измен|запис)|что требует|требует внимани|конфликт ревиз|завис|застря|не двига|без движ|дольше \d+|больше \d+ дн|на этапе/.test(lower);
  if (wantsData) {
    const data = await getData();
    const c = data.counts;

    // Остаточные стемы — то, что осталось после служебных/доменных слов.
    // Позволяют пересекать фильтры: «критичные ВЕНТИЛЯТОРЫ», «не заказаны КЛАПАНЫ».
    const filterStems = p.stems.filter(s => !isServiceWord(s));
    const tagTextMatch = (t: AssistantData['tags'][number], stems: string[]) =>
      fieldMatchesStems(t.identifier, stems) || fieldMatchesStems(t.brand, stems)
      || fieldMatchesStems(t.mainName, stems) || fieldMatchesStems(t.department, stems)
      || fieldMatchesStems(t.fluid, stems);

    // G1. Сводка/счётчики
    if (hasIntent(p, ['сводк', 'статус']) || /сколько всего|общая|итого|готовност/.test(lower)
        || (/сколько|количеств/.test(lower) && !hasIntent(p, ['дубл', 'критичн', 'закупк', 'вентилятор', 'клапан', 'установк']))) {
      const problems = (c.critical || 0) + (c.duplicates || 0);
      return msg(
        `Сводка по активному проекту:\n• Тегов: ${c.tags}\n• Оборудования: ${c.components}\n• Систем: ${c.systems}\n• Файлов: ${c.files}, заметок: ${c.notes}\n` +
        `${problems > 0 ? `\n⚠ Требуют внимания: критичных ${c.critical || 0}, дублей ${c.duplicates || 0}.` : '\n✓ Критичных позиций и дублей нет.'}`,
        { actions: problems > 0 ? [{ label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' }, { label: 'Показать критичные', kind: 'ask', query: 'критичные позиции' }] : [] }
      );
    }

    // G2. Дубли
    if (hasIntent(p, ['дубл'])) {
      if (data.duplicates.length === 0) return msg('Дубликатов кодов тегов в проекте нет — все коды уникальны. 👍');
      const tagById: Record<string, AssistantData['tags'][number]> = {};
      for (const t of data.tags) tagById[t.id] = t;
      // Раскрываем группы дублей в отдельные экземпляры с кнопками действий
      const list: AssistantListItem[] = [];
      for (const d of data.duplicates) {
        d.ids.forEach((id, i) => {
          const t = tagById[id];
          list.push({
            id,
            title: t?.identifier || d.code,
            subtitle: `${t?.mainName || t?.department || 'без наименования'} · экземпляр ${i + 1} из ${d.count}`,
            badge: 'дубль',
            actions: [
              { label: 'Переименовать', kind: 'prompt-rename-tag', tagId: id, code: t?.identifier || d.code },
              { label: 'На холсте', kind: 'focus-tag', tagId: id },
            ],
          });
        });
      }
      // Таблица — для выгрузки/контекста (не отображается, когда есть список)
      const table: AssistantTable = {
        title: 'Дубликаты кодов тегов',
        columns: ['Код тега', 'Повторов'],
        rows: data.duplicates.map(d => [d.code, d.count]),
      };
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `Нашёл дублей: ${data.duplicates.length} (всего ${data.duplicates.reduce((s, d) => s + d.count, 0)} позиций).\nНажмите «Переименовать» у любого — я спрошу новый код, а связи сохранятся.`,
          list,
          table,
          actions: EXPORT_ACTIONS,
        },
        result: { kind: 'duplicates', ids: data.duplicates.flatMap(d => d.ids), label: 'дубли' },
      };
    }

    // G3. Проблемы / актуальность (+ пересечение с текстовым фильтром)
    if (hasIntent(p, ['критичн', 'внимани', 'проблем', 'конфликт'])) {
      let bad = data.tags.filter(t => t.actuality === 'critical' || t.actuality === 'warning');
      if (filterStems.length) bad = bad.filter(t => tagTextMatch(t, filterStems));
      const suffix = filterStems.length ? ` по запросу «${filterStems.join(' ')}»` : '';
      if (bad.length === 0) return msg(`Критичных позиций и позиций «на проверку»${suffix} нет. ✓`);
      const table: AssistantTable = {
        title: `Требуют внимания${suffix}`,
        columns: ['Тег', 'Наименование', 'Состояние'],
        rows: bad.map(t => [t.identifier || '', t.mainName || '', ACTUALITY_RU[t.actuality || 'draft'] || '']),
      };
      return {
        message: { id: uid(), role: 'assistant', text: `Требуют внимания${suffix}: ${bad.length} (критичных ${bad.filter(t => t.actuality === 'critical').length}).`, table, actions: EXPORT_ACTIONS },
        result: { kind: 'tags', ids: bad.map(t => t.id), label: 'требуют внимания' },
      };
    }

    // G3.5. Зависшие закупки: позиция стоит на одном этапе слишком долго.
    // Самый частый вопрос снабженца — «что стоит», и раньше на него не было
    // ответа: список этапов показывал, где позиция, но не как давно.
    if (/завис|застря|не двига|без движ|ничего не происходит|дольше \d+|больше \d+ дн/.test(lower)) {
      const data = await getData();
      const days = Number(lower.match(/(\d+)\s*дн/)?.[1] || 14);
      const cut = Date.now() - days * 86400000;
      const stuck = data.tags
        .filter(t => !t.stageIsFinal && t.stageSince && new Date(t.stageSince).getTime() <= cut)
        .map(t => ({ t, days: Math.floor((Date.now() - new Date(t.stageSince as string).getTime()) / 86400000) }))
        .sort((a, b) => b.days - a.days);
      if (stuck.length === 0) {
        return msg(`Позиций, застрявших на этапе дольше ${days} дн., нет — по закупкам всё движется. 👍`);
      }
      const table: AssistantTable = {
        title: `Зависли дольше ${days} дн.`,
        columns: ['Тег', 'Наименование', 'Этап', 'Дней на этапе', 'Поставщик'],
        rows: stuck.map(s => [s.t.identifier || '', s.t.mainName || '', s.t.stageLabel || '', String(s.days), s.t.supplier || '']),
      };
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `Застряли на этапе дольше ${days} дн.: ${stuck.length}. Дольше всех — «${stuck[0].t.identifier}» (${stuck[0].days} дн. на этапе «${stuck[0].t.stageLabel}»).`,
          table,
          actions: [{ label: 'Открыть Менеджмент', kind: 'open-section', route: '/management' }, ...EXPORT_ACTIONS],
        },
        result: { kind: 'tags', ids: stuck.map(s => s.t.id), label: `зависли дольше ${days} дн.` },
      };
    }

    // G4. Закупки / этапы
    if (hasIntent(p, ['закупк', 'этап', 'поставщик']) || /не заказан|не куплен|заказан|куплен|утвержд/.test(lower)) {
      let sel = data.tags;
      let label = 'позиции закупки';
      if (/не заказан|не куплен|осталось|просроч/.test(lower)) { sel = data.tags.filter(t => t.stageId === 'added'); label = 'не заказано'; }
      else if (/куплен|закуплен/.test(lower)) { sel = data.tags.filter(t => t.stageId === 'purchased'); label = 'куплено'; }
      else if (/заказан/.test(lower)) { sel = data.tags.filter(t => t.stageId === 'ordered'); label = 'заказано'; }
      // Пересечение с текстовым фильтром: «не заказаны ВЕНТИЛЯТОРЫ отдела ОВ»
      if (filterStems.length) { sel = sel.filter(t => tagTextMatch(t, filterStems)); label += ` · ${filterStems.join(' ')}`; }
      const table: AssistantTable = {
        title: `Закупки: ${label}`,
        columns: ['Тег', 'Наименование', 'Этап', 'Поставщик'],
        rows: sel.map(t => [t.identifier || '', t.mainName || '', t.stageLabel || '', t.supplier || '']),
      };
      return {
        message: {
          id: uid(), role: 'assistant',
          text: `${label[0].toUpperCase()}${label.slice(1)}: ${sel.length} позиц.`,
          table,
          actions: [{ label: 'Открыть Менеджмент', kind: 'open-section', route: '/management' }, ...EXPORT_ACTIONS],
        },
        result: { kind: 'tags', ids: sel.map(t => t.id), label },
      };
    }

    // G5. Поиск по заметкам
    if (hasIntent(p, ['заметк', 'запис'])) {
      const q = p.stems.filter(s => !['заметк', 'запис', 'блокнот', 'найд', 'поиск'].includes(s) && !isServiceWord(s));
      // Слово в запросе есть, но короткое («заметки П1») — стеммер отбрасывает
      // слова короче трёх букв, поэтому ищем ещё и по исходным словам.
      const words = q.length ? q : p.tokens.filter(t => !['заметки', 'заметку', 'заметка', 'заметок', 'блокнот', 'найди', 'поиск'].includes(t));
      // Просто «покажи заметки» — показываем последние, а не уходим в теги.
      if (words.length === 0) {
        if (!data.notes.length) return msg('Заметок пока нет. Раздел «Блокнот» — там их создают.');
        return msg(`Последние заметки (${data.notes.length}):\n${data.notes.slice(0, 8).map(n => `• ${n.title}`).join('\n')}`, {
          actions: [{ label: 'Открыть блокнот', kind: 'open-section', route: '/notes' }],
        });
      }
      const found = data.notes.filter(n => fieldMatchesStems(n.title, words)
        || words.some(w => (n.title || '').toLowerCase().includes(w)));
      if (found.length === 0) return msg('Заметок по этому запросу не нашёл. Поиск идёт по заголовкам — уточните слово.');
      return msg(`Нашёл заметок: ${found.length}.\n${found.slice(0, 8).map(n => `• ${n.title}`).join('\n')}`, {
        actions: [{ label: 'Открыть заметки', kind: 'open-section', route: '/notes' }],
      });
    }

    // G6. История / последние изменения
    if (hasIntent(p, ['изменени', 'истори', 'изменил']) || /кто менял|что менял|последн.*(действ|измен|запис)|что изменилос/.test(lower)) {
      if (!data.recentLogs.length) return msg('Записей об изменениях пока нет.');
      const items = data.recentLogs.slice(0, 10).map(l => `• ${l.description} — ${l.userName}`);
      return msg(`Последние изменения:\n${items.join('\n')}`);
    }

    // G6.5. Запрос с указанием поля: «теги отдела ОВ», «марка Вентилятор»,
    // «среда вода». Обычный поиск по стемам такое не берёт: сокращения вроде
    // «ОВ» короче трёх букв, и стеммер их выбрасывает. Здесь берём слово
    // после названия поля как есть.
    const FIELD_QUERIES: { re: RegExp; field: 'department' | 'brand' | 'fluid'; name: string }[] = [
      { re: /(?:отдел|департамент)[а-я]*\s+([^\s,.;]+)/u, field: 'department', name: 'отдел' },
      { re: /(?:марк|бренд)[а-я]*\s+([^\s,.;]+)/u, field: 'brand', name: 'марка' },
      { re: /(?:сред|теплоносител|жидкост)[а-я]*\s+([^\s,.;]+)/u, field: 'fluid', name: 'среда' },
    ];
    for (const fq of FIELD_QUERIES) {
      const m = lower.match(fq.re);
      const value = m?.[1]?.trim();
      if (!value || value.length < 2) continue;
      const sel = data.tags.filter(t => (t[fq.field] || '').toLowerCase().replace(/ё/g, 'е').includes(value));
      if (sel.length === 0) {
        const known = [...new Set(data.tags.map(t => t[fq.field]).filter(Boolean))].slice(0, 12);
        return msg(`Тегов с параметром «${fq.name}: ${value}» не нашёл.${known.length ? `\nВ проекте встречаются: ${known.join(', ')}.` : ''}`);
      }
      const table: AssistantTable = {
        title: `Теги · ${fq.name}: ${value}`,
        columns: ['Тег', 'Марка', 'Отдел', 'Среда', 'Этап'],
        rows: sel.map(t => [t.identifier || '', t.brand || '', t.department || '', t.fluid || '', t.stageLabel || '']),
      };
      return {
        message: { id: uid(), role: 'assistant', text: `Нашёл тегов: ${sel.length} (${fq.name}: ${value}).`, table, actions: [...EXPORT_ACTIONS] },
        result: { kind: 'tags', ids: sel.map(t => t.id), label: `${fq.name} ${value}` },
      };
    }

    // G7. Поиск тегов/оборудования (по стемам с синонимами)
    const stems = p.stems.filter(s => !isServiceWord(s));
    const mentionsEquip = hasIntent(p, ['оборудован', 'компонент', 'систем', 'моноблок']);
    const mentionsTag = hasIntent(p, ['тег']);

    const matchedTags = data.tags.filter(tg => stems.length === 0
      || fieldMatchesStems(tg.identifier, stems) || fieldMatchesStems(tg.brand, stems)
      || fieldMatchesStems(tg.department, stems) || fieldMatchesStems(tg.fluid, stems)
      || fieldMatchesStems(tg.mainName, stems));
    const matchedComps = data.components.filter(cm => stems.length === 0
      || fieldMatchesStems(cm.name, stems) || fieldMatchesStems(cm.itemCode, stems)
      || fieldMatchesStems(cm.category, stems) || fieldMatchesStems(cm.systemName, stems)
      || cm.tags.some(tag => fieldMatchesStems(tag, stems)));

    const showTags = mentionsTag || (!mentionsEquip && matchedTags.length >= matchedComps.length);
    if (showTags) {
      if (matchedTags.length === 0) {
        // Прежде чем сказать «не найдено», спрашиваем руководство. Вопрос
        // «чем проектные данные отличаются от общих» доезжал сюда и получал
        // ответ «теги не найдены» — при том, что статья ровно об этом есть.
        const hb = handbookMessage(text, 6);
        if (hb) return { message: hb };
        return msg(stems.length ? `По запросу «${stems.join(' ')}» теги не найдены. Попробуйте другое слово или проверьте активный проект.` : 'В активном проекте пока нет тегов.');
      }
      const table: AssistantTable = {
        title: stems.length ? `Теги: ${stems.join(' ')}` : 'Все теги проекта',
        columns: ['Тег', 'Марка', 'Отдел', 'Среда', 'Этап'],
        rows: matchedTags.map(t => [t.identifier || '', t.brand || '', t.department || '', t.fluid || '', t.stageLabel || '']),
      };
      const actions: AssistantAction[] = [...EXPORT_ACTIONS];
      if (matchedTags.length === 1) actions.unshift({ label: 'Открыть на холсте', kind: 'focus-tag', tagId: matchedTags[0].id });
      return {
        message: { id: uid(), role: 'assistant', text: `Нашёл тегов: ${matchedTags.length}${stems.length ? ` по запросу «${stems.join(' ')}»` : ''}.`, table, actions },
        result: { kind: 'tags', ids: matchedTags.map(t => t.id), label: stems.join(' ') || 'все теги' },
      };
    } else {
      if (matchedComps.length === 0) {
        const hb = handbookMessage(text, 6);
        if (hb) return { message: hb };
        return msg(stems.length ? `По запросу «${stems.join(' ')}» оборудование не найдено.` : 'В активном проекте пока нет оборудования.');
      }
      const table: AssistantTable = {
        title: stems.length ? `Оборудование: ${stems.join(' ')}` : 'Всё оборудование проекта',
        columns: ['Компонент', 'Код', 'Категория', 'Система', 'Теги'],
        rows: matchedComps.map(cm => [cm.name || '', cm.itemCode || '', cm.category || '', cm.systemName || '', cm.tags.join(', ')]),
      };
      return {
        message: { id: uid(), role: 'assistant', text: `Нашёл компонентов: ${matchedComps.length}${stems.length ? ` по запросу «${stems.join(' ')}»` : ''}.`, table, actions: [{ label: 'Открыть Оборудование', kind: 'open-section', route: '/equipment' }, ...EXPORT_ACTIONS] },
        result: { kind: 'components', ids: matchedComps.map(cm => cm.id), label: stems.join(' ') || 'всё оборудование' },
      };
    }
  }

  // H. База знаний (справка о разделах)
  const knowledge = findKnowledge(lower);
  if (knowledge) return msg(knowledge);

  // H2. Руководство. Двадцать с лишним статей знают заметно больше короткого
  // набора заготовок помощника — прежде чем разводить руками, спрашиваем их.
  // Порог здесь высокий: поиск по руководству отвечает почти на любой набор
  // букв, и без порога к каждому вопросу притягивалась бы какая-нибудь статья.
  const hbFallback = handbookMessage(text, 5);
  if (hbFallback) return { message: hbFallback };

  // I. Честное «не знаю»: сначала говорим, что именно поняли из вопроса,
  // и только потом предлагаем темы. «Не понял» без объяснения — самый
  // раздражающий ответ, потому что непонятно, как переспросить.
  const heard = tokensFrom(lower).slice(0, 4);
  const preface = heard.length
    ? `Я разобрал слова: ${heard.map(h => `«${h}»`).join(', ')}, но не нашёл по ним ни тегов, ни оборудования, ни закупок в этом проекте. Возможно, стоит спросить иначе — или вот что я точно умею:`
    : 'Я работаю без интернета и отвечаю по данным этого проекта, а не на общие вопросы. Вот что умею:';
  return msg(
    preface,
    {
      actions: [
        { label: 'Показать дубли', kind: 'ask', query: 'покажи дубли' },
        { label: 'Этапы закупки', kind: 'ask', query: 'что не заказано' },
        { label: 'Как импортировать бланк', kind: 'ask', query: 'как импортировать оборудование' },
        { label: 'Что ты умеешь?', kind: 'navigate', route: '__help' },
      ],
    }
  );
}

const ACTUALITY_RU: Record<string, string> = {
  actual: 'актуально', warning: 'проверить', critical: 'критично', info: 'в работе', draft: 'черновик',
};
