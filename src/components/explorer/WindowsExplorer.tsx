import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Grid2X2, List } from 'lucide-react';
import { fileRefHref, windowsFilesRequest, type WindowsFileEntry, type WindowsFileRef, type WindowsShellMenu, type WindowsShellMenuItem, type WindowsOpenWithHandler } from '../../lib/windowsFiles';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { usePlacesStore } from '../../store/placesStore';
import { useWindowStore } from '../../store/windowStore';
import { usePaneId } from '../../lib/paneTitle';
import { useWindowTitleBar } from '../../lib/windowTitleBar';
import { sourceBindings, sharedSourceHref } from '../../services/fileSharingService';
import { dataService } from '../../services/dataService';
import { Btn, Dialog, Field, Input } from '../ui';
import ContextMenu, { type MenuItem as ContextMenuItem } from '../ContextMenu';
import FileShareDialog from './FileShareDialog';
import PropertiesWindow from './PropertiesWindow';
import ExplorerTabs from '../files/ExplorerTabs';
import AddressBar from '../files/AddressBar';
import NavPane from '../files/NavPane';
import PlaceIcon from '../files/PlaceIcon';
import CommandBar from '../files/CommandBar';
import ContentsPane from '../files/ContentsPane';
import SelectionPane from '../files/SelectionPane';
import RecyclePane from '../files/RecyclePane';
import { useExplorerTabs } from '../files/useExplorerTabs';
import { usePlaceCatalog } from '../files/usePlaceCatalog';
import { useExplorerSearch, searchScopes } from '../files/useExplorerSearch';
import { useShellKeys } from '../files/useShellKeys';
import { useFolder, folderKey } from '../files/useFolder';
import { useFolderView } from '../files/useFolderView';
import { useSelection, revealEntry } from '../files/useSelection';
import { useExplorerOperations } from '../files/useExplorerOperations';
import { entryRef } from '../files/fileOps';
import { useCreatePanel } from '../files/CreatePanel';
import { isCreated } from '../files/createEntry';
import { HOME, COMPUTER, NETWORK, childPlace, parentPlace, pathText, placeForRef, placeForRoot, placeKey, type Place } from '../files/places';
import { placeOf } from '../files/tabsModel';
import { isTypingTarget } from '../files/explorerKeys';
import { orderedEntries, VIEW_LABELS, type FolderView } from '../files/viewModel';
import { FONT_STACK, SIZE, X as T } from '../files/explorerTheme';

const bytes = (n: number) => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(0)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1073741824).toFixed(1)} ГБ`;

export default function WindowsExplorer() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const paneId = usePaneId();
  const user = useStore((s) => s.user);
  const [projectNames, setProjectNames] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    let active = true; setProjectNames({});
    if (user?.id) void dataService.getProjects().then((projects) => {
      if (active) setProjectNames(Object.fromEntries(projects.map((project) => [project.id, project.name])));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [user?.id]);
  const toast = useToastStore((s) => s.addToast);
  const { catalog, quick, loaded, error: placesError } = usePlaceCatalog();
  const initial = React.useRef<Place | null>(params.get('root') ? placeForRef({ rootId: params.get('root')!, relativePath: params.get('path') || '', ...(params.get('draft') ? { draftId: params.get('draft')! } : {}) }, catalog) : params.get('computer') === '1' ? COMPUTER : params.get('network') === '1' ? NETWORK : null);
  const tabs = useExplorerTabs({ startAt: initial.current, storageKey: paneId ? `explorer.tabs.v1:${paneId}` : undefined, onLastClosed: () => { if (paneId.startsWith('win:')) useWindowStore.getState().close(paneId.slice(4)); else tabs.go(HOME); } });
  const place = tabs.place;
  const ref = place.ref || null;
  const rootId = ref?.rootId || '';
  const root = [...catalog.roots, ...catalog.volumes.map((v) => v.root)].find((r) => r.id === rootId);
  const folder = useFolder(ref, tabs.ready && loaded && !!ref && !!root?.available);
  const { view, setView } = useFolderView(folderKey(ref) || place.kind);
  const scopes = React.useMemo(() => searchScopes(place, catalog, quick.map((q) => q.ref)), [place, catalog, quick]);
  const search = useExplorerSearch(scopes, placeKey(place));
  const entries = React.useMemo(() => orderedEntries((search.results.active ? search.results.hits : folder.entries).filter((entry) => view.hidden || !entry.hidden).map((entry) => entry.metadata?.projectIds.length ? { ...entry, projectNames: entry.metadata.projectIds.map((id) => projectNames[id] || 'Недоступный проект') } : entry), view), [search.results.active, search.results.hits, folder.entries, view, projectNames]);
  const selection = useSelection(entries, `${placeKey(place)}:${search.results.active}`);
  const single = selection.selected.length === 1 ? selection.selected[0] : null;
  const operations = useExplorerOperations({ folder: ref, rootId, selected: selection.selected, reload: folder.reload });
  const ops = operations;
  const [pane, setPane] = React.useState<'none' | 'details' | 'preview'>('none');
  const [recycle, setRecycle] = React.useState(false);
  const [addressToken, setAddressToken] = React.useState(0);
  const [searchToken, setSearchToken] = React.useState(0);
  const [context, setContext] = React.useState<{ x: number; y: number; entry?: WindowsFileEntry } | null>(null);
  const [properties, setProperties] = React.useState<{ entry: WindowsFileEntry; rootId: string } | null>(null);
  const [share, setShare] = React.useState<WindowsFileEntry | null>(null);
  const [rename, setRename] = React.useState<{ entry: WindowsFileEntry; rootId: string; name: string } | null>(null);
  const [shellMenu, setShellMenu] = React.useState<WindowsShellMenu | null>(null);
  const [archive, setArchive] = React.useState<{ refs: WindowsFileRef[]; parent: WindowsFileRef; name: string } | null>(null);
  const [commandBusy, setCommandBusy] = React.useState(false);
  const [handlers, setHandlers] = React.useState<WindowsOpenWithHandler[] | null>(null);
  const screen = React.useRef<HTMLDivElement>(null);
  const main = React.useRef<HTMLElement>(null);
  const selectAfterLoad = React.useRef<{ scope: string; kind: 'all' | 'end'; extend?: boolean } | null>(null);
  const wanted = React.useRef<string | null>(null);
  const busy = operations.busy || commandBusy;
  const canWrite = !!ref && !!root?.available && !busy;
  const go = (next: Place) => { setRecycle(false); setShare(null); setContext(null); setHandlers(null); tabs.go(next); };
  const back = () => { setRecycle(false); tabs.back(); };
  const forward = () => { setRecycle(false); tabs.forward(); };
  const refresh = () => { void folder.reload(); void usePlacesStore.getState().load(true); };
  React.useEffect(() => {
    const element = main.current;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const layouts = Object.keys(VIEW_LABELS) as FolderView['layout'][];
      setView({ ...view, layout: layouts[Math.max(0, Math.min(7, layouts.indexOf(view.layout) + (event.deltaY > 0 ? 1 : -1)))] });
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, [view, setView]);
  const up = () => { const parent = parentPlace(place); if (parent) go(parent); };
  const panel = useCreatePanel({ parent: canWrite ? ref : null, windows: !ref?.draftId, where: 'в Windows', inline: true, onCreated: async (outcome) => { if (isCreated(outcome)) wanted.current = outcome.name; await folder.reload(); } });
  const askRename = () => { if (single) setRename({ entry: single, rootId, name: single.name }); };
  const renameBusy = React.useRef(false);
  const commitRename = async () => {
    if (!rename || renameBusy.current || !rename.name.trim()) return;
    renameBusy.current = true;
    const answer = await command({ action: 'rename', ref: entryRef(rename.entry, rename.rootId), name: rename.name.trim() });
    renameBusy.current = false;
    if (answer.ok) { wanted.current = rename.name.trim(); setRename(null); await folder.reload(); }
  };
  const showProperties = (entry: WindowsFileEntry) => setProperties({ entry, rootId: entry.rootId || rootId });
  const openEntry = (entry: WindowsFileEntry) => {
    if (entry.kind === 'directory') go(search.results.active ? placeForRef(entryRef(entry, rootId), catalog) : childPlace(place, entry));
    else if (entry.kind === 'file') {
      const file = entryRef(entry, rootId);
      if (user?.id && !root?.network) void sharedSourceHref(user.id, file, entry.name).then((href) => navigate(href || fileRefHref(file))).catch((e) => toast(e.message, 'error'));
      else navigate(fileRefHref(file));
    } else void command({ action: 'open', ref: entryRef(entry, rootId) });
  };
  async function command(request: Parameters<typeof windowsFilesRequest>[0]) {
    setCommandBusy(true);
    try {
      const answer = await windowsFilesRequest(request);
      if ('error' in answer) toast(answer.error.message, 'error');
      return answer;
    } finally { setCommandBusy(false); }
  }
  React.useEffect(() => { if (!wanted.current) return; const entry = entries.find((e) => e.name === wanted.current); if (entry) { selection.only(entry); wanted.current = null; } }, [entries]);
  React.useEffect(() => { void operations.refreshUndo(); }, [folder.entries]);
  React.useEffect(() => {
    if (!loaded || !place.ref || place.trail[0]?.name !== 'Папка') return;
    tabs.go(placeForRef(place.ref, catalog));
  }, [loaded, catalog]);
  React.useEffect(() => { revealEntry(folder.scrollRef.current, selection.focused?.fileId || null); }, [selection.focused?.fileId]);
  // Ссылка и активная вкладка описывают одно место. Собственный переход не создаёт вторую запись истории.
  const ownUrl = React.useRef('');
  React.useEffect(() => {
    if (!tabs.ready) return;
    const next = new URLSearchParams();
    if (ref) { next.set('root', ref.rootId); next.set('path', ref.relativePath); if (ref.draftId) next.set('draft', ref.draftId); }
    else if (place.kind === 'computer') next.set('computer', '1'); else if (place.kind === 'network') next.set('network', '1');
    if (params.get('properties') === '1') return;
    ownUrl.current = next.toString();
    if (params.toString() !== ownUrl.current) setParams(next, { replace: true });
  }, [place, tabs.ready]);
  React.useEffect(() => {
    if (!tabs.ready || params.toString() === ownUrl.current || params.get('properties') === '1') return;
    const id = params.get('root');
    const next = id ? placeForRef({ rootId: id, relativePath: params.get('path') || '', ...(params.get('draft') ? { draftId: params.get('draft')! } : {}) }, catalog) : params.get('computer') ? COMPUTER : params.get('network') ? NETWORK : HOME;
    if (placeKey(next) !== placeKey(place)) go(next);
  }, [params.toString()]);
  const propertiesRequest = React.useRef(0);
  React.useEffect(() => () => { propertiesRequest.current++; }, []);
  React.useEffect(() => {
    if (params.get('properties') !== '1' || !ref) return;
    const requestId = ++propertiesRequest.current;
    const target = { rootId: ref.rootId, relativePath: params.get('target') || ref.relativePath, ...(params.get('targetDraft') ? { draftId: params.get('targetDraft')! } : {}) };
    void windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref: target }).then((answer) => { if (requestId === propertiesRequest.current && answer.ok) setProperties({ entry: answer.data, rootId: target.rootId }); else if (requestId === propertiesRequest.current && 'error' in answer) toast(answer.error.message, 'error'); });
    const next = new URLSearchParams(params); next.delete('properties'); next.delete('target'); next.delete('targetDraft'); setParams(next, { replace: true });
  }, [tabs.ready, params.toString()]);
  React.useEffect(() => () => { if (shellMenu) void windowsFilesRequest({ action: 'shellMenuClose', token: shellMenu.token }); }, [shellMenu]);
  const shellKeys = useShellKeys({ newTab: () => tabs.open(HOME), closeTab: tabs.close, nextTab: () => tabs.step(1), prevTab: () => tabs.step(-1), goBack: back, goForward: forward, goUp: up, address: () => setAddressToken((n) => n + 1), search: () => setSearchToken((n) => n + 1), refresh });
  React.useEffect(() => {
    const pending = selectAfterLoad.current;
    if (!pending || folder.nextOffset !== null || folder.loading) return;
    selectAfterLoad.current = null;
    if (pending.scope !== folderKey(ref)) return;
    if (pending.kind === 'all') selection.all(); else selection.move(entries.length, pending.extend);
  }, [folder.entries, folder.loading]);
  React.useEffect(() => { if (!search.results.active && !folder.loading && folder.nextOffset !== null && (view.sort !== 'name' || view.descending || view.group !== 'none')) void folder.loadAll(); }, [view.sort, view.descending, view.group, folder.entries]);
  const selectAll = () => { if (!search.results.active && folder.nextOffset !== null) { selectAfterLoad.current = { scope: folderKey(ref), kind: 'all' }; void folder.loadAll(); } else selection.all(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    // Кнопки портального меню получают Enter сами, без открытия выбранного файла позади.
    if (event.defaultPrevented || properties || share || archive || (event.target as HTMLElement).closest('[data-context-menu]')) return;
    shellKeys(event); if (event.defaultPrevented || isTypingTarget(event.target)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    // Сочетания используют физическую клавишу и при русской раскладке Windows.
    const key = (ctrl || event.altKey) && /^Key[A-Z]$/u.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (ctrl && event.shiftKey && /^Digit[1-8]$/u.test(event.code)) { event.preventDefault(); setView({ ...view, layout: Object.keys(VIEW_LABELS)[Number(event.code.slice(-1)) - 1] as FolderView['layout'] }); return; }
    if (ctrl && !event.shiftKey && key === 'n') { event.preventDefault(); useWindowStore.getState().openAnother(`/explorer?${params.toString()}`); return; }
    if (ctrl && event.shiftKey && key === 'c') { event.preventDefault(); if (selection.selected.length) void command({ action: 'copyPath', refs: selection.selected.map((entry) => entryRef(entry, rootId)) }); return; }
    const actions: Record<string, () => void> = {
      'c': () => void ops.copy(selection.selected), 'x': () => void ops.cut(selection.selected), 'v': () => void ops.paste(), 'a': selectAll,
      'z': operations.undoLast, 'y': operations.redoLast,
    };
    if (ctrl && !event.altKey && !event.shiftKey && actions[key]) { event.preventDefault(); if (!busy) actions[key](); return; }
    if (event.altKey && key === 'p') { event.preventDefault(); const target = event.shiftKey ? 'details' : 'preview'; setPane(pane === target ? 'none' : target); return; }
    if (ctrl && event.shiftKey && key === 'n') { event.preventDefault(); const rect = main.current?.getBoundingClientRect(); panel.openByKey((rect?.left || 0) + 24, (rect?.top || 0) + 24); return; }
    if (key === 'enter' && event.altKey) { event.preventDefault(); if (single) showProperties(single); }
    else if (key === 'enter') { event.preventDefault(); if (single) openEntry(single); }
    else if (key === 'f2') { event.preventDefault(); askRename(); }
    else if (key === 'delete') { event.preventDefault(); if (!busy) void ops.trash(selection.selected, event.shiftKey); }
    else if (key === 'backspace') { event.preventDefault(); back(); }
    else if (key === ' ') { event.preventDefault(); if (selection.focused) selection.click(selection.focused, { ctrl: true }); }
    else if (key === 'escape') { selection.clear(); search.clear(); }
    else if (key === 'home' || key === 'end') { event.preventDefault(); if (key === 'end' && !search.results.active && folder.nextOffset !== null) { selectAfterLoad.current = { scope: folderKey(ref), kind: 'end', extend: event.shiftKey }; void folder.loadAll(); } else selection.move(key === 'home' ? -entries.length : entries.length, event.shiftKey); }
    else if (key.startsWith('arrow')) {
      event.preventDefault();
      const grid = folder.scrollRef.current?.querySelector('[data-entries-grid]');
      const cols = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length) : 1;
      const columnMajor = grid?.getAttribute('data-entry-flow') === 'column-major';
      const stride = columnMajor ? Number(grid?.getAttribute('data-flow-row-count')) || 1 : 1;
      selection.move(key === 'arrowdown' ? columnMajor ? 1 : cols : key === 'arrowup' ? columnMajor ? -1 : -cols : key === 'arrowright' ? stride : -stride, event.shiftKey);
    }
  };
  const beginDrag = (event: React.DragEvent, entry: WindowsFileEntry) => {
    const picked = selection.isSelected(entry) ? selection.selected : [entry];
    event.dataTransfer.setData('application/x-flux-entries', JSON.stringify(picked.map((e) => ({ ref: entryRef(e, rootId), name: e.name, kind: e.kind }))));
    event.dataTransfer.effectAllowed = 'copyMove';
    if (event.altKey && picked.every((e) => !e.draftId)) { event.preventDefault(); void command({ action: 'startDrag', refs: picked.map((e) => entryRef(e, rootId)) }); }
  };
  const title = useWindowTitleBar(<div style={{ height: SIZE.titleBar }} className={`flex shrink-0 min-w-0 w-full items-start ${T.strip}`}><ExplorerTabs tabs={tabs.tabs} activeId={tabs.activeId} onPick={(id) => { setRecycle(false); tabs.pick(id); }} onClose={tabs.close} onNew={() => tabs.open(HOME)} onMove={tabs.move} onDropOnTab={(tab, event) => { const parent = placeOf(tab).ref; if (parent) operations.drop(event, parent); }} /></div>, { height: SIZE.titleBar, className: T.strip });
  const menuEntries = context?.entry && selection.isSelected(context.entry) ? selection.selected : context?.entry ? [context.entry] : [];
  const targetEntry = context?.entry;
  const nativeMenu = (items: WindowsShellMenuItem[]): ContextMenuItem[] => items.map((item) => ({ label: item.label.replace(/&/gu, ''), disabled: !item.enabled, separated: item.separator, ...(item.submenu ? { items: nativeMenu(item.submenu) } : { onClick: () => { if (shellMenu) void command({ action: 'shellMenuInvoke', token: shellMenu.token, commandId: item.id, label: item.label }); } }) })).filter((i) => !!i.label);
  const showShellMenu = async (event: React.MouseEvent) => {
    const refs = menuEntries.map((entry) => entryRef(entry, rootId));
    if (!refs.length && ref) refs.push(ref);
    const answer = await windowsFilesRequest<WindowsShellMenu>({ action: 'shellMenu', refs, extended: true });
    if (answer.ok) { setShellMenu(answer.data); setContext({ x: event.clientX, y: event.clientY }); } else if ('error' in answer) toast(answer.error.message, 'error');
  };
  const contextItems: ContextMenuItem[] = shellMenu ? nativeMenu(shellMenu.items) : targetEntry ? [
    { label: 'Открыть', disabled: menuEntries.length !== 1, onClick: () => openEntry(targetEntry) },
    { label: 'Открыть с помощью…', disabled: menuEntries.length !== 1 || !!targetEntry.draftId || targetEntry.kind !== 'file', onClick: () => { void windowsFilesRequest<WindowsOpenWithHandler[]>({ action: 'openWithList', ref: entryRef(targetEntry, rootId) }).then((answer) => { if (answer.ok) setHandlers(answer.data); else if ('error' in answer) toast(answer.error.message, 'error'); }); } },
    { label: 'Копировать', separated: true, onClick: () => void ops.copy(menuEntries) }, { label: 'Вырезать', onClick: () => void ops.cut(menuEntries) },
    { label: 'Переименовать', disabled: menuEntries.length !== 1, onClick: () => setRename({ entry: targetEntry, rootId, name: targetEntry.name }) },
    { label: 'Копировать как путь', onClick: () => { void command({ action: 'copyPath', refs: menuEntries.map((e) => entryRef(e, rootId)) }); } },
    ...(targetEntry.kind === 'directory' ? [{ label: 'Открыть в новой вкладке', onClick: () => tabs.open(childPlace(place, targetEntry)) }, { label: 'Закрепить в быстром доступе', disabled: !!targetEntry.draftId, onClick: () => { void usePlacesStore.getState().pin(entryRef(targetEntry, rootId), true).then((result) => { if (!result.ok) toast(result.message || 'Не удалось закрепить папку', 'error'); }); } }] : []),
    ...(targetEntry.storage === 'flux' ? [{ label: 'Опубликовать в Windows', onClick: () => operations.publish(targetEntry) }] : []),
    { label: 'Сжать в ZIP-файл', disabled: !ref || !!ref.draftId || menuEntries.some((e) => !!e.draftId), onClick: () => { if (ref) setArchive({ refs: menuEntries.map((e) => entryRef(e, rootId)), parent: { ...ref }, name: targetEntry.name.replace(/\.[^.]+$/u, '') + '.zip' }); } },
    { label: 'Удалить', danger: true, separated: true, onClick: () => void ops.trash(menuEntries) },
    { label: 'Свойства', disabled: menuEntries.length !== 1, onClick: () => showProperties(targetEntry) },
    { label: 'Показать дополнительные параметры', separated: true, disabled: menuEntries.some((e) => !!e.draftId), onClick: () => { const fake = { clientX: context!.x, clientY: context!.y } as React.MouseEvent; void showShellMenu(fake); } },
  ] : [
    { label: 'Просмотреть', items: Object.entries(VIEW_LABELS).map(([layout, label]) => ({ label, onClick: () => setView({ ...view, layout: layout as FolderView['layout'] }) })) },
    { label: 'Обновить', onClick: refresh }, panel.menuItem(),
    { label: 'Копировать свойства Flux', checked: operations.carryMeta, onClick: () => operations.setCarryMeta(!operations.carryMeta) },
    { label: 'Вставить', disabled: !ops.clip || !canWrite, onClick: () => void ops.paste() },
    { label: 'Открыть Корзину', separated: true, onClick: () => setRecycle(true) },
  ];
  const computer = place.kind === 'computer';
  const locations = computer ? catalog.volumes.filter((v) => v.kind !== 'network') : place.kind === 'network' ? catalog.volumes.filter((v) => v.kind === 'network') : [];
  const sharedSources = user?.id ? sourceBindings(user.id).filter((s) => s.audience !== 'NONE') : [];
  return <div ref={screen} tabIndex={0} onKeyDown={onKeyDown} data-windows-explorer className={`@container flex h-full min-h-0 min-w-0 flex-col outline-none [color-scheme:light] dark:[color-scheme:dark] ${T.pane} ${T.text}`} style={{ fontFamily: FONT_STACK }}>
    {title}
    <AddressBar place={place} catalog={catalog} canBack={tabs.canBack} canForward={tabs.canForward} recent={tabs.recent} search={search} onBack={back} onForward={forward} onUp={up} onRefresh={refresh} onOpen={go} onJump={tabs.jump} focusAddressToken={addressToken} focusSearchToken={searchToken} />
    <CommandBar view={view} onView={setView} selected={selection.selected.length} busy={busy} canPaste={!!ops.clip && canWrite} onCut={() => void ops.cut(selection.selected)} onCopy={() => void ops.copy(selection.selected)} onPaste={() => void ops.paste()} onRename={askRename} onDelete={() => void ops.trash(selection.selected)} onShare={single && user?.id && !root?.network ? () => setShare(single) : undefined} onUndo={operations.undoLast} onRedo={operations.redoLast} undo={operations.undo.undo?.label} redo={operations.undo.redo?.label} pane={pane} onPane={setPane} onProperties={() => { if (single) showProperties(single); }} />
    <div className="flex min-h-0 flex-1">
      <NavPane place={place} onOpen={go} onOpenInNewTab={(next) => tabs.open(next, false)} />
      <main ref={main} className="flex min-w-0 flex-1 flex-col" onDragOver={(e) => { if (canWrite) { e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } }} onDrop={(e) => { if (ref) operations.drop(e); }} onContextMenu={(e) => { if (ref) { e.preventDefault(); setShellMenu(null); setContext({ x: e.clientX, y: e.clientY }); } }}>
        {(folder.error || search.results.error || placesError) && <p role="alert" className="px-4 py-2 text-xs text-rose-600 dark:text-rose-400">{folder.error || search.results.error || placesError}</p>}
        {!!folder.listing?.unreadableCount && <p role="status" className="px-4 py-2 text-xs text-amber-700 dark:text-amber-300">Недоступных объектов пропущено: {folder.listing.unreadableCount}</p>}
        {panel.nameElement}
        {recycle ? <RecyclePane onChanged={refresh} /> : search.results.active || ref ? <>
          {search.results.active && <p role="status" className={`px-4 py-2 text-xs ${T.muted}`}>{search.results.status === 'running' ? 'Поиск…' : 'Результаты поиска'} · найдено: {entries.length}{search.results.reason && search.results.reason !== 'complete' ? ` · ${search.results.reason === 'canceled' ? 'остановлен' : 'достигнуто ограничение поиска'}` : ''}</p>}
          {!root?.available && ref ? <p className={`p-4 text-xs ${T.muted}`}>Папка недоступна. Проверьте подключение и обновите список.</p> : !entries.length ? <p className={`p-4 text-xs ${T.muted}`}>{folder.loading || !tabs.ready ? 'Открываю папку…' : folder.error ? 'Список папки недоступен.' : search.results.active ? 'Файлы не найдены.' : folder.listing?.unreadableCount ? 'Нет доступных для показа объектов.' : 'Эта папка пуста.'}</p> : <ContentsPane entries={entries} rootId={rootId} selection={selection} view={view} onViewChange={setView} editing={rename ? { fileId: rename.entry.fileId, value: rename.name, onChange: (name) => setRename({ ...rename, name }), onCommit: () => void commitRename(), onCancel: () => setRename(null) } : undefined} onOpen={openEntry} onContext={(e, entry) => { e.preventDefault(); e.stopPropagation(); selection.context(entry); setShellMenu(null); setContext({ x: e.clientX, y: e.clientY, entry }); }} onDragStart={beginDrag} onDrop={(event, entry) => operations.drop(event, entryRef(entry, rootId))} scrollRef={folder.scrollRef} loadMore={() => void folder.loadMore()} hasMore={!search.results.active && folder.nextOffset !== null} busy={folder.loading} />}
        </> : place.kind === 'home' ? <div className="flex-1 overflow-auto p-5 text-xs"><h2 className="mb-4 text-sm">Быстрый доступ</h2><div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">{(quick.length ? quick : catalog.roots.map((r) => ({ name: r.name, ref: { rootId: r.id, relativePath: '' }, pinned: false }))).map((item) => <button key={`${item.ref.rootId}:${item.ref.relativePath}`} type="button" onDoubleClick={() => go(placeForRef(item.ref, catalog))} onClick={() => go(placeForRef(item.ref, catalog))} className={`flex items-center gap-2 rounded p-3 text-left ${T.paneHover}`}>{item.name}</button>)}</div>{sharedSources.length > 0 && <button className="mt-6" onClick={() => navigate('/explorer?view=shared')}>Общий доступ · {sharedSources.length}</button>}<div className="mt-6 flex gap-4"><button onClick={() => setRecycle(true)}>Корзина</button><button onClick={() => navigate('/explorer?projectFiles=1')}>Документы проекта</button></div></div> : <div className="flex-1 overflow-auto px-3 py-2"><h2 className="mb-3 text-sm">{computer ? 'Устройства и диски' : 'Сетевые расположения'}</h2><div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">{locations.map((v) => <button key={v.id} type="button" disabled={!v.root.available} onDoubleClick={() => go(placeForRoot(v.root.id, catalog))} onClick={() => go(placeForRoot(v.root.id, catalog))} className={`flex min-w-0 items-center gap-3 rounded p-2 text-left text-xs ${T.paneHover} disabled:opacity-40`}><PlaceIcon kind="folder" name={v.name} fileRef={{ rootId: v.root.id, relativePath: '' }} size={40} /><span className="min-w-0 flex-1"><span className="block truncate">{v.name}</span>{v.size != null && v.free != null && <><span className="my-1 block h-3 border border-[#a0a0a0] bg-[#e5e5e5] dark:bg-[#e5e5e5]"><span className={`block h-full ${v.free / v.size < .1 ? 'bg-[#c42b1c] dark:bg-[#ff4343]' : 'bg-[#0078d4] dark:bg-[#0078d4]'}`} style={{ width: `${Math.min(100, Math.max(0, (v.size - v.free) / v.size * 100))}%` }} /></span><span className={`block ${T.muted}`}>{bytes(v.free)} свободно из {bytes(v.size)}</span></>}</span></button>)}</div>{place.kind === 'network' && catalog.roots.filter((r) => r.network).map((r) => <button key={r.id} onClick={() => go(placeForRoot(r.id, catalog))} className={`m-2 rounded p-3 text-xs ${T.paneHover}`}>{r.name}</button>)}</div>}
      </main>
      {pane !== 'none' && !recycle && <SelectionPane entries={selection.selected} rootId={single?.rootId || rootId} mode={pane} onProperties={showProperties} />}
    </div>
    <footer data-explorer-status className={`flex h-6 shrink-0 items-center gap-3 px-3 text-xs bg-[#f3f3f3] dark:bg-[#1c1c1c] ${T.text}`}><span>Элементов: {ref || search.results.active ? entries.length : locations.length}{folder.nextOffset !== null && ref ? '+' : ''}</span>{selection.selected.length > 0 && <span>Выбрано: {selection.selected.length} · {bytes(selection.selected.reduce((n, e) => n + (e.kind === 'file' ? e.size : 0), 0))}</span>}{operations.progress && <span role="status">{operations.progress.label} {operations.progress.done}/{operations.progress.total}</span>}<span className="flex-1" /><button type="button" title="Таблица" aria-label="Таблица" onClick={() => setView({ ...view, layout: 'details' })}><List size={16} /></button><button type="button" title="Крупные значки" aria-label="Крупные значки" onClick={() => setView({ ...view, layout: 'large' })}><Grid2X2 size={16} /></button></footer>
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems} onClose={() => { setContext(null); setShellMenu(null); }} />}
    {properties && <PropertiesWindow key={`${properties.rootId}:${properties.entry.fileId}`} {...properties} onClose={() => setProperties(null)} />}
    {share && user?.id && <FileShareDialog actorId={user.id} source={entryRef(share, rootId)} name={share.name} onClose={() => setShare(null)} />}

    {handlers && single && <Dialog title="Открыть с помощью" onClose={() => setHandlers(null)}>{handlers.length ? handlers.map((handler) => <button className={`block w-full rounded p-3 text-left text-xs ${T.paneHover}`} key={handler.id} onClick={() => { void command({ action: 'openWith', ref: entryRef(single, rootId), handlerId: handler.id }); setHandlers(null); }}>{handler.name}</button>) : <p className="text-xs">Windows не сообщила подходящие приложения.</p>}</Dialog>}
    {archive && <Dialog title="Сжать в ZIP-файл" onClose={() => { if (!busy) setArchive(null); }} footer={<><Btn disabled={busy} onClick={() => setArchive(null)}>Отмена</Btn><Btn tone="primary" disabled={busy || !archive.name.trim()} onClick={() => { void command({ action: 'archive', ...archive, name: archive.name.trim(), group: `archive-${Date.now()}` }).then((answer) => { if (answer.ok) { wanted.current = archive.name.trim(); setArchive(null); void folder.reload(); } }); }}>Сжать</Btn></>}><Field label="Имя архива"><Input autoFocus value={archive.name} onChange={(e) => setArchive({ ...archive, name: e.target.value })} /></Field></Dialog>}
    {panel.element}{operations.element}
  </div>;
}
