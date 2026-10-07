/**
 * Вкладки Проводника как данные: что открыто, куда вернёт «Назад», что
 * сохранится до следующего запуска. Без React, чтобы правила проверялись
 * скриптом (scripts/test-explorer-shell.ts).
 *
 * У каждой вкладки своя история: переход в одной не двигает «Назад» в
 * другой — так в Windows 11, и так не бывает, когда история одна на окно.
 */
import { HOME, placeKey, type Place, type PlaceKind, type TrailStep } from './places';

export interface ExplorerTab { id: string; history: Place[]; index: number }
export interface TabsState { tabs: ExplorerTab[]; activeId: string }

/** Сколько мест истории и сколько вкладок переживают перезапуск: viewState берёт 64 КБ на ключ */
export const SAVED_HISTORY = 10;
export const MAX_TABS = 20;
export const MAX_HISTORY = 100;

let seq = 0;
export const newTabId = () => `tab-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const makeTab = (place: Place = HOME, id = newTabId()): ExplorerTab => ({ id, history: [place], index: 0 });
export const initialTabs = (place: Place = HOME): TabsState => { const tab = makeTab(place); return { tabs: [tab], activeId: tab.id }; };

export const placeOf = (tab: ExplorerTab): Place => tab.history[tab.index];
export const activeTab = (state: TabsState): ExplorerTab => state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
export const canBack = (tab: ExplorerTab) => tab.index > 0;
export const canForward = (tab: ExplorerTab) => tab.index < tab.history.length - 1;

const patch = (state: TabsState, id: string, change: (tab: ExplorerTab) => ExplorerTab): TabsState =>
  ({ ...state, tabs: state.tabs.map((tab) => tab.id === id ? change(tab) : tab) });

/** Перейти в место: хвост «Вперёд» отбрасывается, как в браузере. Повторный переход в то же место историю не пополняет. */
export function navigate(state: TabsState, place: Place, id = state.activeId): TabsState {
  return patch(state, id, (tab) => {
    if (placeKey(placeOf(tab)) === placeKey(place)) {
      // То же место, но с более полной цепочкой (спустились по черновикам) — цепочку берём новую
      const history = tab.history.slice(); history[tab.index] = place;
      return { ...tab, history };
    }
    const history = [...tab.history.slice(0, tab.index + 1), place];
    const over = Math.max(0, history.length - MAX_HISTORY);
    return { ...tab, history: history.slice(over), index: history.length - 1 - over };
  });
}

/** Шаг по истории: −1 «Назад», +1 «Вперёд», −3 — прыжок через три места из списка у «Назад». */
export const stepHistory = (state: TabsState, delta: number, id = state.activeId): TabsState =>
  patch(state, id, (tab) => ({ ...tab, index: Math.min(tab.history.length - 1, Math.max(0, tab.index + delta)) }));

/** Недавние места для списка у «Назад»: от ближайшего к дальнему, без повторов подряд. */
export function recentBack(tab: ExplorerTab, limit = 10): { place: Place; delta: number }[] {
  const out: { place: Place; delta: number }[] = [];
  for (let i = tab.index - 1; i >= 0 && out.length < limit; i--) out.push({ place: tab.history[i], delta: i - tab.index });
  return out;
}

export const activate = (state: TabsState, id: string): TabsState => state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;

/** Новая вкладка встаёт справа от активной и сразу становится активной. Лишних сверх предела не бывает. */
export function openTab(state: TabsState, place: Place = HOME, activateIt = true): TabsState {
  if (state.tabs.length >= MAX_TABS) return state;
  const tab = makeTab(place);
  const at = state.tabs.findIndex((item) => item.id === state.activeId) + 1;
  const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
  return { tabs, activeId: activateIt ? tab.id : state.activeId };
}

/**
 * Закрыть вкладку. Закрытая активная отдаёт место соседу справа, а у последней —
 * слева: так закрывают вкладки в браузере и в Windows 11. Последнюю не закрывает:
 * закрытие окна решает рама, а не набор вкладок.
 */
export function closeTab(state: TabsState, id: string): TabsState {
  if (state.tabs.length <= 1) return state;
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId !== id ? state.activeId : tabs[Math.min(at, tabs.length - 1)].id;
  return { tabs, activeId };
}

/** Следующая и предыдущая вкладка по кругу — Ctrl+Tab и Ctrl+Shift+Tab. */
export function cycle(state: TabsState, delta: 1 | -1): TabsState {
  const at = state.tabs.findIndex((tab) => tab.id === state.activeId);
  return { ...state, activeId: state.tabs[(at + delta + state.tabs.length) % state.tabs.length].id };
}

/** Переставить вкладку на место другой. Состав не меняется, активная остаётся той же. */
export function moveTab(state: TabsState, id: string, beforeId: string | null): TabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from < 0 || id === beforeId) return state;
  const rest = state.tabs.filter((tab) => tab.id !== id);
  const at = beforeId === null ? rest.length : rest.findIndex((tab) => tab.id === beforeId);
  if (at < 0) return state;
  const tabs = [...rest.slice(0, at), state.tabs[from], ...rest.slice(at)];
  return tabs.every((tab, i) => tab === state.tabs[i]) ? state : { ...state, tabs };
}

// --- Сохранение --------------------------------------------------------------

const KINDS: PlaceKind[] = ['home', 'computer', 'network', 'folder'];
const text = (value: unknown, max = 300) => typeof value === 'string' && value.length <= max ? value : null;

function readStep(raw: any): TrailStep | null {
  const kind = KINDS.includes(raw?.kind) ? raw.kind as PlaceKind : null;
  const name = text(raw?.name);
  if (!kind || name === null) return null;
  let ref: TrailStep['ref'];
  if (raw.ref !== undefined) {
    const rootId = text(raw.ref?.rootId), relativePath = text(raw.ref?.relativePath, 2000), draftId = raw.ref?.draftId === undefined ? undefined : text(raw.ref.draftId);
    if (rootId === null || relativePath === null || draftId === null) return null;
    ref = { rootId, relativePath, ...(draftId ? { draftId } : {}) };
  }
  if (kind === 'folder' && !ref) return null;
  const label = raw.text === undefined ? undefined : text(raw.text);
  return { name, kind, ...(ref ? { ref } : {}), ...(label ? { text: label } : {}) };
}

function readPlace(raw: any): Place | null {
  if (!Array.isArray(raw?.trail) || !raw.trail.length || raw.trail.length > 64) return null;
  const trail: TrailStep[] = [];
  for (const item of raw.trail) { const one = readStep(item); if (!one) return null; trail.push(one); }
  const last = trail[trail.length - 1];
  return { kind: last.kind, name: last.name, ...(last.ref ? { ref: last.ref } : {}), trail };
}

/** Сохранённое в файле настроек — не доверенный ввод: разбираем по полям, мусор отбрасываем, пустой набор — одна «Главная». */
export function readTabs(raw: unknown): TabsState {
  const list = Array.isArray((raw as any)?.tabs) ? (raw as any).tabs.slice(0, MAX_TABS) : [];
  const tabs: ExplorerTab[] = [];
  for (const item of list) {
    const history = (Array.isArray(item?.history) ? item.history.slice(-SAVED_HISTORY) : []).map(readPlace).filter((place: Place | null): place is Place => !!place);
    const id = text(item?.id, 80);
    if (!id || !history.length || tabs.some((tab) => tab.id === id)) continue;
    const index = Number.isInteger(item.index) ? Math.min(history.length - 1, Math.max(0, item.index)) : history.length - 1;
    tabs.push({ id, history, index });
  }
  if (!tabs.length) return initialTabs();
  const activeId = tabs.some((tab) => tab.id === (raw as any)?.activeId) ? (raw as any).activeId : tabs[0].id;
  return { tabs, activeId };
}

/** Что пишется на диск: у каждой вкладки хвост истории, а не вся она. */
export function writeTabs(state: TabsState): unknown {
  return {
    activeId: state.activeId,
    tabs: state.tabs.map((tab) => {
      const from = Math.max(0, tab.history.length - SAVED_HISTORY);
      return { id: tab.id, history: tab.history.slice(from), index: Math.max(0, tab.index - from) };
    }),
  };
}
