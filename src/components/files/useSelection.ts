import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WindowsFileEntry } from '../../lib/windowsFiles';

/**
 * Выделение нескольких объектов, как в Проводнике Windows: щелчок, Ctrl+щелчок,
 * Shift+щелчок, Ctrl+A, стрелки, Esc.
 *
 * Выделение хранится не объектами списка, а ключами (`fileId`) и именами: список
 * перечитывается при каждом изменении папки (наблюдатель, действия), и выбор
 * человека не должен слетать от того, что мост вернул новые объекты. Если
 * `fileId` у объекта сменился (файл заменили, переименовали), его находят по
 * имени. Логика без React вынесена в чистые функции — их проверяет набор.
 */

export interface SelectionState {
  /** Выбранные ключи (fileId) */
  ids: string[];
  /** Их имена — запасной способ найти объект после обновления */
  names: Record<string, string>;
  /** От чего тянется диапазон Shift */
  anchor: string | null;
  /** «Текущий» объект — на нём стоят стрелки и от него идёт Enter */
  focus: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: [], names: {}, anchor: null, focus: null };
export const entryKey = (entry: WindowsFileEntry) => entry.fileId;

const pack = (entries: WindowsFileEntry[], ids: string[], anchor: string | null, focus: string | null): SelectionState => {
  const names: Record<string, string> = {};
  for (const entry of entries) if (ids.includes(entryKey(entry))) names[entryKey(entry)] = entry.name;
  return { ids, names, anchor, focus };
};

/** Диапазон между двумя ключами в порядке списка (включительно). */
export function rangeBetween(entries: WindowsFileEntry[], from: string | null, to: string): string[] {
  const end = entries.findIndex((entry) => entryKey(entry) === to);
  const start = from === null ? end : entries.findIndex((entry) => entryKey(entry) === from);
  if (end < 0) return [];
  const [low, high] = start < 0 ? [end, end] : [Math.min(start, end), Math.max(start, end)];
  return entries.slice(low, high + 1).map(entryKey);
}

/** Щелчок мыши по объекту. */
export function applyClick(state: SelectionState, entries: WindowsFileEntry[], entry: WindowsFileEntry, mods: { ctrl?: boolean; shift?: boolean }): SelectionState {
  const key = entryKey(entry);
  if (mods.shift) {
    const range = rangeBetween(entries, state.anchor ?? state.focus, key);
    // Ctrl+Shift добавляет диапазон к уже выбранному, просто Shift заменяет
    const ids = mods.ctrl ? [...new Set([...state.ids, ...range])] : range;
    return pack(entries, ids, state.anchor ?? state.focus ?? key, key);
  }
  if (mods.ctrl) {
    const ids = state.ids.includes(key) ? state.ids.filter((id) => id !== key) : [...state.ids, key];
    return pack(entries, ids, key, key);
  }
  return pack(entries, [key], key, key);
}

export function selectAll(entries: WindowsFileEntry[]): SelectionState {
  const ids = entries.map(entryKey);
  return pack(entries, ids, ids[0] ?? null, ids[ids.length - 1] ?? null);
}

/**
 * Стрелка: сдвиг «текущего» на `delta` объектов. Без Shift выбор схлопывается в
 * новый объект, с Shift — тянется диапазон от якоря. Дальше края не уходит.
 */
export function applyMove(state: SelectionState, entries: WindowsFileEntry[], delta: number, extend: boolean): SelectionState {
  if (!entries.length) return state;
  const current = state.focus === null ? -1 : entries.findIndex((entry) => entryKey(entry) === state.focus);
  // Ничего не выбрано: вниз/вправо начинает с первого, вверх/влево — с последнего, как в Windows
  const target = current < 0 ? (delta > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, current + delta));
  const key = entryKey(entries[target]);
  if (!extend) return pack(entries, [key], key, key);
  const anchor = state.anchor ?? state.focus ?? key;
  return pack(entries, rangeBetween(entries, anchor, key), anchor, key);
}

/**
 * Выбор после обновления списка: что есть, остаётся; что пропало по `fileId`,
 * ищется по имени среди ещё не занятых; чего нет совсем, уходит.
 */
export function reconcileSelection(state: SelectionState, entries: WindowsFileEntry[]): SelectionState {
  if (!state.ids.length && state.focus === null) return state;
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  const taken = new Set(state.ids.filter((id) => byKey.has(id)));
  const remap = new Map<string, string>();
  for (const id of state.ids) {
    if (byKey.has(id)) { remap.set(id, id); continue; }
    const name = state.names[id];
    const found = name === undefined ? undefined : entries.find((entry) => entry.name === name && !taken.has(entryKey(entry)));
    if (found) { remap.set(id, entryKey(found)); taken.add(entryKey(found)); }
  }
  const ids = state.ids.map((id) => remap.get(id)).filter((id): id is string => !!id);
  const sameIds = ids.length === state.ids.length && ids.every((id, index) => id === state.ids[index]);
  const anchor = state.anchor !== null ? remap.get(state.anchor) ?? (byKey.has(state.anchor) ? state.anchor : null) : null;
  const focus = state.focus !== null ? remap.get(state.focus) ?? (byKey.has(state.focus) ? state.focus : null) : null;
  if (sameIds && anchor === state.anchor && focus === state.focus) return state;
  return pack(entries, ids, anchor, focus);
}

/**
 * Хук выделения. `scope` — ключ папки: другая папка сбрасывает выбор, а то же
 * самое обновление списка его сохраняет.
 */
export function useSelection(entries: WindowsFileEntry[], scope: string) {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const scopeRef = useRef(scope);
  const entriesRef = useRef(entries); entriesRef.current = entries;

  useEffect(() => {
    if (scopeRef.current !== scope) { scopeRef.current = scope; setState(EMPTY_SELECTION); return; }
    setState((previous) => reconcileSelection(previous, entries));
  }, [entries, scope]);

  const selected = useMemo(() => {
    const wanted = new Set(state.ids);
    return entries.filter((entry) => wanted.has(entryKey(entry)));
  }, [entries, state.ids]);
  const focused = useMemo(() => entries.find((entry) => entryKey(entry) === state.focus) ?? null, [entries, state.focus]);

  const click = useCallback((entry: WindowsFileEntry, mods: { ctrl?: boolean; shift?: boolean } = {}) => setState((previous) => applyClick(previous, entriesRef.current, entry, mods)), []);
  /** Правая кнопка: объект внутри выбора не трогает выбор, вне его — выбирает один. */
  const context = useCallback((entry: WindowsFileEntry) => setState((previous) => previous.ids.includes(entryKey(entry)) ? { ...previous, focus: entryKey(entry) } : applyClick(previous, entriesRef.current, entry, {})), []);
  const only = useCallback((entry: WindowsFileEntry) => setState(applyClick(EMPTY_SELECTION, entriesRef.current, entry, {})), []);
  const all = useCallback(() => setState(selectAll(entriesRef.current)), []);
  const clear = useCallback(() => setState(EMPTY_SELECTION), []);
  const move = useCallback((delta: number, extend = false) => setState((previous) => applyMove(previous, entriesRef.current, delta, extend)), []);

  return { selected, focused, ids: state.ids, isSelected: (entry: WindowsFileEntry) => state.ids.includes(entryKey(entry)), click, context, only, all, clear, move };
}

/** Прокрутить список так, чтобы объект был виден — стрелками выбор уходит за край. */
export function revealEntry(container: HTMLElement | null, key: string | null) {
  if (!container || key === null) return;
  const node = [...container.querySelectorAll<HTMLElement>('[data-entry-key]')].find((item) => item.dataset.entryKey === key);
  node?.scrollIntoView({ block: 'nearest' });
}
