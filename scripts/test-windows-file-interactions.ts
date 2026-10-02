import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const check = (name: string, value: boolean) => { assert.ok(value, name); console.log(`✓ ${name}`); };
async function main() {
  const vite = process.env.FLUX_UI_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
  await vite?.listen();
  const address = vite?.httpServer?.address();
  const url = process.env.FLUX_UI_URL || (address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '');
  if (!url) throw new Error('Не получен адрес тестового сервера');
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', e => errors.push(e.message));
  const start = async () => { await page.goto(`${url}/scripts/fixtures/windows-file-interactions.html`); await page.getByRole('textbox', { name: 'Текст файла Windows' }).waitFor(); };
  const text = page.getByRole('textbox', { name: 'Текст файла Windows' });
  try {
    await start();
    await text.fill('keyboard save');
    await text.press('Control+s');
    await page.waitForFunction(() => (window as any).__localFiles.text('A.txt') === 'keyboard save', undefined, { timeout: 3000 });
    check('Ctrl+S saves the focused local text file', true);

    await start();
    await text.fill('snapshot');
    await page.evaluate(() => { (window as any).__localFiles.holdWrites = true; (window as any).__closeResult = (window as any).__localFiles.close(); });
    await page.waitForFunction(() => (window as any).__localFiles.writes.length === 1);
    await text.fill('typed while closing');
    await page.evaluate(() => (window as any).__localFiles.releaseWrite());
    const closed = await page.evaluate(() => (window as any).__closeResult);
    check('typing during close-save keeps the window open with the newer edits', closed === false && await text.inputValue() === 'typed while closing');

    await start();
    await page.evaluate(() => { (window as any).__localFiles.holdReads = true; });
    // Two route changes while the first file is still loading; both share a synthetic CAS token.
    await page.evaluate(() => (window as any).__navigateFile('UTF.txt'));
    await page.waitForFunction(() => (window as any).__localFiles.reads.some((r: any) => r.path === 'UTF.txt'));
    await page.evaluate(() => (window as any).__navigateFile('B.txt'));
    await page.waitForFunction(() => (window as any).__localFiles.reads.some((r: any) => r.path === 'B.txt'));
    await page.evaluate(() => (window as any).__localFiles.releaseRead('B.txt'));
    await page.waitForFunction(() => document.querySelector('textarea')?.value === 'second');
    await page.evaluate(() => (window as any).__localFiles.releaseRead('UTF.txt'));
    await page.waitForTimeout(50);
    check('a late read cannot replace the newly selected file', await text.inputValue() === 'second');
    await text.fill('B edited'); await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(() => (window as any).__localFiles.text('B.txt') === 'B edited');
    check('saving after a file switch writes only the new file', await page.evaluate(() => (window as any).__localFiles.text('UTF.txt') === 'строка\r\nвторая\r\n'));

    await start();
    await page.evaluate(() => (window as any).__navigateFile('UTF.txt'));
    await text.waitFor(); await page.waitForFunction(() => document.querySelector('textarea')?.value === 'строка\nвторая\n');
    await text.fill('копия\nтекст\n');
    await page.evaluate(() => (window as any).__localFiles.failWrites = true);
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить мою копию' }).click();
    await page.waitForFunction(() => (window as any).__localFiles.calls.some((r: any) => r.action === 'publish'));
    const copied = await page.evaluate(() => (window as any).__localFiles.bytes('Copy.txt'));
    check('Save my copy preserves UTF-8 BOM and Windows line endings', copied === Buffer.from('\ufeffкопия\r\nтекст\r\n').toString('base64'));
    check('local interaction scenarios have no browser exceptions', errors.length === 0);
  } finally { await browser.close(); await vite?.close(); }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
