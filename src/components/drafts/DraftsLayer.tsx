import React from 'react';
import { draftsPanelFrame } from '../../lib/draftsPanelFrame';
import { Z } from '../../lib/layers';
import { useStore } from '../../store/store';
import { acquireDraftsSource, useDraftsPanelStore } from '../../store/draftsPanelStore';
import { useWindowStore } from '../../store/windowStore';
import { useDraftsSettings } from '../../store/draftsSettingsStore';
import { folderRefHref, windowsFilesRequest, type WindowsRoot } from '../../lib/windowsFiles';
import { draftState, filterDrafts, groupDrafts, isOld, openDraftIds, scopedDrafts, sortDrafts } from '../../lib/draftsPanel';
import { DRAFT_MIME, dragItem, encodeDraftDrag, isDraftDrag } from '../../lib/draftsActions';
import { dataService } from '../../services/dataService';
import { useToastStore } from '../../store/toastStore';
import ContextMenu from '../ContextMenu';
import { useCreatePanel } from '../files/CreatePanel';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { useDraftProjects } from './useDraftProjects';
import DraftsStrip, { STRIP_H } from './DraftsStrip';
import DraftsCompact, { COMPACT_H, COMPACT_W, type DraftsModel } from './DraftsCompact';
import DraftsSettingsPanel from './DraftsSettingsPanel';
import DraftDetails, { HOVER_DELAY } from './DraftDetails';
import DraftPublishDialog from './DraftPublishDialog';
import { ReminderBanner, ReviewBar } from './DraftsReminder';
import { draftKey, draftMenuItems, isPinned } from './draftMenu';
import { keepDrafts, openDraft, publishInPlace, trashDrafts } from './draftsOps';
import type { DraftItemHandlers } from './DraftTile';

/** Срок «старых» черновиков, когда напоминание выключено, а «Разобрать старые» всё равно нажали. */
const DEFAULT_OLD_DAYS = 14;
const SHEET_W = 380;
const SHEET_H = 560;
const DAY = 86_400_000;

export default function DraftsLayer() {
  const userId = useStore((s) => s.user?.id);
  const displayId = useDraftsPanelStore((s) => s.displayId);
  const anchor = useDraftsPanelStore((s) => s.anchor);
  const entries = useDraftsPanelStore((s) => s.entries);
  const loading = useDraftsPanelStore((s) => s.loading);
  const error = useDraftsPanelStore((s) => s.error);
  const unavailable = useDraftsPanelStore((s) => s.unavailable);
  const review = useDraftsPanelStore((s) => s.review);
  const sheet = useDraftsPanelStore((s) => s.sheet);
  const projectNames = useDraftsPanelStore((s) => s.projectNames);
  const displays = useWindowStore((s) => s.displays);
  const area = useWindowStore((s) => s.area);
  const panelRef = React.useRef<HTMLElement>(null);
  const hintRef = React.useRef<HTMLDivElement>(null);
  const settings = useDraftsSettings();
  const projectId = useStore((s) => s.activeProject?.id ?? null);
  // Строка из адресов окон меняется реже самих окон (перетаскивание, фокус):
  // набор «открыт у вас» пересчитывается только при смене адресов.
  const hrefs = useWindowStore((s) => s.windows.map((w) => w.href).join('\n'));
  const openDrafts = React.useMemo(() => openDraftIds(hrefs ? hrefs.split('\n') : []), [hrefs]);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [createMenu, setCreateMenu] = React.useState<DOMRect | null>(null);
  const [menu, setMenu] = React.useState<{ entry: WindowsDraftEntry; x: number; y: number } | null>(null);
  const [hover, setHover] = React.useState<{ entry: WindowsDraftEntry; rect: DOMRect } | null>(null);
  const [desktop, setDesktop] = React.useState<WindowsRoot | null>(null);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
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
      const store = useDraftsPanelStore.getState();
      // Esc закрывает самое верхнее: меню или окно из панели, затем лист настроек, и только потом сама панель.
      if (event.key === 'Escape' && store.displayId !== null && !document.querySelector('[data-context-menu], [role="dialog"]')) {
        if (store.sheet) store.setSheet(false); else store.close();
        return;
      }
      if (event.ctrlKey && event.altKey && event.code === 'KeyD') { event.preventDefault(); if (!event.repeat) toggle(); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (useDraftsPanelStore.getState().displayId === null || !useDraftsSettings.getState().closeOutside) return;
      // Меню и окна открыты из панели, но лежат в body: щелчок в них — не «вне панели».
      if (panelRef.current?.contains(target) || (target instanceof Element && target.closest('[data-drafts-button], [data-drafts-settings], [data-context-menu], [role="dialog"]'))) return;
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
  // Перетаскивание черновика: подсветка папки под курсором и подсказка «Опубликовать сюда».
  // Слой не знает ни Проводник, ни дерево — только атрибуты их строк (data-entry-kind, data-draft-target).
  React.useEffect(() => {
    let marked: Element | null = null;
    const mark = (el: Element | null) => {
      if (marked === el) return;
      marked?.removeAttribute('data-draft-drop');
      el?.setAttribute('data-draft-drop', 'true');
      marked = el;
    };
    const over = (event: DragEvent) => {
      if (!isDraftDrag(event)) return;
      const el = (event.target as Element | null)?.closest?.('[data-entry-kind="directory"], [data-draft-target]') ?? null;
      // Подсвечиваем, только если строка приняла перетаскивание: иначе обещали бы то, чего не будет.
      mark(el && event.defaultPrevented ? el : null);
      const hint = hintRef.current;
      if (hint) { hint.style.display = marked ? 'block' : 'none'; hint.style.left = `${event.clientX + 14}px`; hint.style.top = `${event.clientY + 14}px`; }
    };
    const end = () => { mark(null); if (hintRef.current) hintRef.current.style.display = 'none'; };
    document.addEventListener('dragover', over);
    document.addEventListener('drop', end, true);
    document.addEventListener('dragend', end, true);
    return () => { document.removeEventListener('dragover', over); document.removeEventListener('drop', end, true); document.removeEventListener('dragend', end, true); end(); };
  }, []);
  React.useEffect(() => () => clearTimeout(hoverTimer.current), []);
  // Плитка исчезла (удалили, опубликовали) под курсором: pointerleave у неё не придёт, и карточка висела бы с чужими сведениями.
  React.useEffect(() => { if (hover && !entries.some((entry) => entry.draftId === hover.entry.draftId)) setHover(null); }, [entries, hover]);
  React.useEffect(() => { if (displayId === null) { setHover(null); setMenu(null); setCreateMenu(null); setQuery(''); } }, [displayId]);

  const projectOf = useDraftProjects(entries);
  const now = Date.now();
  const oldDays = settings.remindDays || DEFAULT_OLD_DAYS;
  const kept = new Set(settings.kept);
  const scoped = scopedDrafts(entries, { folders: settings.folders, scope: settings.scope, projectId }, projectOf);
  // Черновики, которые человек ещё не решил оставить: их число — в «Разобрать старые · N».
  const old = scoped.filter((entry) => isOld(entry, oldDays, now) && !(entry.draftId && kept.has(entry.draftId)));
  const reviewing = review && settings.view === 'compact';
  const visible = sortDrafts(filterDrafts(entries, {
    kind: reviewing ? 'all' : settings.kind, state: reviewing ? null : settings.state, text: query, folders: settings.folders, scope: settings.scope, projectId, openDrafts, now,
    ...(reviewing ? { olderThanDays: oldDays } : {}),
  }, projectOf).filter((entry) => !reviewing || !(entry.draftId && kept.has(entry.draftId))), settings.sort, settings.dir, settings.pinned, projectOf);
  const nameOf = (id: string) => projectNames[id] || 'Проект';
  const sections = groupDrafts(visible, settings.group, { now, openDrafts, projectName: nameOf, pinned: settings.pinned, projectOf });
  const reminderDue = settings.remindDays > 0 && old.length > 0 && now >= settings.snoozeUntil;
  const showHover = (entry: WindowsDraftEntry | null, rect?: DOMRect) => {
    clearTimeout(hoverTimer.current);
    setHover(null);
    if (!entry || !rect || menu) return;
    hoverTimer.current = setTimeout(() => setHover({ entry, rect }), HOVER_DELAY);
  };
  const handlers: DraftItemHandlers = {
    open: openDraft, select: (entry) => setSelected(entry.draftId || null),
    key: (entry, event) => { draftKey(entry, event); },
    menu: (entry, x, y) => { showHover(null); setMenu({ entry, x, y }); },
    dragStart: (entry, event) => {
      event.dataTransfer.setData(DRAFT_MIME, encodeDraftDrag([dragItem(entry)]));
      event.dataTransfer.effectAllowed = 'copyMove';
    },
    // Отпустили не на папку: наружу (стол, Проводник Windows) черновик не вытаскивается — подсказываем путь.
    dragEnd: (_entry, event) => {
      if (event.dataTransfer.dropEffect === 'none') useToastStore.getState().addToast('Черновик остаётся во Flux. Перетащите его на папку в Проводнике или выберите «Опубликовать в проект…» в меню.', 'info');
    },
    hover: showHover,
  };
  const publishDialog = <DraftPublishDialog />;
  const hint = <div ref={hintRef} aria-hidden="true" className="fx-pop pointer-events-none fixed hidden rounded px-2 py-1 text-xs" style={{ zIndex: Z.tray + 2 }}>Опубликовать сюда</div>;
  if (displayId === null) return <>{creator.element}{publishDialog}{hint}</>;
  const strip = settings.view === 'strip';
  const monitor = displays.find((display) => display.id === displayId)?.workArea;
  const desk = document.querySelector('[data-desk]')?.getBoundingClientRect();
  const frame = draftsPanelFrame({ work: monitor ?? { x: 0, y: 0, ...area }, barInside: !!monitor, fullWidth: strip,
    anchorLeft: anchor && desk ? anchor.left - desk.left : null, width: COMPACT_W[settings.columns], height: strip ? STRIP_H[settings.rows] : COMPACT_H });
  // Лист настроек: поверх компактной панели, а над полосой (150 px для него мало) — отдельным листом справа.
  const sheetFrame = strip
    ? (() => { const height = Math.max(200, Math.min(SHEET_H, frame.top - 8)); return { left: frame.left + frame.width - SHEET_W, top: frame.top - 4 - height, width: SHEET_W, height, zIndex: Z.tray }; })()
    : { left: frame.left, top: frame.top, width: frame.width, height: frame.height, zIndex: Z.tray + 1 };
  const status = <>
    {loading && entries.length === 0 && <div role="status" className="px-3 py-2 text-xs text-[var(--flux-text-muted)]">Загрузка…</div>}
    {error && <div role="alert" className="px-3 py-2 text-xs">{error}</div>}
    {unavailable > 0 && <div role="status" className="px-3 py-1 text-xs text-[var(--flux-text-muted)]">Недоступно: {unavailable}</div>}
    {!loading && !error && visible.length === 0 && <div className="px-3 py-2 text-xs text-[var(--flux-text-muted)]">{reviewing ? 'Старых черновиков нет' : entries.length ? 'Ничего не найдено' : 'Черновиков пока нет'}</div>}
  </>;
  const model: DraftsModel = { sections, shown: visible.length, total: reviewing ? old.length : scoped.length, openDrafts, now,
    projectOf, projectNames: (entry) => { const id = projectOf(entry); return id ? [nameOf(id)] : []; } };
  const showStatus = visible.length === 0 || error || loading ? status : undefined;
  const store = useDraftsPanelStore.getState();
  const banner = reviewing
    ? <ReviewBar count={visible.length} days={oldDays}
      onPublish={() => publishInPlace(visible)} onTrash={() => void trashDrafts(visible)} onKeep={() => keepDrafts(visible)} onDone={() => store.setReview(false)} />
    : reminderDue ? <ReminderBanner count={old.length} days={oldDays} onReview={() => store.setReview(true)} onLater={() => settings.set({ snoozeUntil: now + DAY })} /> : undefined;
  const openSettings = () => store.setSheet(!sheet);
  return <>
    <section ref={panelRef} aria-label="Черновики" data-drafts-panel data-drafts-view={settings.view}
      className="fx-glass fx-rise-in absolute flex flex-col overflow-hidden rounded-lg border border-[var(--flux-line)] text-[var(--flux-text)]" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, zIndex: Z.tray }}>
      {strip
        ? <DraftsStrip sections={sections} shown={visible.length} total={scoped.length} query={query} setQuery={setQuery} openDrafts={openDrafts} projectOf={projectOf} selected={selected} handlers={handlers} now={now} status={showStatus}
          onSettings={openSettings} review={reminderDue ? { label: `Разобрать · ${old.length}`, open: () => { settings.set({ view: 'compact' }); store.setReview(true); } } : undefined} />
        : <DraftsCompact model={model} query={query} setQuery={setQuery} selected={selected} handlers={handlers} status={showStatus} banner={banner} onSettings={openSettings}
          bottom={{
            createMenu: setCreateMenu, oldCount: old.length, reviewing,
            toggleReview: () => store.setReview(!review),
            showInExplorer: () => { if (desktop) useWindowStore.getState().open(folderRefHref({ rootId: desktop.id, relativePath: '' })); },
          }} />}
    </section>
    {sheet && <DraftsSettingsPanel style={sheetFrame} onClose={() => store.setSheet(false)} />}
    {hover && !menu && <DraftDetails entry={hover.entry} rect={hover.rect} state={draftState(hover.entry, openDrafts, projectOf)} projects={model.projectNames(hover.entry)} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={draftMenuItems(menu.entry, isPinned(menu.entry))} />}
    {createMenu && <ContextMenu x={createMenu.left} y={createMenu.top} onClose={() => setCreateMenu(null)} items={creator.sections()[0]?.items ?? []} />}
    {creator.element}
    {publishDialog}
    {hint}
  </>;
}
