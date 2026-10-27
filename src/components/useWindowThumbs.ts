/**
 * Снимки окон для карточек панели задач: что снимать и когда.
 *
 * Правила «когда» — в lib/windowThumb.ts; здесь только чтение разметки и
 * хранилища окон. Окно находится по метке `data-win` (её ставит рама окна).
 */
import React from 'react';
import { useWindowStore } from '../store/windowStore';
import {
  canThumb, captureThumb, coverage, forgetThumb, cachedThumb, shouldCapture, type Rect,
} from '../lib/windowThumb';

function rectOf(id: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-win="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

/**
 * Снять окна, если это уместно. `panelShown` — карточка над столом уже на
 * экране и в кадр попала бы; `force` — окно сворачивается, и это последний
 * случай снять его живым.
 */
export function snapshotWindows(ids: string[], opts: { panelShown?: boolean; force?: boolean } = {}): void {
  if (!canThumb()) return;
  const st = useWindowStore.getState();
  for (const id of ids) {
    const w = st.windows.find((x) => x.id === id);
    if (!w) continue;
    const rect = w.desk === st.desk && !w.minimized ? rectOf(id) : null;
    const above = rect
      ? st.windows.filter((o) => o.id !== id && o.desk === st.desk && !o.minimized && o.z > w.z)
        .map((o) => rectOf(o.id)).filter((r): r is Rect => !!r)
      : [];
    const ask = {
      minimized: !rect,
      covered: rect ? coverage(rect, above) : 0,
      panelShown: !!opts.panelShown,
      cached: cachedThumb(id),
      force: opts.force,
    };
    if (rect && shouldCapture(ask)) void captureThumb(id, rect);
  }
}

/**
 * Один раз на панель: снимать окно в тот миг, когда его сворачивают, и
 * забывать снимки закрытых окон. Подписка на хранилище срабатывает до
 * отрисовки, поэтому окно в этот момент ещё целое на экране.
 */
export function useThumbKeeper(): void {
  React.useEffect(() => {
    if (!canThumb()) return;
    return useWindowStore.subscribe((state, prev) => {
      if (state.windows === prev.windows) return;
      const now = new Map(state.windows.map((w) => [w.id, w]));
      for (const old of prev.windows) {
        const cur = now.get(old.id);
        if (!cur) { forgetThumb(old.id); continue; }
        if (cur.minimized && !old.minimized) {
          // Снимок делается по прежнему состоянию: окно ещё видно
          const rect = rectOf(old.id);
          if (rect) void captureThumb(old.id, rect);
        }
      }
    });
  }, []);
}
