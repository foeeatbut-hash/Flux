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
      window.electron = { windowsFiles: { invoke: async request => {
        window.__requests.push(request);
        if (request.action === 'pickImport') return { ok: true, data: { canceled: false, files: [{ name: 'native.xlsx', size: nativeBytes.length, base64: encode(nativeBytes) }] } };
        if (request.action === 'roots') return { ok: true, data: [{ id: 'network-root', name: 'Общая папка', kind: 'custom', network: true, available: true }] };
        if (request.action === 'list' && request.ref.relativePath === '') return { ok: true, data: { entries: [{ name: 'Импорты', relativePath: 'Импорты', storage: 'windows', kind: 'directory', fileId: 'dir-1', size: 0, modifiedAt: '', linked: false }], nextOffset: null } };
        if (request.action === 'list' && request.ref.relativePath === 'Импорты') return { ok: true, data: { entries: [{ name: 'mirror.xlsx', relativePath: 'Импорты/mirror.xlsx', storage: 'flux', draftId: 'draft-7', kind: 'file', fileId: 'file-7', size: mirrorBytes.length, modifiedAt: '', linked: false }], nextOffset: null } };
        if (request.action === 'read') {
          window.__readRefs.push(request.ref);
          return { ok: true, data: { name: 'mirror.xlsx', size: mirrorBytes.length, base64: encode(mirrorBytes) } };
        }
        return { ok: false, error: { code: 'UNEXPECTED', message: 'Unexpected ' + request.action } };
      } } };
    })();
  ` });
  await page.goto(`${BASE}/scripts/fixtures/import-file-chooser.html`);
  await page.getByRole('button', { name: 'Выбрать файл' }).click();
  await page.getByLabel('Полученные файлы').getByText('native.xlsx|0,255,128,65').waitFor({ timeout: 5000 });
  check('native picker byte payload becomes the exact File content', await page.getByLabel('Полученные файлы').textContent() === 'native.xlsx|0,255,128,65');

  await page.getByRole('button', { name: 'Проводник' }).click();
  await page.getByRole('dialog', { name: 'Выбрать файл из Проводника' }).waitFor();
  await page.getByRole('button', { name: 'Импорты' }).click();
  await page.locator('label').filter({ hasText: 'mirror.xlsx' }).locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Импортировать выбранное' }).click();
  await page.getByLabel('Полученные файлы').getByText('mirror.xlsx|1,2,0,128').waitFor();
  check('mirrored ref returns the exact draft file bytes', await page.getByLabel('Полученные файлы').textContent() === 'mirror.xlsx|1,2,0,128');
  check('mirrored read keeps the draft capability and network root', await page.evaluate(() => (window as any).__readRefs[0]?.rootId === 'network-root' && (window as any).__readRefs[0]?.draftId === 'draft-7' && (window as any).__readRefs[0]?.relativePath === 'Импорты/mirror.xlsx'));
  check('chooser produces no browser errors', errors.length === 0);
  } finally { await browser.close(); }
  if (failed) process.exit(1);
})();
