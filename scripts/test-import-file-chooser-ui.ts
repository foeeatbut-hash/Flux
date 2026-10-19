const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';

void (async () => {
  const [{ chromium }] = await Promise.all([import('playwright-core')]);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let failed = false;
  const check = (name: string, value: boolean) => { if (value) console.log(`✓ ${name}`); else { failed = true; console.error(`✗ ${name}`); } };
  try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ content: `
    (() => {
      const nativeBytes = Uint8Array.from([0, 255, 128, 65]);
      const mirrorBytes = Uint8Array.from([1, 2, 0, 128]);
      const encode = bytes => btoa(String.fromCharCode(...bytes));
      window.__requests = [];
      window.__readRefs = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => String(input).includes('/api/settings/explorer_file_picker')
        ? new Response(JSON.stringify({ user: JSON.stringify({ system: true }) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : originalFetch(input, init);
      window.electron = { windowsFiles: { invoke: async request => {
        window.__requests.push(request);
        if (request.action === 'pickImportRefs') return { ok: true, data: { canceled: false, files: [{ name: 'native.xlsx', size: nativeBytes.length, lastModified: 1_700_000_000_000, ticket: 'native-1', provenance: { sourceFolder: { rootId: 'native-root', relativePath: 'Documents' }, fileRef: { rootId: 'native-root', relativePath: 'Documents/native.xlsx' }, folderKey: 'a'.repeat(64) } }] } };
        if (request.action === 'readImportRef' && request.ticket === 'native-1') return { ok: true, data: { name: 'native.xlsx', size: nativeBytes.length, offset: request.offset, base64: encode(nativeBytes.slice(request.offset, request.offset + request.length)) } };
        if (request.action === 'releaseImportRefs') return { ok: true, data: { released: request.tickets } };
        if (request.action === 'roots') return { ok: true, data: [{ id: 'network-root', name: 'Общая папка', kind: 'custom', network: true, available: true }] };
        if (request.action === 'list' && request.ref.relativePath === '') return { ok: true, data: { entries: [{ name: 'Импорты', relativePath: 'Импорты', storage: 'windows', kind: 'directory', fileId: 'dir-1', size: 0, modifiedAt: '', linked: false }], nextOffset: null } };
        if (request.action === 'list' && request.ref.relativePath === 'Импорты') return { ok: true, data: { entries: [{ name: 'mirror.xlsx', relativePath: 'Импорты/mirror.xlsx', storage: 'flux', draftId: 'draft-7', kind: 'file', fileId: 'shared-hardlink-id', size: mirrorBytes.length, modifiedAt: '', linked: false }, { name: 'mirror-copy.xlsx', relativePath: 'Импорты/mirror-copy.xlsx', storage: 'windows', kind: 'file', fileId: 'shared-hardlink-id', size: mirrorBytes.length, modifiedAt: '', linked: false }, { name: 'ignore.pdf', relativePath: 'Импорты/ignore.pdf', storage: 'windows', kind: 'file', fileId: 'pdf-id', size: 10, modifiedAt: '', linked: false }], nextOffset: null } };
        if (request.action === 'stat' && request.ref.relativePath === 'Импорты/mirror.xlsx') return { ok: true, data: { name: 'mirror.xlsx', relativePath: request.ref.relativePath, rootId: 'network-root', storage: 'flux', draftId: 'draft-7', kind: 'file', fileId: 'file-7', size: mirrorBytes.length, modifiedAt: '', linked: false } };
        if (request.action === 'prepareImportRefs') {
          window.__readRefs.push(...request.refs);
          return { ok: true, data: { files: request.refs.map((ref, index) => ({ name: ref.relativePath.endsWith('copy.xlsx') ? 'mirror-copy.xlsx' : 'mirror.xlsx', size: mirrorBytes.length, lastModified: 1_700_000_000_000, ticket: 'mirror-' + (index + 1), provenance: { sourceFolder: { rootId: ref.rootId, relativePath: 'Импорты' }, fileRef: ref } })) } };
        }
        if (request.action === 'readImportRef' && request.ticket.startsWith('mirror-')) {
          return { ok: true, data: { name: 'mirror.xlsx', size: mirrorBytes.length, offset: request.offset, base64: encode(mirrorBytes.slice(request.offset, request.offset + request.length)) } };
        }
        return { ok: false, error: { code: 'UNEXPECTED', message: 'Unexpected ' + request.action } };
      } } };
    })();
  ` });
  await page.goto(`${BASE}/scripts/fixtures/import-file-chooser.html`);
  const routeBeforeCancel = page.url();
  await page.getByRole('button', { name: 'Проводник' }).click();
  const cancelDialog = page.getByRole('dialog', { name: 'Выбрать файл из Проводника' });
  await cancelDialog.waitFor();
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  await cancelDialog.waitFor({ state: 'detached' });
  check('cancel closes the picker without changing the page route', page.url() === routeBeforeCancel);
  await page.getByRole('button', { name: 'Выбрать файл' }).click();
  await page.getByLabel('Полученные файлы').getByText('native.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|1700000000000|0,255,128,65').waitFor({ timeout: 5000 });
  check('native picker preserves XLSX MIME, modification time and byte content', await page.getByLabel('Полученные файлы').textContent() === 'native.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|1700000000000|0,255,128,65');
  check('native file keeps folder and opaque key provenance beside its file capability', await page.evaluate(() => (window as any).__receivedProvenance?.[0]?.sourceFolder?.relativePath === 'Documents' && (window as any).__receivedProvenance?.[0]?.fileRef?.relativePath === 'Documents/native.xlsx' && (window as any).__receivedProvenance?.[0]?.folderKey === 'a'.repeat(64)));

  await page.getByRole('button', { name: 'Проводник' }).click();
  await page.getByRole('dialog', { name: 'Выбрать файл из Проводника' }).waitFor();
  await page.getByRole('button', { name: 'Импорты' }).click();
  await page.locator('label').filter({ hasText: 'mirror.xlsx' }).locator('input[type=checkbox]').check();
  await page.locator('label').filter({ hasText: 'mirror-copy.xlsx' }).locator('input[type=checkbox]').check();
  check('MIME accept keeps XLSX aliases visible and excludes PDF', await page.locator('label').filter({ hasText: 'mirror.xlsx' }).count() === 1 && await page.locator('label').filter({ hasText: 'mirror-copy.xlsx' }).count() === 1 && await page.locator('label').filter({ hasText: 'ignore.pdf' }).count() === 0);
  check('same canonical ID at two paths selects both independently', await page.getByText('2 · 0.0 МБ').count() === 1);
  await page.getByRole('button', { name: 'Импортировать выбранное' }).click();
  await page.getByLabel('Полученные файлы').getByText('mirror.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|1700000000000|1,2,0,128').waitFor();
  const received = await page.getByLabel('Полученные файлы').textContent();
  check('mirrored refs preserve exact bytes, XLSX MIME and mtime', received === 'mirror.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|1700000000000|1,2,0,128;mirror-copy.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|1700000000000|1,2,0,128');
  check('Flux ticket provenance stays aligned with each selected file capability', await page.evaluate(() => (window as any).__receivedProvenance?.length === 2 && (window as any).__receivedProvenance?.[0]?.fileRef?.draftId === 'draft-7' && (window as any).__receivedProvenance?.[1]?.fileRef?.relativePath === 'Импорты/mirror-copy.xlsx'));
  check('mirrored reads keep distinct paths, canonical alias and draft capability', await page.evaluate(() => (window as any).__readRefs.length === 2 && (window as any).__readRefs[0]?.rootId === 'network-root' && (window as any).__readRefs[0]?.draftId === 'draft-7' && (window as any).__readRefs[0]?.relativePath === 'Импорты/mirror.xlsx' && (window as any).__readRefs[1]?.relativePath === 'Импорты/mirror-copy.xlsx'));
  check('chooser produces no browser errors', errors.length === 0);
  } finally { await browser.close(); }
  if (failed) process.exit(1);
})();
