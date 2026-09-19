/**
 * Подписка на клавиши, которая уважает чужие окна.
 *
 * Тонкая обёртка над правилом из `hotkeys.ts`: собирает обстановку (кто я, кто
 * наверху, что открыто поверх) и зовёт обработчик раздела, только если очередь
 * его. Разделы больше не подписываются на `window.keydown` сами — именно оттуда
 * росли чужой диалог удаления и лишние заметки по Ctrl+N.
 */

import { useEffect, useRef } from 'react';
import { usePaneId } from './paneTitle';
import { useWindowStore } from '../store/windowStore';
import { useOverlayStore } from '../store/overlayStore';
import { shouldHandle, topWindow } from './hotkeys';

/**
 * `handler` берётся ссылкой: разделы пересоздают его каждой отрисовкой, и
 * подписываться заново трижды в секунду незачем. В Блокноте от этого вообще
 * стоял `useEffect` без массива зависимостей — слушатель переподписывался на
 * каждый рендер.
 */
export function useWindowHotkeys(handler: (ev: KeyboardEvent) => void): void {
  const paneId = usePaneId();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const { windows, desk } = useWindowStore.getState();
      const ctx = {
        paneId,
        topWindowId: topWindow(windows as any, desk),
        overlays: useOverlayStore.getState().count,
      };
      if (!shouldHandle(ev, ctx)) return;
      ref.current(ev);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneId]);
}
