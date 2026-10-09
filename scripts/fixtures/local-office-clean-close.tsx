import React from 'react';
import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import LocalOfficeEditor from '../../src/components/office/LocalOfficeEditor';
import { PaneContext } from '../../src/lib/paneTitle';
import { hasGuard, mayClose } from '../../src/lib/closeGuard';
import type { WindowsFileContent, WindowsFileRef } from '../../filesystem/contracts';

const ref: WindowsFileRef = { rootId: 'test-root', relativePath: 'Чистая книга.xlsx' };
const file: WindowsFileContent = {
  fileId: 'local-clean-sheet', name: 'Чистая книга.xlsx', relativePath: ref.relativePath,
  storage: 'windows', kind: 'file', size: 4, modifiedAt: new Date(0).toISOString(), linked: false,
  base64: 'UEsDBA==', sha256: 'unchanged',
};
const calls: any[] = [];
const copies: any[] = [];
(window as any).__nativeCalls = calls;
(window as any).__copyCalls = copies;
(window as any).electron = {
  localOffice: {
    invoke: async (request: any) => { calls.push(request); return { ok: true, data: request.action === 'open' ? { session: 71 } : {} }; },
    onEvent: () => () => undefined,
  },
};
(window as any).__hasCleanCloseGuard = () => hasGuard('local-clean-sheet-test');
(window as any).__closeUnchangedSheet = () => mayClose('local-clean-sheet-test');

function Fixture() {
  const saveHandle = React.useRef<(() => Promise<boolean>) | null>(null);
  return <PaneContext.Provider value="win:local-clean-sheet-test">
    <LocalOfficeEditor app="sheets" file={file} fileRef={ref} load={async () => file}
      write={async () => file} copy={async (...args) => { copies.push(args); return null; }} saveHandle={saveHandle} />
  </PaneContext.Provider>;
}

createRoot(document.getElementById('mount')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
