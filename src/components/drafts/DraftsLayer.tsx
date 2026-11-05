import React from 'react';
import { draftsPanelFrame } from '../../lib/draftsPanelFrame';
import { Z } from '../../lib/layers';
import { useStore } from '../../store/store';
import { acquireDraftsSource, useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useWindowStore } from '../../store/windowStore';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { fileRefHref } from '../../lib/windowsFiles';
import { filterDrafts, groupDrafts, openDraftIds, scopedDrafts, sortDrafts } from '../../lib/draftsPanel';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import DraftsStrip, { STRIP_H } from './DraftsStrip';
import type { DraftItemHandlers } from './DraftTile';

const refOf = (entry: WindowsDraftEntry) => ({ rootId: entry.rootId || entry.parent.rootId, relativePath: entry.relativePath, draftId: entry.draftId });

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
  const settings = useDraftsSettings();
  const projectId = useStore((s) => s.activeProject?.id ?? null);
  // Строка из адресов окон меняется реже самих окон (перетаскивание, фокус):
  // набор «открыт у вас» пересчитывается только при смене адресов.
  const hrefs = useWindowStore((s) => s.windows.map((w) => w.href).join('\n'));
  const openDrafts = React.useMemo(() => openDraftIds(hrefs ? hrefs.split('\n') : []), [hrefs]);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
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
  const now = Date.now();
  const scoped = scopedDrafts(entries, { folders: settings.folders, scope: settings.scope, projectId });
  const visible = sortDrafts(filterDrafts(entries, { kind: settings.kind, state: settings.state, text: query, folders: settings.folders, scope: settings.scope, projectId, openDrafts, now }), settings.sort, settings.dir, settings.pinned);
  const sections = groupDrafts(visible, settings.group, { now, openDrafts });
  const open = (entry: WindowsDraftEntry) => useWindowStore.getState().open(fileRefHref(refOf(entry), { folder: entry.kind === 'directory' }));
  const handlers: DraftItemHandlers = {
    open, select: (entry) => setSelected(entry.draftId || null),
    key: (entry, event) => { if (event.key === 'Enter') { event.preventDefault(); open(entry); } },
    // Меню, перетаскивание и сведения — шаг 5 (docs/roadmap/drafts-panel.md).
    menu: () => undefined, dragStart: () => undefined, hover: () => undefined,
  };
  const strip = settings.view === 'strip';
  const monitor = displays.find((display) => display.id === displayId)?.workArea;
  const desk = document.querySelector('[data-desk]')?.getBoundingClientRect();
  const { left, top, width, height } = draftsPanelFrame({ work: monitor ?? { x: 0, y: 0, ...area }, barInside: !!monitor, fullWidth: strip,
    anchorLeft: anchor && desk ? anchor.left - desk.left : null, width: 400, height: strip ? STRIP_H[settings.rows] : 540 });
  const status = <>
    {loading && entries.length === 0 && <div role="status" className="px-3 py-2 text-xs text-[var(--flux-text-muted)]">Загрузка…</div>}
    {error && <div role="alert" className="px-3 py-2 text-xs">{error}</div>}
    {unavailable > 0 && <div role="status" className="px-3 py-1 text-xs text-[var(--flux-text-muted)]">Недоступно: {unavailable}</div>}
    {!loading && !error && visible.length === 0 && <div className="px-3 py-2 text-xs text-[var(--flux-text-muted)]">{entries.length ? 'Ничего не найдено' : 'Черновиков пока нет'}</div>}
  </>;
  return <section ref={panelRef} aria-label="Черновики" data-drafts-panel data-drafts-view={settings.view}
    className="fx-glass fx-rise-in absolute flex flex-col overflow-hidden rounded-lg border border-[var(--flux-line)] text-[var(--flux-text)]" style={{ left, top, width, height, zIndex: Z.tray }}>
    {strip
      ? <DraftsStrip sections={sections} shown={visible.length} total={scoped.length} query={query} setQuery={setQuery} openDrafts={openDrafts} selected={selected} handlers={handlers} now={now} status={visible.length === 0 || error || loading ? status : undefined} />
      : <>
        {/* Компактная панель — шаг 4; до него здесь простой список и путь назад к полосе. */}
        <header className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--flux-line)] pl-2.5 pr-1.5">
          <h2 className="text-[13px] font-semibold">Черновики</h2>
          <span className="flex-1" />
          <button type="button" className="fx-hov h-6 rounded px-2 text-xs" onClick={() => settings.set({ view: 'strip' })}>Полоса</button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
          {status}
          {visible.map((entry) => <div key={entry.draftId} className="truncate rounded px-2 py-1">{entry.name}</div>)}
        </div>
      </>}
  </section>;
}
