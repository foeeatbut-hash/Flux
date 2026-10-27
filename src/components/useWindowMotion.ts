/**
 * Движение одного окна: связывает изменения состояния окна в хранилище с
 * анимациями из src/lib/windowMotion.ts.
 *
 * Хук смотрит, что именно изменилось между перерисовками: свёрнутость,
 * показ на столе или геометрия по команде. Всё остальное — восстановление
 * раскладки при входе, смена размера стола, перетаскивание — окно не
 * анимирует вовсе.
 */
import React from 'react';
import {
  animateDeskIn, animateFlip, animateMinimize, animateOpen, animateRestore,
  consumeFlip, consumeFresh,
} from '../lib/windowMotion';
import { useWindowStore } from '../store/windowStore';
import type { WinState } from '../lib/windows';

export function useWindowMotion(ref: React.RefObject<HTMLDivElement | null>, win: WinState, hidden: boolean) {
  const prev = React.useRef({
    minimized: win.minimized, hidden,
    rect: { x: win.x, y: win.y, w: win.w, h: win.h },
  });

  // Только что созданное окно открывается; окна из сохранённой раскладки
  // отметки не имеют и появляются сразу на своих местах
  React.useLayoutEffect(() => {
    if (ref.current && consumeFresh(win.id)) animateOpen(ref.current);
  }, []);

  // Без списка зависимостей: сравнение дешёвое, а пропустить нельзя ни одну перерисовку
  React.useLayoutEffect(() => {
    const el = ref.current;
    const p = prev.current;
    prev.current = { minimized: win.minimized, hidden, rect: { x: win.x, y: win.y, w: win.w, h: win.h } };
    if (!el) return;
    const flip = consumeFlip(win.id);
    // Окно на другом столе не видно — двигать нечего
    if (hidden || p.hidden) {
      if (p.hidden && !hidden && !win.minimized) animateDeskIn(el);
      return;
    }
    if (p.minimized !== win.minimized) {
      if (win.minimized) {
        animateMinimize(el, win.path, () => !!useWindowStore.getState().windows.find((w) => w.id === win.id)?.minimized);
      } else animateRestore(el, win.path);
      return;
    }
    const r = p.rect;
    if (flip && !win.minimized && (r.x !== win.x || r.y !== win.y || r.w !== win.w || r.h !== win.h)) animateFlip(el, r);
  });
}
