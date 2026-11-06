import React from 'react';
import { createRoot } from 'react-dom/client';
import DraftsButton from '../../src/components/drafts/DraftsButton';
import DraftsLayer from '../../src/components/drafts/DraftsLayer';
import ModalProvider from '../../src/components/ModalProvider';
import ToastProvider from '../../src/components/ToastProvider';
import { useStore } from '../../src/store/store';
import { useWindowStore } from '../../src/store/windowStore';
import { useToastStore } from '../../src/store/toastStore';
import { useDraftsPanelStore } from '../../src/store/draftsPanelStore';
import { useDraftsSettings } from '../../src/store/draftsSettingsStore';
import { useDraftsPublishStore } from '../../src/store/draftsPublishStore';
import { BAR_H } from '../../src/lib/metrics';
import type { WorkspaceDisplay } from '../../workspace/displays';
import type { WindowsDraftEntry, WindowsFilesChanged } from '../../filesystem/contracts';
import '../../src/index.css';

const rect = (x: number) => ({ x, y: 0, w: 640, h: 800 });
const displays: WorkspaceDisplay[] = [1, 2].map((id) => ({ id, label: `Монитор ${id}`, primary: id === 1, scaleFactor: 1, bounds: rect((id - 1) * 640), workArea: rect((id - 1) * 640) }));
const draft = (id: string, projects: string[] = []): WindowsDraftEntry => ({ name: `Черновик ${id}`, relativePath: id, storage: 'flux', draftId: id, kind: 'file', fileId: id, size: 0, modifiedAt: '', linked: false, parent: { rootId: 'root', relativePath: '' }, metadata: { fileId: id, tags: [], projectIds: projects, revision: '', responsible: '', history: [] } });
/** Черновик с именем, давностью и размером — для проверок отбора и порядка */
const make = (id: string, name: string, modifiedAt: string, extra: Partial<WindowsDraftEntry> = {}): WindowsDraftEntry => ({ ...draft(id), name, relativePath: name, size: 1000 * (id.length + 1), modifiedAt, ...extra });
let entries = [draft('1'), draft('2'), draft('3', ['project'])];
let changed: ((change: WindowsFilesChanged) => void) | undefined;

// Мост-имитация: хватает для проверки порядка вызовов панели; настоящий перенос и публикацию проверяют наборы моста.
const calls: Array<Record<string, any>> = [];
/** Файлы Windows, которые уже лежат в папках (ключ — путь папки): повод для «Документ (2)» */
const realFiles: Record<string, string[]> = {};
const published: Array<{ name: string; parent: string }> = [];
const trashed: string[] = [];
let copies = 0;
const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const taken = (parent: string, name: string, except?: string) => (realFiles[parent] || []).some((n) => n.toLowerCase() === name.toLowerCase())
  || entries.some((e) => e.draftId !== except && e.parent.relativePath === parent && e.name.toLowerCase() === name.toLowerCase());
const notify = () => changed?.({ rootId: 'root', relativePath: '', rescan: true });
const invoke = async (request: any) => {
  calls.push(request);
  const ok = (data: unknown) => ({ ok: true, data });
  const fail = (code: string, message: string) => ({ ok: false, error: { code, message } });
  const find = (ref: any) => entries.find((e) => e.draftId === ref?.draftId);
  switch (request.action) {
    case 'draftsList': return ok({ entries, total: entries.length, nextOffset: null, unreadableCount: 0 });
    case 'roots': return ok([{ id: 'root', name: 'Рабочий стол', kind: 'desktop', available: true }]);
    case 'move': {
      const item = find(request.ref);
      if (!item) return fail('NOT_FOUND', 'Черновик не найден');
      if (taken(request.parent.relativePath, request.name, item.draftId)) return fail('EEXIST', 'Файл с таким именем уже есть в папке Windows или среди черновиков Flux.');
      item.parent = { rootId: request.parent.rootId, relativePath: request.parent.relativePath }; item.name = request.name; item.relativePath = join(request.parent.relativePath, request.name);
      notify();
      return ok({ ref: { rootId: item.parent.rootId, relativePath: item.relativePath, draftId: item.draftId } });
    }
    case 'copy': {
      const item = find(request.ref);
      if (!item) return fail('NOT_FOUND', 'Черновик не найден');
      if (taken(request.parent.relativePath, request.name)) return fail('EEXIST', 'Файл с таким именем уже есть в папке Windows или среди черновиков Flux.');
      const id = `${item.draftId}-copy${++copies}`;
      const copy = { ...item, draftId: id, fileId: id, name: request.name, parent: { rootId: request.parent.rootId, relativePath: request.parent.relativePath }, relativePath: join(request.parent.relativePath, request.name),
        metadata: request.carryMeta ? item.metadata : { fileId: id, tags: [], projectIds: [], revision: '', responsible: '', history: [] } };
      entries = [...entries, copy];
      notify();
      return ok({ ref: { rootId: copy.parent.rootId, relativePath: copy.relativePath, draftId: id } });
    }
    case 'publishDraft': case 'publishDraftTree': {
      const item = find(request.ref);
      if (!item) return fail('NOT_FOUND', 'Черновик не найден');
      if ((window as any).__drafts.failPublish) return fail('PUBLISH_FAILED', 'Диск недоступен.');
      entries = entries.filter((e) => e !== item);
      published.push({ name: item.name, parent: item.parent.relativePath });
      notify();
      return ok({ ref: { rootId: item.parent.rootId, relativePath: item.relativePath } });
    }
    case 'rename': {
      const item = find(request.ref);
      if (!item) return fail('NOT_FOUND', 'Черновик не найден');
      if (taken(item.parent.relativePath, request.name, item.draftId)) return fail('EEXIST', 'Имя занято');
      item.name = request.name; item.relativePath = join(item.parent.relativePath, request.name);
      notify();
      return ok({ ref: { ...request.ref, relativePath: item.relativePath } });
    }
    case 'trash': {
      const item = find(request.ref);
      if (!item) return fail('NOT_FOUND', 'Черновик не найден');
      entries = entries.filter((e) => e !== item); trashed.push(item.name);
      notify();
      return ok({ trashed: true });
    }
    case 'createDraft': case 'createDraftFolder': {
      const id = `new${entries.length + 1}`;
      entries = [...entries, { ...draft(id), name: request.name, relativePath: request.name, kind: request.action === 'createDraftFolder' ? 'directory' : 'file', parent: request.parent }];
      notify();
      return ok({ ref: { rootId: request.parent.rootId, relativePath: request.name, draftId: id } });
    }
    default: return fail('UNSUPPORTED', 'Unsupported');
  }
};
(window as any).electron = { windowsFiles: {
  invoke,
  onChanged: (callback: typeof changed) => { changed = callback; return () => { changed = undefined; }; },
}, ipcRenderer: { on: () => () => {} } };
useStore.setState({ user: { id: 'fixture', name: 'Тест', symbol: 'T', role: 'USER' } });
useWindowStore.setState({ displays, area: { w: 1280, h: 800 }, activeDisplayId: 1 });
(window as any).__drafts = {
  store: useDraftsPanelStore, windows: useWindowStore, settings: useDraftsSettings, publish: useDraftsPublishStore, toasts: useToastStore,
  setEntries: (next: WindowsDraftEntry[]) => { entries = next; notify(); },
  entries: () => entries, draft, make, calls, realFiles, published, trashed, failPublish: false,
};
createRoot(document.getElementById('mount')!).render(<div data-desk className="relative h-screen w-screen overflow-hidden">
  {displays.map((display) => <div key={display.id} className="absolute flex items-center" style={{ left: display.workArea.x, top: display.workArea.h - BAR_H, width: display.workArea.w, height: BAR_H }} onPointerDownCapture={() => useWindowStore.getState().setActiveDisplay(display.id)}><DraftsButton displayId={display.id} /></div>)}
  <DraftsLayer />
  <ModalProvider />
  <ToastProvider />
</div>);
