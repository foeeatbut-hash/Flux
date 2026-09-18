/**
 * Общий переводчик программы.
 *
 * Одно хранилище на всё: и полоса над письмом, и английская версия ведомости, и
 * всплывающее окошко над выделенным текстом переводят одним и тем же способом.
 * Иначе неминуемо разошлись бы: письмо переводилось бы одними словами, документ
 * — другими, и заказчик получил бы два разных названия одного узла.
 *
 * Словарь и память тянутся с сервера один раз и держатся собранными индексами:
 * перестраивать их на каждую строку ведомости значит подвесить сверку на
 * тысяче строк.
 */
import { create } from 'zustand';
import { makeLatest, stillWanted } from '../lib/latest';
import type { Lang, Segment, TermPair, TmEntry } from '../translate/types';
import { buildIndex, type TermIndex } from '../translate/glossary';
import { buildTm, EMPTY_TM, type TmIndex } from '../translate/tm';
import { translateSegment, translateText } from '../translate/engine';
import { checkEndpoint, askModel } from '../translate/model';
import { loadPack, type PackInfo } from '../translate/pack';

export interface TermRow extends TermPair {
  id: string;
  projectId: string | null;
  source: string;
  locked: boolean;
}

export interface MemoryRow {
  id: string;
  src: string;
  dst: string;
  fromLang: Lang;
  toLang: Lang;
  origin: string;
  updatedAt?: string;
}

/** Подключённый владельцем локальный движок; пусто — движка нет */
export interface ModelSettings {
  url: string;
  key: string;
  /** Спрашивать движок там, где своего перевода не хватило */
  enabled: boolean;
}

const MODEL_KEY = 'flux_translate_model';
const PACK_KEY = 'flux_translate_pack';

/**
 * Состояние словарного пакета. «Нет файла» — не ошибка: сборка может идти без
 * него, и программа тогда работает своим словарём.
 */
export type PackState = 'idle' | 'loading' | 'ready' | 'off' | 'none';

/**
 * Чем закончилась запись в память.
 *
 * `count: 0` при `ok: true` — это «ничего нового, всё уже там». `ok: false` —
 * не сохранилось. Раньше оба случая были нулём, и второй выдавался за первый.
 */
export interface RememberResult { ok: boolean; count: number; error?: string }

const loadPackOn = (): boolean => {
  try {
    return typeof localStorage === 'undefined' ? true : localStorage.getItem(PACK_KEY) !== '0';
  } catch (_) { return true; }
};

const loadModel = (): ModelSettings => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MODEL_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (p && typeof p === 'object') {
      return { url: String(p.url || ''), key: String(p.key || ''), enabled: Boolean(p.enabled) };
    }
  } catch (_) { /* приватный режим */ }
  return { url: '', key: '', enabled: false };
};

interface TranslateState {
  ready: boolean;
  loading: boolean;
  projectId: string;
  /** Какой проект спрашивали последним: по нему отбрасываются поздние ответы */
  wantedProjectId: string;
  terms: TermRow[];
  memory: MemoryRow[];
  model: ModelSettings;
  /** Собранные индексы по направлениям: 'ru>en' и т.д. */
  termIndex: Record<string, TermIndex>;
  tmIndex: Record<string, TmIndex>;

  /** Словарный пакет из открытых источников — младший в старшинстве */
  packOn: boolean;
  packState: PackState;
  packInfo: Pick<PackInfo, 'fromDict' | 'fromWiki'> | null;
  packIndex: Record<string, TermIndex>;
  setPackOn: (on: boolean) => void;

  /**
   * Текст, переданный Переводчику со стороны: из строки Ctrl+K или из
   * всплывающего окошка над выделением. Окно программы забирает его при
   * открытии и очищает — иначе следующий приход в раздел показал бы прошлое.
   */
  pending: string;
  setPending: (text: string) => void;

  load: (projectId: string, force?: boolean) => Promise<void>;
  setModel: (m: Partial<ModelSettings>) => void;
  /** Перевести одну строку — тем же способом, что и всё остальное */
  one: (text: string, from: Lang, to: Lang) => Segment;
  many: (text: string, from: Lang, to: Lang) => Segment[];
  /** Спросить локальный движок; null, если он не подключён или не ответил */
  viaModel: (texts: string[], from: Lang, to: Lang) => Promise<string[] | null>;
  remember: (units: { src: string; dst: string; from: Lang; to: Lang; docId?: string }[]) => Promise<RememberResult>;
  saveTerm: (t: Partial<TermRow>) => Promise<TermRow | null>;
  removeTerm: (id: string) => Promise<RememberResult>;
  removeMemory: (id: string) => Promise<RememberResult>;
  seed: () => Promise<{ added: number }>;
}

const dirKey = (from: Lang, to: Lang) => `${from}>${to}`;
const DIRS: [Lang, Lang][] = [['ru', 'en'], ['en', 'ru'], ['zh', 'ru']];

function buildAll(terms: TermRow[], memory: MemoryRow[]) {
  const termIndex: Record<string, TermIndex> = {};
  const tmIndex: Record<string, TmIndex> = {};
  const pairs: TermPair[] = terms.map((t) => ({ ru: t.ru, en: t.en, zh: t.zh, note: t.note }));
  const units: TmEntry[] = memory.map((m) => ({
    src: m.src, dst: m.dst, from: m.fromLang, to: m.toLang,
  }));
  for (const [from, to] of DIRS) {
    termIndex[dirKey(from, to)] = buildIndex(pairs, from, to);
    tmIndex[dirKey(from, to)] = buildTm(units, from, to);
  }
  return { termIndex, tmIndex };
}

/**
 * Прочитать пакет и собрать по нему индексы.
 *
 * Индексы строятся сразу после чтения, а не при первом переводе: семьдесят
 * тысяч пар собираются полсекунды, и эти полсекунды не должны прийтись на
 * нажатие «Перевести». Здесь они попадают в паузу после запуска.
 */
async function pullPack(set: any, get: () => TranslateState): Promise<void> {
  if (get().packState === 'loading' || get().packState === 'ready') return;
  set({ packState: 'loading' });
  const info = await loadPack();
  if (!info) { set({ packState: 'none', packInfo: null, packIndex: {} }); return; }
  const packIndex: Record<string, TermIndex> = {};
  for (const [from, to] of [['ru', 'en'], ['en', 'ru']] as [Lang, Lang][]) {
    packIndex[dirKey(from, to)] = buildIndex(info.pairs, from, to);
  }
  set({
    packState: 'ready',
    packInfo: { fromDict: info.fromDict, fromWiki: info.fromWiki },
    packIndex,
  });
}

/** Номер последней загрузки словаря: по нему узнаются запоздавшие ответы */
const loads = makeLatest();

export const useTranslateStore = create<TranslateState>((set, get) => ({
  ready: false,
  loading: false,
  projectId: '',
  wantedProjectId: '',
  terms: [],
  memory: [],
  model: loadModel(),
  termIndex: {},
  tmIndex: {},
  packOn: loadPackOn(),
  packState: 'idle',
  packInfo: null,
  packIndex: {},
  pending: '',

  setPackOn: (on) => {
    try { localStorage.setItem(PACK_KEY, on ? '1' : '0'); } catch (_) { /* приватный режим */ }
    set({ packOn: on, packState: on ? 'idle' : 'off' });
    if (on) void pullPack(set, get);
  },

  setPending: (text) => set({ pending: String(text || '') }),

  /**
   * Прочитать словарь проекта.
   *
   * Было: `if (st.loading) return` — то есть переключение на проект B, пока
   * ответы по A ещё в пути, ПРОСТО НЕ ПРОИСХОДИЛО. Ответ A записывал свой
   * projectId и словари, второй загрузки не было, и человек на экране проекта
   * B работал со словарём A. Хуже: `remember` берёт projectId отсюда же, и
   * следующая запомненная строка уходила в чужой проект.
   *
   * Стало: загрузка не отменяется, а нумеруется. Запоздавший ответ узнаётся по
   * номеру и по имени проекта и отбрасывается целиком.
   */
  load: async (projectId, force) => {
    const st = get();
    if (st.ready && st.projectId === projectId && !force && !st.loading) return;
    const token = loads.next();
    set({ loading: true, wantedProjectId: projectId });
    try {
      const [tRes, mRes] = await Promise.all([
        fetch(`/api/translate/terms?projectId=${encodeURIComponent(projectId)}`),
        fetch(`/api/translate/memory?projectId=${encodeURIComponent(projectId)}&from=ru&to=en&limit=20000`),
      ]);
      const tJson = tRes.ok ? await tRes.json() : { items: [] };
      const mJson = mRes.ok ? await mRes.json() : { items: [] };
      const terms: TermRow[] = (tJson.items || []).map((t: any) => ({
        id: t.id, ru: t.ru || '', en: t.en || '', zh: t.zh || '', note: t.note || '',
        projectId: t.projectId || null, source: t.source || 'hand', locked: Boolean(t.locked),
      }));
      const memory: MemoryRow[] = (mJson.items || []).map((m: any) => ({
        id: m.id, src: m.src || '', dst: m.dst || '',
        fromLang: (m.fromLang || 'ru') as Lang, toLang: (m.toLang || 'en') as Lang,
        origin: m.origin || 'hand', updatedAt: m.updatedAt,
      }));
      // Память записана в одну сторону, а нужна в обе: перевод письма ищет тот
      // же сегмент задом наперёд, и заставлять инженера заводить пару дважды
      // было бы издевательством
      const both: MemoryRow[] = [...memory];
      for (const m of memory) {
        both.push({ ...m, id: `${m.id}~`, src: m.dst, dst: m.src, fromLang: m.toLang, toLang: m.fromLang });
      }
      // Пришёл ответ не на последний вопрос — выбрасываем целиком: человек
      // уже смотрит на другой проект, и подставлять ему чужой словарь нельзя
      if (!stillWanted({ latest: loads, token, asked: projectId, wanted: get().wantedProjectId })) return;
      set({ terms, memory, projectId, ready: true, loading: false, ...buildAll(terms, both) });
    } catch (_) {
      if (loads.isCurrent(token)) set({ loading: false, ready: true });
    }
    // Пакет читаем после словаря проекта: он младше и ждать себя не заставляет
    if (!loads.isCurrent(token)) return;
    if (get().packOn) void pullPack(set, get);
    else set({ packState: 'off' });
  },

  setModel: (m) => {
    const next = { ...get().model, ...m };
    set({ model: next });
    try { localStorage.setItem(MODEL_KEY, JSON.stringify(next)); } catch (_) { /* приватный режим */ }
  },

  one: (text, from, to) => {
    const st = get();
    const key = dirKey(from, to);
    return translateSegment(text, {
      from, to, terms: st.termIndex[key], tm: st.tmIndex[key] || EMPTY_TM, pack: st.packIndex[key],
    });
  },

  many: (text, from, to) => {
    const st = get();
    const key = dirKey(from, to);
    return translateText(text, {
      from, to, terms: st.termIndex[key], tm: st.tmIndex[key] || EMPTY_TM, pack: st.packIndex[key],
    });
  },

  viaModel: async (texts, from, to) => {
    const { model } = get();
    if (!model.enabled || !checkEndpoint(model.url).ok) return null;
    return askModel({ url: model.url, key: model.key }, texts, from, to);
  },

  /**
   * Запомнить пары в память переводов.
   *
   * Возвращает исход, а не голое число. Раньше и «ничего нового» и «сервер
   * ответил 500» давали 0, и экран на оба случая говорил «Ничего нового — эти
   * строки уже там». Человек уходил уверенный, что всё на месте, а работа не
   * сохранилась вовсе.
   */
  remember: async (units) => {
    if (!units.length) return { ok: true, count: 0 };
    // Проект берём ОДИН раз, до запроса: пока идёт запись, человек может
    // переключить проект, и вторая половина работы ушла бы не туда
    const projectId = get().projectId;
    try {
      const res = await fetch('/api/translate/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, units }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return { ok: false, count: 0, error: d?.error || `Сервер отказал (${res.status})` };
      }
      const data = await res.json();
      await get().load(projectId, true);
      return { ok: true, count: (data.added || 0) + (data.updated || 0) };
    } catch (_) { return { ok: false, count: 0, error: 'Нет связи с сервером' }; }
  },

  saveTerm: async (t) => {
    try {
      const res = await fetch('/api/translate/terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t, projectId: get().projectId }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      await get().load(get().projectId, true);
      return data.item as TermRow;
    } catch (_) { return null; }
  },

  // Отказ сервера при удалении раньше глотался, и строка исчезала с экрана,
  // оставаясь в базе: при следующем открытии словаря она возвращалась
  removeTerm: async (id) => {
    try {
      const res = await fetch(`/api/translate/terms/${id}`, { method: 'DELETE' });
      if (!res.ok) return { ok: false, count: 0, error: `Не удалось удалить (${res.status})` };
      await get().load(get().projectId, true);
      return { ok: true, count: 1 };
    } catch (_) { return { ok: false, count: 0, error: 'Нет связи с сервером' }; }
  },

  removeMemory: async (id) => {
    try {
      const res = await fetch(`/api/translate/memory/${id.replace(/~$/, '')}`, { method: 'DELETE' });
      if (!res.ok) return { ok: false, count: 0, error: `Не удалось удалить (${res.status})` };
      await get().load(get().projectId, true);
      return { ok: true, count: 1 };
    } catch (_) { return { ok: false, count: 0, error: 'Нет связи с сервером' }; }
  },

  seed: async () => {
    try {
      const res = await fetch('/api/translate/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: get().projectId }),
      });
      if (!res.ok) return { added: 0 };
      const data = await res.json();
      await get().load(get().projectId, true);
      return { added: data.added || 0 };
    } catch (_) { return { added: 0 }; }
  },
}));
