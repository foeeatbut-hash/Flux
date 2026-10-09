import React from 'react';
import { createRoot } from 'react-dom/client';
import ContentsPane from '../../../src/components/files/ContentsPane';
import CommandBar from '../../../src/components/files/CommandBar';
import { useSelection } from '../../../src/components/files/useSelection';
import { DEFAULT_VIEW, type FolderView } from '../../../src/components/files/viewModel';
import type { WindowsFileEntry } from '../../../src/lib/windowsFiles';
import '../../../src/index.css';

const entries: WindowsFileEntry[] = Array.from({ length: 80 }, (_, index) => ({
  name: `Документ ${String(index).padStart(3, '0')}.txt`, relativePath: `Документ ${String(index).padStart(3, '0')}.txt`,
  storage: 'windows', kind: index === 0 ? 'directory' : 'file', fileId: `fixture-${index}`, size: index * 100,
  modifiedAt: '2026-01-01T00:00:00.000Z', linked: false,
}));
function Fixture() {
  const selection = useSelection(entries, 'contents-fixture');
  const [view, setView] = React.useState<FolderView>(DEFAULT_VIEW);
  React.useEffect(() => { (window as any).__fixtureView = view; }, [view]);
  return <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <CommandBar view={view} onView={setView} selected={selection.selected.length} busy={false} canPaste={false} onCut={() => undefined} onCopy={() => undefined} onPaste={() => undefined} onRename={() => undefined} onDelete={() => undefined} onUndo={() => undefined} onRedo={() => undefined} pane="none" onPane={() => undefined} onProperties={() => undefined} />
    <ContentsPane entries={entries} rootId="fixture" selection={selection} view={view} onViewChange={setView} onOpen={(entry) => { (window as any).__opened = entry.fileId; }} onContext={() => undefined} onDragStart={() => undefined} />
  </div>;
}
const bridgeCalls: unknown[] = [];
(window as any).__contentsBridgeCalls = bridgeCalls;
(window as any).electron = { windowsFiles: { invoke: async (request: any) => {
  bridgeCalls.push(request);
  return request.action === 'systemProperties'
    ? { ok: true, data: { author: 'Стендовый автор', createdAt: '2026-01-01T00:00:00.000Z', hidden: false } }
    : { ok: false, error: { code: 'FIXTURE', message: 'Fixture' } };
}, onChanged: () => () => undefined } };
createRoot(document.getElementById('mount')!).render(<Fixture />);
