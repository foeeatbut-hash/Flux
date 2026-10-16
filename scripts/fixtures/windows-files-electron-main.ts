import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { registerWindowsFilesIpc } from '../../electron/filesystem/ipc';

const envPath = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing test path: ${key}`);
  return value;
};

app.disableHardwareAcceleration();
app.setPath('userData', envPath('FLUX_FILES_TEST_USER_DATA'));
app.setPath('desktop', envPath('FLUX_FILES_TEST_DESKTOP'));
app.setPath('documents', envPath('FLUX_FILES_TEST_DOCUMENTS'));
app.setPath('downloads', envPath('FLUX_FILES_TEST_DOWNLOADS'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: envPath('FLUX_FILES_TEST_PRELOAD'),
    },
  });
  try {
    const isAllowedWindow = (event: IpcMainInvokeEvent) =>
      event.sender === window.webContents && event.senderFrame?.url.startsWith('data:text/html') === true;
    await registerWindowsFilesIpc({
      isTrusted: isAllowedWindow,
      mayRead: isAllowedWindow,
      mayWrite: isAllowedWindow,
    });
    await window.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3EFlux%20IPC%20test%3C%2Ftitle%3E');
    const result = await window.webContents.executeJavaScript(`(async () => {
      if (typeof window.electron?.windowsFiles?.invoke !== 'function') throw new Error('built preload did not expose windowsFiles.invoke');
      const invoke = window.electron.windowsFiles.invoke;
      const call = async request => {
        const response = await invoke(request);
        if (!response || response.ok !== true) throw new Error(request.action + ': ' + (response?.error?.code || 'NO_RESPONSE') + ' ' + (response?.error?.message || ''));
        return response.data;
      };
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const roots = await call({ action: 'roots' });
      const desktop = roots.find(root => root.kind === 'desktop');
      check(desktop && desktop.available, 'temporary desktop root was not registered');
      const root = { rootId: desktop.id, relativePath: '' };
      let listing = await call({ action: 'list', ref: root });
      check(listing.entries.some(entry => entry.name === 'Fixture.txt'), 'fixture file missing from real list action');
      let file = await call({ action: 'read', ref: { ...root, relativePath: 'Fixture.txt' } });
      check(atob(file.base64) === 'before', 'real read returned unexpected bytes');
      const updateBase64 = btoa('after-write');
      file = await call({ action: 'write', ref: { ...root, relativePath: 'Fixture.txt' }, base64: updateBase64, baseSha256: file.sha256 });
      check(atob(file.base64) === 'after-write', 'real write did not return updated bytes');
      const copied = await call({ action: 'copy', ref: { ...root, relativePath: 'Fixture.txt' }, parent: root, name: 'Copy.txt' });
      check(copied.ref?.relativePath === 'Copy.txt', 'copy did not return the created capability');
      const renamed = await call({ action: 'rename', ref: copied.ref, name: 'Renamed.txt' });
      check(renamed.ref?.relativePath === 'Renamed.txt', 'rename did not return the updated capability');
      await call({ action: 'mkdir', parent: root, name: 'Native Harness Folder' });
      const folder = { ...root, relativePath: 'Native Harness Folder' };
      const moved = await call({ action: 'move', ref: renamed.ref, parent: folder, name: 'Moved.txt' });
      check(moved.ref?.relativePath === 'Native Harness Folder/Moved.txt', 'move did not return the target capability');
      listing = await call({ action: 'list', ref: folder });
      check(listing.entries.length === 1 && listing.entries[0].name === 'Moved.txt', 'real list did not observe moved file');
      const movedFile = await call({ action: 'read', ref: moved.ref });
      await call({ action: 'permanentDelete', ref: moved.ref, baseSha256: movedFile.sha256 });
      const deleted = await invoke({ action: 'stat', ref: moved.ref });
      check(deleted?.ok === false && deleted.error?.code === 'ENOENT', 'permanentDelete did not remove fixture file');
      return { operations: ['roots', 'list', 'read', 'write', 'copy', 'rename', 'mkdir', 'move', 'permanentDelete'] };
    })()`);
    console.log('ELECTRON_FILES_IPC_PASS', JSON.stringify(result));
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}

void run().catch(error => {
  console.error('ELECTRON_FILES_IPC_FAIL', error?.stack || error);
  app.exit(1);
});
