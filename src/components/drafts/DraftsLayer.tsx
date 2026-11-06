import React from 'react';
import { draftsPanelFrame } from '../../lib/draftsPanelFrame';
import { Z } from '../../lib/layers';
import { useStore } from '../../store/store';
import { acquireDraftsSource, useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useWindowStore } from '../../store/windowStore';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { fileRefHref, folderRefHref, windowsFilesRequest, type WindowsRoot } from '../../lib/windowsFiles';
import { filterDrafts, groupDrafts, isOld, openDraftIds, scopedDrafts, sortDrafts } from '../../lib/draftsPanel';
import { draftRef } from '../../lib/draftsActions';
import { dataService } from '../../services/dataService';
import ContextMenu from '../ContextMenu';
import { useCreatePanel } from '../files/CreatePanel';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import DraftsStrip, { STRIP_H } from './DraftsStrip';
import DraftsCompact, { COMPACT_H, COMPACT_W, type DraftsModel } from './DraftsCompact';
import type { DraftItemHandlers } from './DraftTile';

/** Срок «старых» черновиков, когда напоминание выключено, а «Разобрать старые» всё равно нажали. */
const DEFAULT_OLD_DAYS = 14;

export default function DraftsLayer() {
  const userId = useStore((s) => s.user?.id);
  const displayId = useDraftsPanelStore((s) => s.displayId);
  const anchor = useDraftsPanelStore((s) => s.anchor);
  const entries = useDraftsPanelStore((s) => s.entries);
  const loading = useDraftsPanelStore((s) => s.loading);
  const error = useDraftsPanelStore((s) => s.error);
  const unavailable = useDraftsPanelStore((s) => s.unavailable);
  const review = useDraftsPanelStore((s) => s.review);
  const projectNames = useDraftsPanelStore((s) => s.projectNames);
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
  const [createMenu, setCreateMenu] = React.useState<DOMRect | null>(null);
  const [desktop, setDesktop] = React.useState<WindowsRoot | null>(null);
  React.useEffect(() => userId ? acquireDraftsSource(userId) : undefined, [userId]);
  // Названия проектов нужны подсказке строки и группам; без связи панель остаётся рабочей.
  React.useEffect(() => {
    if (!userId) return;
    let active = true;
    void Promise.resolve().then(() => dataService.getProjects()).then((projects) => {
      if (active) useDraftsPanelStore.setState({ projectNames: Object.fromEntries(projects.map((project) => [project.id, project.name])) });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [userId]);
  // Рабочий стол Windows — родитель новых объектов Flux: куда ещё «Создать», когда папка не выбрана.
  React.useEffect(() => {
    if (displayId === null || desktop) return;
    let active = true;
    void windowsFilesRequest<WindowsRoot[]>({ action: 'roots' }).then((answer) => {
      if (active && 'data' in answer) setDesktop(answer.data.find((root) => root.kind === 'desktop') ?? null);
    });
    return () => { active = false; };
  }, [displayId, desktop]);
  const creator = useCreatePanel({
    parent: desktop ? { rootId: desktop.id, relativePath: '' } : null, windows: false,
    onCreated: () => useDraftsPanelStore.getState().reload(),
  });
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
      // Esc закрывает самое верхнее: меню или окно из панели, а не всю панель вместе с ними.
      if (event.key === 'Escape' && useDraftsPanelStore.getState().displayId !== null && !document.querySelector('[data-context-menu], [role="dialog"]')) { useDraftsPanelStore.getState().close(); return; }
      if (event.ctrlKey && event.altKey && event.code === 'KeyD') { event.preventDefault(); if (!event.repeat) toggle(); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (useDraftsPanelStore.getState().displayId === null || !useDraftsSettings.getState().closeOutside) return;
      // Меню и окна открыты из панели, но лежат в body: щелчок в них — не «вне панели».
      if (panelRef.current?.contains(target) || (target instanceof Element && target.closest('[data-drafts-button], [data-context-menu], [role="dialog"]'))) return;
      useDraftsPanelStore.getState().close();
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
  const now = Date.now();
  const oldDays = settings.remindDays || DEFAULT_OLD_DAYS;
  const kept = new Set(settings.kept);
  // Черновики, которые человек ещё не решил оставить: их число — в «Разобрать старые · N».
  const old = scopedDrafts(entries, { folders: settings.folders, scope: settings.scope, projectId })
    .filter((entry) => isOld(entry, oldDays, now) && !(entry.draftId && kept.has(entry.draftId)));
  const scoped = scopedDrafts(entries, { folders: settings.folders, scope: settings.scope, projectId });
  const reviewing = review && settings.view === 'compact';
  const visible = sortDrafts(filterDrafts(entries, {
    kind: reviewing ? 'all' : settings.kind, state: reviewing ? null : settings.state, text: query, folders: settings.folders, scope: settings.scope, projectId, openDrafts, now,
    ...(reviewing ? { olderThanDays: oldDays } : {}),
  }).filter((entry) => !reviewing || !(entry.draftId && kept.has(entry.draftId))), settings.sort, settings.dir, settings.pinned);
  const nameOf = (id: string) => projectNames[id] || 'Проект';
  const sections = groupDrafts(visible, settings.group, { now, openDrafts, projectName: nameOf });
  const open = (entry: WindowsDraftEntry) => useWindowStore.getState().open(fileRefHref(draftRef(entry), { folder: entry.kind === 'directory' }));
  const handlers: DraftItemHandlers = {
    open, select: (entry) => setSelected(entry.draftId || null),
    key: (entry, event) => { if (event.key === 'Enter') { event.preventDefault(); open(entry); } },
    // Меню, перетаскивание и сведения — шаг 5 (docs/roadmap/drafts-panel.md).
    menu: () => undefined, dragStart: () => undefined, hover: () => undefined,
  };
  if (displayId === null) return <>{creator.element}</>;
  const strip = settings.view === 'strip';
  const monitor = displays.find((display) => display.id === displayId)?.workArea;
  const desk = document.querySelector('[data-desk]')?.getBoundingClientRect();
  const { left, top, width, height } = draftsPanelFrame({ work: monitor ?? { x: 0, y: 0, ...area }, barInside: !!monitor, fullWidth: strip,
    anchorLeft: anchor && desk ? anchor.left - desk.left : null, width: COMPACT_W[settings.columns], height: strip ? STRIP_H[settings.rows] : COMPACT_H });
  const status = <>
    {loading && entries.length === 0 && <div role="status" className="px-3 py-2 text-xs text-[var(--flux-text-muted)]">Загрузка…</div>}
    {error && <div role="alert" className="px-3 py-2 text-xs">{error}</div>}
    {unavailable > 0 && <div role="status" className="px-3 py-1 text-xs text-[var(--flux-text-muted)]">Недоступно: {unavailable}</div>}
    {!loading && !error && visible.length === 0 && <div className="px-3 py-2 text-xs text-[var(--flux-text-muted)]">{reviewing ? 'Старых черновиков нет' : entries.length ? 'Ничего не найдено' : 'Черновиков пока нет'}</div>}
  </>;
  const model: DraftsModel = { sections, shown: visible.length, total: reviewing ? old.length : scoped.length, openDrafts, now,
    projectNames: (entry) => (entry.metadata?.projectIds || []).map(nameOf) };
  const showStatus = visible.length === 0 || error || loading ? status : undefined;
  return <>
    <section ref={panelRef} aria-label="Черновики" data-drafts-panel data-drafts-view={settings.view}
      className="fx-glass fx-rise-in absolute flex flex-col overflow-hidden rounded-lg border border-[var(--flux-line)] text-[var(--flux-text)]" style={{ left, top, width, height, zIndex: Z.tray }}>
      {strip
        ? <DraftsStrip sections={sections} shown={visible.length} total={scoped.length} query={query} setQuery={setQuery} openDrafts={openDrafts} selected={selected} handlers={handlers} now={now} status={showStatus} />
        : <DraftsCompact model={model} query={query} setQuery={setQuery} selected={selected} handlers={handlers} status={showStatus}
          bottom={{
            createMenu: setCreateMenu, oldCount: old.length, reviewing,
            toggleReview: () => useDraftsPanelStore.getState().setReview(!review),
            showInExplorer: () => { if (desktop) useWindowStore.getState().open(folderRefHref({ rootId: desktop.id, relativePath: '' })); },
          }} />}
    </section>
    {createMenu && <ContextMenu x={createMenu.left} y={createMenu.top} onClose={() => setCreateMenu(null)} items={creator.sections()[0]?.items ?? []} />}
    {creator.element}
  </>;
}
