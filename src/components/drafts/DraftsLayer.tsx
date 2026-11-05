import React from 'react';
import { BAR_H } from '../../lib/metrics';
import { Z } from '../../lib/layers';
import { useStore } from '../../store/store';
import { acquireDraftsSource, useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useWindowStore } from '../../store/windowStore';

export default function DraftsLayer() {
  const userId = useStore((s) => s.user?.id);
  const displayId = useDraftsPanelStore((s) => s.displayId);
  const anchor = useDraftsPanelStore((s) => s.anchor);
  const entries = useDraftsPanelStore((s) => s.entries);
  const loading = useDraftsPanelStore((s) => s.loading);
  const error = useDraftsPanelStore((s) => s.error);
  const unavailable = useDraftsPanelStore((s) => s.unavailable);
  const displays = useWindowStore((s) => s.displays);
  const area = useWindowStore((s) => s.area);
  const panelRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => userId ? acquireDraftsSource(userId) : undefined, [userId]);
  React.useEffect(() => {
    let lastToggle = 0;
    const toggle = () => {
      const now = Date.now();
      if (now - lastToggle < 200) return;
      lastToggle = now;
      const state = useWindowStore.getState();
      const id = state.activeDisplayId ?? state.displays[0]?.id ?? 0;
      const button = document.querySelector<HTMLElement>(`[data-drafts-button="${id}"]`);
      useDraftsPanelStore.getState().toggle(id, button?.getBoundingClientRect());
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useDraftsPanelStore.getState().displayId !== null) { useDraftsPanelStore.getState().close(); return; }
      if (event.ctrlKey && event.altKey && event.code === 'KeyD') { event.preventDefault(); if (!event.repeat) toggle(); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (useDraftsPanelStore.getState().displayId !== null && !panelRef.current?.contains(target) && !(target instanceof Element && target.closest('[data-drafts-button]'))) useDraftsPanelStore.getState().close();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', outside, true);
    const off = (window as any).electron?.ipcRenderer?.on('drafts:toggle', toggle);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', outside, true); if (typeof off === 'function') off(); };
  }, []);
  if (displayId === null) return null;
  const work = displays.find((display) => display.id === displayId)?.workArea ?? { x: 0, y: 0, ...area };
  const width = Math.min(400, Math.max(0, work.w - 8));
  const height = Math.min(540, Math.max(0, work.h - BAR_H - 8));
  const desk = document.querySelector('[data-desk]')?.getBoundingClientRect();
  const wantedLeft = anchor && desk ? anchor.left - desk.left : work.x + 4;
  const left = Math.max(work.x + 4, Math.min(wantedLeft, work.x + work.w - width - 4));
  const top = work.y + work.h - BAR_H - 4 - height;
  return <section ref={panelRef} aria-label="Черновики" data-drafts-panel className="absolute fx-glass flex flex-col overflow-hidden rounded-lg text-slate-800 dark:text-slate-100" style={{ left, top, width, height, zIndex: Z.tray }}>
    <header className="border-b border-slate-200 px-3 py-2 text-sm font-medium dark:border-dark-border">Черновики</header>
    <div className="min-h-0 flex-1 overflow-auto p-2 text-sm">
      {loading && <div role="status">Загрузка…</div>}
      {error && <div role="alert">{error}</div>}
      {unavailable > 0 && <div role="status">Недоступно: {unavailable}</div>}
      {!loading && !error && entries.length === 0 && <div>Черновиков пока нет</div>}
      {entries.map((entry) => <div key={entry.draftId} className="truncate rounded px-2 py-1">{entry.name}</div>)}
    </div>
  </section>;
}
