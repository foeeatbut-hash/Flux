import React from 'react';
import { draftsPanelFrame } from '../../lib/draftsPanelFrame';
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
    // Мост есть не везде (браузер, стенды), а слой стоит в общем столе:
    // его ошибка гасила бы весь стол, поэтому подписка только при наличии.
    let off: unknown;
    const ipc = (window as any).electron?.ipcRenderer;
    try { if (typeof ipc?.on === 'function') off = ipc.on('drafts:toggle', toggle); } catch { off = undefined; }
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', outside, true); if (typeof off === 'function') off(); };
  }, []);
  if (displayId === null) return null;
  const monitor = displays.find((display) => display.id === displayId)?.workArea;
  const desk = document.querySelector('[data-desk]')?.getBoundingClientRect();
  const { left, top, width, height } = draftsPanelFrame({ work: monitor ?? { x: 0, y: 0, ...area }, barInside: !!monitor,
    anchorLeft: anchor && desk ? anchor.left - desk.left : null, width: 400, height: 540 });
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
