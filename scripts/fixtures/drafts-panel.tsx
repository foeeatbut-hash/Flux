import React from 'react';
import { createRoot } from 'react-dom/client';
import DraftsButton from '../../src/components/drafts/DraftsButton';
import DraftsLayer from '../../src/components/drafts/DraftsLayer';
import { useStore } from '../../src/store/store';
import { useWindowStore } from '../../src/store/windowStore';
import { useDraftsPanelStore } from '../../src/store/draftsPanelStore';
import { BAR_H } from '../../src/lib/metrics';
import type { WorkspaceDisplay } from '../../workspace/displays';
import type { WindowsDraftEntry, WindowsFilesChanged } from '../../filesystem/contracts';
import '../../src/index.css';

const rect = (x: number) => ({ x, y: 0, w: 640, h: 800 });
const displays: WorkspaceDisplay[] = [1, 2].map((id) => ({ id, label: `Монитор ${id}`, primary: id === 1, scaleFactor: 1, bounds: rect((id - 1) * 640), workArea: rect((id - 1) * 640) }));
const draft = (id: string, projects: string[] = []): WindowsDraftEntry => ({ name: `Черновик ${id}`, relativePath: id, storage: 'flux', draftId: id, kind: 'file', fileId: id, size: 0, modifiedAt: '', linked: false, parent: { rootId: 'root', relativePath: '' }, metadata: { fileId: id, tags: [], projectIds: projects, revision: '', responsible: '', history: [] } });
let entries = [draft('1'), draft('2'), draft('3', ['project'])];
let changed: ((change: WindowsFilesChanged) => void) | undefined;
(window as any).electron = { windowsFiles: {
  invoke: async (request: { action: string }) => request.action === 'draftsList' ? { ok: true, data: { entries, total: entries.length, nextOffset: null, unreadableCount: 0 } } : { ok: false, error: { code: 'UNSUPPORTED', message: 'Unsupported' } },
  onChanged: (callback: typeof changed) => { changed = callback; return () => { changed = undefined; }; },
}, ipcRenderer: { on: () => () => {} } };
useStore.setState({ user: { id: 'fixture', name: 'Тест', symbol: 'T', role: 'USER' } });
useWindowStore.setState({ displays, area: { w: 1280, h: 800 }, activeDisplayId: 1 });
(window as any).__drafts = { store: useDraftsPanelStore, windows: useWindowStore, setEntries: (next: WindowsDraftEntry[]) => { entries = next; changed?.({ rootId: 'root', relativePath: '', rescan: true }); }, draft };
createRoot(document.getElementById('mount')!).render(<div data-desk className="relative h-screen w-screen overflow-hidden">
  {displays.map((display) => <div key={display.id} className="absolute flex items-center" style={{ left: display.workArea.x, top: display.workArea.h - BAR_H, width: display.workArea.w, height: BAR_H }} onPointerDownCapture={() => useWindowStore.getState().setActiveDisplay(display.id)}><DraftsButton displayId={display.id} /></div>)}
  <DraftsLayer />
</div>);
