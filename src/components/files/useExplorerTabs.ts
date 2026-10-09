import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import {
  activate, activeTab, canBack, canForward, closeTab, cycle, initialTabs, moveTab, navigate, openTab, placeOf, readTabs, recentBack, stepHistory, writeTabs,
  type TabsState,
} from './tabsModel';
import { HOME, type Place } from './places';

/**
 * Вкладки окна Проводника: состояние (`tabsModel`) плюс сохранение через мост.
 *
 * Набор вкладок читается из viewState при открытии окна и пишется туда с
 * задержкой после каждого изменения, поэтому переживает закрытие окна и
 * перезапуск. Без моста (браузер) вкладки работают, только не сохраняются.
 * Пока сохранённое не прочитано, `ready` ложно: экран не должен успеть
 * показать «Главную» и тут же перескочить на сохранённое место.
 */
export const TABS_KEY = 'explorer.tabs.v1';
const SAVE_DELAY = 400;

export interface TabsOptions {
  /** Место, в котором окно открыто «по ссылке»: открывается в активной вкладке после восстановления набора */
  startAt?: Place | null;
  /** Закрывают последнюю вкладку: рама окна решает, закрыть ли окно */
  onLastClosed?: () => void;
  storageKey?: string;
}

export function useExplorerTabs({ startAt = null, onLastClosed, storageKey = TABS_KEY }: TabsOptions = {}) {
  const [state, setState] = useState<TabsState>(() => initialTabs(startAt ?? HOME));
  const [ready, setReady] = useState(false);
  const stateRef = useRef(state); stateRef.current = state;
  const lastClosed = useRef(onLastClosed); lastClosed.current = onLastClosed;
  const startRef = useRef(startAt); startRef.current = startAt;
  const readyRef = useRef(ready); readyRef.current = ready;

  // Чтение сохранённого: один раз, до первого показа
  useEffect(() => {
    let active = true;
    void windowsFilesRequest<Record<string, unknown>>({ action: 'viewStateGet', keys: [storageKey] }).then((answer) => {
      if (!active) return;
      if (answer.ok && answer.data[storageKey]) {
        const restored = readTabs(answer.data[storageKey]);
        setState(startRef.current ? navigate(restored, startRef.current) : restored);
      }
      setReady(true);
    });
    return () => { active = false; };
  }, [storageKey]);

  // Запись: ждём, пока человек перестанет менять, и пишем последнее
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => { void windowsFilesRequest({ action: 'viewStateSet', entries: { [storageKey]: writeTabs(state) } }); }, SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [state, ready, storageKey]);
  // Переход в редактор или общий доступ не должен потерять последние 400 мс навигации.
  useEffect(() => () => {
    if (readyRef.current) void windowsFilesRequest({ action: 'viewStateSet', entries: { [storageKey]: writeTabs(stateRef.current) } });
  }, [storageKey]);

  const active = activeTab(state);
  const place = placeOf(active);
  const go = useCallback((next: Place, id?: string) => setState((s) => navigate(s, next, id)), []);
  const back = useCallback(() => setState((s) => stepHistory(s, -1)), []);
  const forward = useCallback(() => setState((s) => stepHistory(s, 1)), []);
  const jump = useCallback((delta: number) => setState((s) => stepHistory(s, delta)), []);
  const open = useCallback((next: Place = HOME, activateIt = true) => setState((s) => openTab(s, next, activateIt)), []);
  const close = useCallback((id: string = stateRef.current.activeId) => {
    if (stateRef.current.tabs.length <= 1) { lastClosed.current?.(); return; }
    setState((s) => closeTab(s, id));
  }, []);
  const pick = useCallback((id: string) => setState((s) => activate(s, id)), []);
  const step = useCallback((delta: 1 | -1) => setState((s) => cycle(s, delta)), []);
  const move = useCallback((id: string, before: string | null) => setState((s) => moveTab(s, id, before)), []);

  return useMemo(() => ({
    ready, tabs: state.tabs, activeId: state.activeId, active, place,
    canBack: canBack(active), canForward: canForward(active), recent: recentBack(active),
    go, back, forward, jump, open, close, pick, step, move,
  }), [ready, state, active, place, go, back, forward, jump, open, close, pick, step, move]);
}
