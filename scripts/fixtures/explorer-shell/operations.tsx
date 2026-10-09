import React from 'react';
import { createRoot } from 'react-dom/client';
import { Btn } from '../../../src/components/ui';
import { useExplorerOperations } from '../../../src/components/files/useExplorerOperations';
import RecyclePane from '../../../src/components/files/RecyclePane';
import type { WindowsFileEntry, WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse, WindowsPublishPlan, WindowsRecycleItem } from '../../../src/lib/windowsFiles';
import type { Clip } from '../../../src/components/files/fileOps';
import '../../../src/index.css';

type Stored = { entry: WindowsFileEntry; text: string; sha: string; meta?: boolean };
type MockState = { files: Map<string, Stored>; drafts: Map<string, Stored>; windowsTrash: WindowsRecycleItem[]; fluxTrash: any[]; calls: WindowsFilesRequest[]; groups: string[]; publishPlan: WindowsPublishPlan; ticketNames: string[]; ticketDone: Set<number>; failNames: string[]; hashFailNames: string[]; purgeFailure?: { draftId: string; mode: 'error' | 'throw' }; delayName: string; delayMs: number; undoGroups: string[]; changed: number };
const key = (ref: WindowsFileRef) => ref.draftId || `${ref.rootId}/${ref.relativePath}`;
const root = { rootId: 'root', relativePath: '' };
const makeEntry = (name: string, options: Partial<WindowsFileEntry> = {}): WindowsFileEntry => ({ name, relativePath: name, rootId: 'root', storage: 'windows', kind: 'file', fileId: `file-${name}`, size: 1, modifiedAt: '2026-01-01T00:00:00.000Z', linked: false, ...options });
const blob = (text: string) => btoa(unescape(encodeURIComponent(text)));
const unblob = (base64: string) => decodeURIComponent(escape(atob(base64)));
function seed(): MockState {
  const files = new Map<string, Stored>(); const drafts = new Map<string, Stored>();
  for (const name of ['source-a.txt', 'source-b.txt', 'source-c.txt', 'bad-move.txt', 'collision-replace.txt', 'collision-keep.txt', 'collision-skip.txt']) {
    const entry = makeEntry(name, { relativePath: `src/${name}` });
    files.set(key({ ...root, relativePath: entry.relativePath }), { entry, text: `bytes:${name}`, sha: `sha:${name}` });
  }
  for (const name of ['occupied.txt', 'same.txt', 'collision-replace.txt', 'collision-keep.txt', 'collision-skip.txt']) {
    const entry = makeEntry(name); files.set(key({ ...root, relativePath: name }), { entry, text: `target:${name}`, sha: `sha:target:${name}` });
  }
  const draftEntry = makeEntry('draft.txt', { storage: 'flux', draftId: 'draft-1' });
  drafts.set(key({ ...root, relativePath: 'draft.txt', draftId: 'draft-1' }), { entry: draftEntry, text: 'bytes:draft', sha: 'sha:draft' });
  const fluxTrash: any[] = [{ ref: { rootId: 'root', relativePath: 'gone.txt', draftId: 'gone-1' }, name: 'gone.txt', fileId: 'draft-file' }];
  if (new URLSearchParams(window.location.search).has('extraDraft')) fluxTrash.push({ ref: { rootId: 'root', relativePath: 'gone-2.txt', draftId: 'gone-2' }, name: 'gone-2.txt', fileId: 'draft-file-2' });
  return { files, drafts, windowsTrash: [{ id: 'recycle-1', name: 'restored.txt', location: 'C:\\Temp', deletedAt: null, size: 2, kind: 'file' }, { id: 'recycle-2', name: 'keep.txt', location: 'C:\\Temp', deletedAt: null, size: 3, kind: 'file' }], fluxTrash, calls: [], groups: [], publishPlan: { ref: { rootId: 'root', relativePath: 'publish-root', draftId: 'publish-root' }, items: [], collisions: 0, blocked: 0, truncated: false }, ticketNames: ['windows-new.txt', 'occupied.txt'], ticketDone: new Set(), failNames: [], hashFailNames: [], delayName: '', delayMs: 0, undoGroups: [], changed: 0 };
}
const state = seed();
const answer = <T,>(data: T): WindowsFilesResponse<T> => ({ ok: true, data });
const fail = (message: string): WindowsFilesResponse<never> => ({ ok: false, error: { code: 'FIXTURE_ERROR', message } });
function entryFor(stored: Stored) { return { ...stored.entry }; }
function source(ref: WindowsFileRef) { return (ref.draftId ? state.drafts : state.files).get(key(ref)); }
const bridge = {
  invoke: async <T,>(request: WindowsFilesRequest): Promise<WindowsFilesResponse<T>> => {
    state.calls.push(request);
    const req = request as any;
    if (req.group) { state.groups.push(req.group); state.undoGroups.push(req.group); }
    switch (req.action) {
      case 'undoState': return answer({ undo: state.undoGroups.length ? { id: 'undo-1', label: 'Операция Проводника', at: '' } : null, redo: null }) as WindowsFilesResponse<T>;
      case 'undo': return answer({ label: 'Пакет файловых операций', state: { undo: null, redo: { id: 'redo-1', label: 'Пакет файловых операций', at: '' } } }) as WindowsFilesResponse<T>;
      case 'redo': return answer({ label: 'Пакет файловых операций', state: { undo: null, redo: null } }) as WindowsFilesResponse<T>;
      case 'list': {
        const all = [...state.files.values(), ...state.drafts.values()].map(entryFor).filter((entry) => entry.relativePath.split('/').slice(0, -1).join('/') === req.ref.relativePath);
        return answer({ entries: all, nextOffset: null, truncated: false }) as WindowsFilesResponse<T>;
      }
      case 'read': {
        const item = source(req.ref); if (!item) return fail('Исходный файл не найден') as WindowsFilesResponse<T>;
        return answer({ ...item.entry, base64: blob(item.text), sha256: item.sha }) as WindowsFilesResponse<T>;
      }
      case 'fileHash': {
        const item = source(req.ref); if (!item) return fail('Файл не найден') as WindowsFilesResponse<T>;
        if (state.hashFailNames.includes(item.entry.name)) return fail('Фикстура отказала в вычислении хеша') as WindowsFilesResponse<T>;
        return answer({ sha256: item.sha, size: item.text.length }) as WindowsFilesResponse<T>;
      }
      case 'copy': case 'move': {
        if (state.delayName && req.name === state.delayName) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
        if (state.failNames.includes(req.name)) return fail('Искусственный отказ файловой операции') as WindowsFilesResponse<T>;
        const item = source(req.ref); if (!item) return fail('Исходный файл не найден') as WindowsFilesResponse<T>;
        const ref = { rootId: req.parent.rootId, relativePath: req.parent.relativePath ? `${req.parent.relativePath}/${req.name}` : req.name };
        if (state.files.has(key(ref))) return fail('Имя уже занято') as WindowsFilesResponse<T>;
        const entry = makeEntry(req.name, { relativePath: ref.relativePath, kind: item.entry.kind });
        state.files.set(key(ref), { entry, text: item.text, sha: item.sha, meta: !!req.carryMeta });
        if (req.action === 'move') (req.ref.draftId ? state.drafts : state.files).delete(key(req.ref));
        return answer({ ref }) as WindowsFilesResponse<T>;
      }
      case 'replaceCopy': {
        const item = source(req.ref); const targetRef = { rootId: req.parent.rootId, relativePath: req.parent.relativePath ? `${req.parent.relativePath}/${req.name}` : req.name }; const target = state.files.get(key(targetRef));
        if (!item || !target || target.sha !== req.targetSha256 || item.sha !== req.baseSha256) return fail('Файл изменился перед заменой') as WindowsFilesResponse<T>;
        target.text = item.text; target.sha = item.sha; target.meta = !!req.carryMeta;
        if (req.move) (req.ref.draftId ? state.drafts : state.files).delete(key(req.ref));
        return answer({ replaced: true }) as WindowsFilesResponse<T>;
      }
      case 'trash': case 'permanentDelete': {
        const item = source(req.ref); if (!item) return fail('Объект не найден') as WindowsFilesResponse<T>;
        (req.ref.draftId ? state.drafts : state.files).delete(key(req.ref));
        if (req.action === 'trash') {
          if (req.ref.draftId) state.fluxTrash.push({ ref: req.ref, name: item.entry.name, fileId: item.entry.fileId });
          else state.windowsTrash.push({ id: `recycle-${Date.now()}`, name: item.entry.name, location: 'C:\\Temp', deletedAt: null, size: item.entry.size, kind: item.entry.kind === 'directory' ? 'directory' : item.entry.kind === 'file' ? 'file' : 'other' });
        }
        return answer({ deleted: true }) as WindowsFilesResponse<T>;
      }
      case 'importPaths': {
        const imported: any[] = []; const collisions: any[] = []; const skipped: string[] = []; const failed: any[] = [];
        for (let index = 0; index < state.ticketNames.length; index++) {
          if (state.ticketDone.has(index)) continue;
          const name = state.ticketNames[index]; const existing = state.files.get(`root/${name}`); const choice = req.resolutions?.[String(index)];
          if (existing && !choice) { collisions.push({ index, name, kind: 'file', incoming: { size: 1, modifiedAt: '' }, existing: { size: 1, modifiedAt: '', kind: 'file' } }); continue; }
          if (choice === 'skip') { skipped.push(name); state.ticketDone.add(index); continue; }
          if (choice === 'replace' && existing) { existing.text = `import:${name}`; existing.sha = `sha:import:${name}`; imported.push({ name, ref: { rootId: 'root', relativePath: name } }); state.ticketDone.add(index); continue; }
          const targetName = choice === 'keepBoth' && existing ? `${name.replace(/\.txt$/u, '')} - копия.txt` : name;
          state.files.set(`root/${targetName}`, { entry: makeEntry(targetName), text: `import:${name}`, sha: `sha:import:${name}` }); imported.push({ name: targetName, ref: { rootId: 'root', relativePath: targetName } }); state.ticketDone.add(index);
        }
        return answer({ imported, collisions, skipped, failed, complete: !collisions.length }) as WindowsFilesResponse<T>;
      }
      case 'publishPlan': return answer(state.publishPlan) as WindowsFilesResponse<T>;
      case 'publishDraft': case 'publishDraftTree': {
        const eligible = state.publishPlan.items.filter((item) => item.status !== 'blocked');
        const blocked = state.publishPlan.items.filter((item) => item.status === 'blocked');
        const published = eligible.filter((item) => !item.status || item.status === 'free' || req.choices?.[item.draftId]).length;
        return answer({ ref: req.ref, published, failed: blocked.map((item) => `${item.name}: ${item.reason}`), complete: !blocked.length, skipped: Object.values(req.choices || {}).filter((choice) => choice === 'skip').length }) as WindowsFilesResponse<T>;
      }
      case 'recycleBin': return answer({ supported: true, items: [...state.windowsTrash] }) as WindowsFilesResponse<T>;
      case 'recycleBinRestore': {
        const restored = state.windowsTrash.filter((item) => req.ids.includes(item.id));
        for (const item of restored) { const entry = makeEntry(item.name); state.files.set(key({ ...root, relativePath: item.name }), { entry, text: `restored:${item.name}`, sha: `sha:restored:${item.name}` }); }
        state.windowsTrash = state.windowsTrash.filter((item) => !req.ids.includes(item.id)); return answer({ restored: req.ids.length }) as WindowsFilesResponse<T>;
      }
      case 'recycleBinPurge': state.windowsTrash = state.windowsTrash.filter((item) => !req.ids.includes(item.id)); return answer({ purged: req.ids.length }) as WindowsFilesResponse<T>;
      case 'recycleBinEmpty': state.windowsTrash = []; return answer({ emptied: true }) as WindowsFilesResponse<T>;
      case 'draftTrash': return answer([...state.fluxTrash]) as WindowsFilesResponse<T>;
      case 'restoreDraft': state.fluxTrash = state.fluxTrash.filter((item) => item.ref.draftId !== req.ref.draftId); state.drafts.set(key(req.ref), { entry: makeEntry(req.ref.relativePath, { storage: 'flux', draftId: req.ref.draftId }), text: 'restored draft', sha: 'sha:restored' }); return answer({ ref: req.ref }) as WindowsFilesResponse<T>;
      case 'purgeDraft': {
        const item = state.fluxTrash.find((draft) => draft.ref.draftId === req.ref.draftId);
        if (!item) return fail('Черновик не найден') as WindowsFilesResponse<T>;
        if (state.purgeFailure?.draftId === req.ref.draftId) {
          if (state.purgeFailure.mode === 'throw') throw new Error('Фикстура выбросила ошибку purgeDraft');
          return fail('Фикстура вернула ошибку purgeDraft') as WindowsFilesResponse<T>;
        }
        state.fluxTrash = state.fluxTrash.filter((draft) => draft.ref.draftId !== req.ref.draftId && !(draft.ref.rootId === req.ref.rootId && draft.ref.relativePath.startsWith(`${req.ref.relativePath}/`)));
        state.drafts.delete(req.ref.draftId);
        return answer({ deleted: 1 }) as WindowsFilesResponse<T>;
      }
      case 'openRecycleBin': return answer({ opened: true }) as WindowsFilesResponse<T>;
      default: return fail(`Неожиданная команда: ${req.action}`) as WindowsFilesResponse<T>;
    }
  },
  onChanged: () => () => undefined,
  takeDrop: () => ({ ticket: 'fixture-ticket-1234', names: [...state.ticketNames] }),
};
(window as any).electron = { windowsFiles: bridge };

function Fixture() {
  const entries = [...state.files.values(), ...state.drafts.values()].map(entryFor);
  const [revision, setRevision] = React.useState(0);
  const [entryName, setEntryName] = React.useState('source-a.txt');
  const operations = useExplorerOperations({ folder: root, reload: async () => { setRevision((value) => value + 1); }, selected: entries.filter((item) => item.name === entryName), rootId: 'root' });
  (window as any).__ops = operations;
  (window as any).__fixture = { state, setEntryName, setPlan: (plan: WindowsPublishPlan) => { state.publishPlan = plan; }, setTicket: (names: string[]) => { state.ticketNames = names; }, fail: (names: string[]) => { state.failNames = names; }, failHash: (names: string[]) => { state.hashFailNames = names; }, purgeFailure: (draftId: string, mode: 'error' | 'throw') => { state.purgeFailure = { draftId, mode }; }, delay: (name: string, ms: number) => { state.delayName = name; state.delayMs = ms; }, prepare: (names: string[], cut = false) => { const selected = names.map((name) => entries.find((entry) => entry.name === name)).filter((entry): entry is WindowsFileEntry => !!entry); if (cut) operations.cut(selected); else operations.copy(selected); }, touch: () => setRevision((value) => value + 1), getClip: (): Clip | null => operations.clip, changed: () => state.changed };
  const selected = entries.find((item) => item.name === entryName);
  const dropWindows = () => operations.drop({ preventDefault() {}, ctrlKey: false, metaKey: false, dataTransfer: { getData: () => '' } } as unknown as React.DragEvent, root);
  return <main className="space-y-3 p-4" data-revision={revision}>
    <div className="flex flex-wrap gap-2">
      <label>Источник<select aria-label="Источник" value={entryName} onChange={(event) => setEntryName(event.target.value)}>{entries.map((entry) => <option key={`${entry.relativePath}:${entry.fileId}`} value={entry.name}>{entry.name}</option>)}</select></label>
      <Btn onClick={() => operations.copy(selected ? [selected] : [])}>Подготовить копирование</Btn><Btn onClick={() => operations.cut(selected ? [selected] : [])}>Подготовить вырезание</Btn>
      <Btn onClick={() => void operations.paste()}>Вставить буфер</Btn><Btn onClick={dropWindows}>Импорт drop</Btn><Btn onClick={() => selected && void operations.publish(selected)}>Публиковать черновик</Btn>
      <Btn onClick={() => void operations.trash(selected ? [selected] : [])}>Переместить в корзину</Btn>
    </div>
    <p role="status">Буфер: {operations.clip ? `${operations.clip.cut ? 'вырезание' : 'копирование'} ${operations.clip.items.map((item) => item.name).join(', ')}` : 'пуст'}</p>
    {operations.element}
    <RecyclePane onChanged={() => { state.changed++; setRevision((value) => value + 1); }} />
  </main>;
}
createRoot(document.getElementById('mount')!).render(<Fixture />);
