import { createServer } from 'vite';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as XLSX from 'xlsx';
import { chromium } from 'playwright-core';

process.env.DISABLE_HMR = 'true';
const root = process.cwd();
const fixture = path.join(root, 'scripts/fixtures/remaining-identity');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let passed = 0;
const assert = (condition: unknown, label: string) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  passed++;
  console.log(`✓ ${label}`);
};
const calls: Array<{ path: string; body: any }> = [];
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-test-identity-download-'));
fs.chmodSync(downloadDir, 0o700);
let applyCount = 0;
let undoCount = 0;

async function main() {
const port = await new Promise<number>((resolve, reject) => {
  const socket = createTcpServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    if (!address || typeof address === 'string') { socket.close(); reject(new Error('Could not allocate ephemeral port')); return; }
    socket.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const vite = await createServer({
  configFile: false,
  root: fixture,
  appType: 'mpa',
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  define: { 'import.meta.env.DISABLE_HMR': 'true' },
});
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not provide a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/users/import/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    calls.push({ path: p, body });
    if (p.endsWith('/preview')) {
      const rows = Array.from({ length: body.rows.length - 1 }, (_, i) => ({
        row: i + 2,
        values: { symbol: `SYN-${String(i + 1).padStart(3, '0')}`, name: `Synthetic Employee ${i + 1}`, role: 'ENGINEER_VENT', email: `synthetic${i + 1}@example.invalid`, password: '' },
        action: body.mode === 'update' ? 'update' : 'create',
        ...(body.mode === 'update' ? { existingId: `synthetic-existing-${i + 1}` } : {}),
      }));
      await route.fulfill({ json: { rows } });
      return;
    }
    if (p.endsWith('/apply')) {
      applyCount++;
      if (applyCount === 1) { await route.fulfill({ status: 503, json: { message: 'Synthetic temporary error' } }); return; }
      const credentials = body.mode === 'create' ? body.selected.map((row: number, index: number) => ({ symbol: index === 0 ? '=SUM(1;2)"fixture' : `SYN-${String(row - 1).padStart(3, '0')}`, password: index === 0 ? 'Synthetic; "Only" Pass-42' : 'Synthetic-Only-Pass-42' })) : [];
      await route.fulfill({ json: { credentials, undoToken: 'synthetic-undo-token', imported: body.selected.length } });
      return;
    }
    if (p.endsWith('/undo')) {
      undoCount++;
      if (undoCount === 1) { await route.fulfill({ status: 409, json: { message: 'Synthetic profile changed after import' } }); return; }
      await route.fulfill({ json: { undone: 1 } });
      return;
    }
    await route.fulfill({ status: 404, json: { message: 'Unexpected synthetic endpoint' } });
  });
  await page.goto(`${base}/employee-import.html`);
  await page.getByRole('dialog', { name: 'Импорт сотрудников' }).waitFor();
  const templateDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать шаблон XLSX' }).click();
  const template = await templateDownload;
  const templatePath = path.join(downloadDir, 'template.xlsx');
  await template.saveAs(templatePath);
  const templateBook = XLSX.readFile(templatePath);
  const templateRows = XLSX.utils.sheet_to_json<any[]>(templateBook.Sheets[templateBook.SheetNames[0]], { header: 1 });
  assert(templateRows[0][0] === 'Табельный номер' && templateRows[0].includes('Электронная почта') && templateRows.length === 2, 'downloaded XLSX template contains the import headers and an example');

  const csv = ['Табельный номер,ФИО,Электронная почта', ...Array.from({ length: 200 }, (_, i) => `SYN-${String(i + 1).padStart(3, '0')},Synthetic Employee ${i + 1},synthetic${i + 1}@example.invalid`)].join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-200.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const mappingField = (label: string) => page.locator('label.fx-field').filter({ has: page.locator('span.fx-label', { hasText: label }) }).locator('select').first();
  await mappingField('Табельный номер / логин').selectOption('0');
  await mappingField('ФИО целиком').selectOption('1');
  await page.getByRole('button', { name: 'Показать предпросмотр' }).click();
  await page.getByRole('row', { name: /SYN-200/ }).waitFor();
  assert(await page.getByRole('row').count() === 201, 'preview renders 200 synthetic employee records');
  assert(await page.getByRole('button', { name: /Импортировать 200/ }).count() === 1, 'preview selects all 200 valid rows by default');
  await page.screenshot({ path: '/tmp/remaining-identity-import-create.png' });
  await page.getByRole('checkbox', { name: 'Выбрать строку 3', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Выбрать строку 201', exact: true }).uncheck();
  assert(await page.getByRole('button', { name: /Импортировать 198/ }).count() === 1, 'row selection excludes only explicitly unchecked records');
  await page.getByRole('button', { name: /Импортировать 198/ }).click();
  await page.getByRole('alert').waitFor();
  assert(await page.getByRole('button', { name: /Импортировать 198/ }).isEnabled(), 'failed apply keeps selected rows available for retry');
  await page.getByRole('button', { name: /Импортировать 198/ }).click();
  await page.getByText(/Создано сотрудников: 198/).waitFor();
  const createCall = calls.filter((c) => c.path.endsWith('/apply')).at(-1)!;
  assert(createCall.body.mode === 'create' && createCall.body.selected.length === 198 && !createCall.body.selected.includes(3) && !createCall.body.selected.includes(201), 'create request carries the selected subset and create mode');
  assert(await page.evaluate(() => !JSON.stringify(localStorage).includes('Synthetic-Only-Pass-42')), 'synthetic initial password is not persisted in localStorage');
  const credentialDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать пароли CSV' }).click();
  const credentialsFile = await credentialDownload;
  const credentialsPath = path.join(downloadDir, 'credentials.csv');
  await credentialsFile.saveAs(credentialsPath);
  const credentialsCsv = fs.readFileSync(credentialsPath, 'utf8');
  const credentialsBook = XLSX.read(credentialsCsv, { type: 'string', FS: ';', raw: true });
  const credentialRows = XLSX.utils.sheet_to_json<any[]>(credentialsBook.Sheets[credentialsBook.SheetNames[0]], { header: 1, raw: true });
  assert(credentialRows.length === 199 && credentialRows[0][1] === 'Начальный пароль', 'downloaded CSV contains exactly the 198 selected credentials and its header');
  assert(credentialRows[1][0] === '\'=SUM(1;2)"fixture' && credentialRows[1][1] === 'Synthetic; "Only" Pass-42', 'CSV neutralizes a formula-prefixed login and preserves quotes and separators');
  assert(!credentialRows.some(row => row[0] === 'SYN-002' || row[0] === 'SYN-200'), 'CSV excludes unchecked employee rows');

  await page.getByRole('button', { name: 'Отменить импорт' }).click();
  await page.getByRole('alert').waitFor();
  assert(await page.getByRole('button', { name: 'Отменить импорт' }).isVisible(), 'undo conflict retains the token for a retry');
  await page.getByRole('button', { name: 'Отменить импорт' }).click();
  await page.getByRole('button', { name: 'Отменить импорт' }).waitFor({ state: 'detached' });
  assert(await page.evaluate(() => !localStorage.getItem('flux_employee_import_undo_remaining-identity-import-actor')), 'successful undo clears the actor-scoped token');
  assert(calls.filter((c) => c.path.endsWith('/undo')).every((c) => c.body.undoToken === 'synthetic-undo-token'), 'undo retries the same opaque token after conflict');

  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('dialog', { name: 'Импорт сотрудников' }).waitFor({ state: 'detached' });
  assert(applyCount === 2, 'closing the preview cancels the unsubmitted import without another apply');
  await page.getByRole('button', { name: 'Открыть импорт' }).click();
  await page.getByRole('dialog', { name: 'Импорт сотрудников' }).waitFor();
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-200.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await mappingField('Табельный номер / логин').selectOption('0');
  await mappingField('ФИО целиком').selectOption('1');
  const mode = page.locator('label.fx-field').filter({ hasText: 'Действие' }).locator('select');
  await mode.selectOption('update');
  await page.getByRole('button', { name: 'Показать предпросмотр' }).click();
  await page.getByText('Обновить', { exact: true }).first().waitFor();
  assert(await page.getByText('Обновить', { exact: true }).count() === 200, 'update preview labels all 200 matched rows as updates');
  await page.screenshot({ path: '/tmp/remaining-identity-import-update.png' });
  await page.getByRole('checkbox', { name: 'Выбрать все корректные строки' }).uncheck();
  await page.getByRole('checkbox', { name: 'Выбрать строку 2', exact: true }).check();
  await page.getByRole('button', { name: /Импортировать 1/ }).click();
  await page.getByText(/Импортировано сотрудников: 1/).waitFor();
  const updateCall = calls.filter((c) => c.path.endsWith('/apply')).at(-1)!;
  assert(updateCall.body.mode === 'update' && updateCall.body.selected.length === 1 && updateCall.body.selected[0] === 2, 'update request carries one selected row in update mode');
  assert(errors.length === 0, `fixture has no uncaught browser errors: ${errors.join('; ')}`);
  console.log(`PASS ${passed} synthetic component assertions; 200-row fixtures only, API responses mocked`);
} finally {
  await browser?.close();
  await vite.close();
  fs.rmSync(downloadDir, { recursive: true, force: true });
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
