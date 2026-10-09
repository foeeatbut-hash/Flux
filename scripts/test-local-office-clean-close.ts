/** Чистое локальное окно Таблицы: закрытие не вызывает native save/copy. */
import { createServer } from 'vite';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ok = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`✓ ${name}`);
  else throw new Error(`✗ ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
};

(async () => {
  const vite = process.env.FLUX_UI_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
  await vite?.listen();
  const address = vite?.httpServer?.address();
  const base = process.env.FLUX_UI_URL || (address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '');
  if (!base) throw new Error('Не получен адрес тестового сервера');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/genoffice/sheets/index.html', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><script>
        window.parent.postMessage({ flux: 'office', op: 'hello' }, location.origin);
        setTimeout(() => window.parent.postMessage({ flux: 'office', op: 'ipc-send', payload: { channel: 'flux:editor-ready', args: [{ app: 'sheets' }] } }, location.origin), 400);
      </script></body></html>`,
    }));
    await page.goto(`${base}/scripts/fixtures/local-office-clean-close.html`);
    const frame = page.locator('iframe[title="Flux Office — Таблица"]');
    await frame.waitFor();
    await page.waitForFunction(() => (window as any).__hasCleanCloseGuard?.());
    await page.waitForTimeout(150);
    ok('transport hello не снимает экран загрузки', await page.getByText('Открывается локальный редактор…').isVisible());
    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 5000 });
    const allowed = await page.evaluate(() => (window as any).__closeUnchangedSheet());
    const calls = await page.evaluate(() => (window as any).__nativeCalls as any[]);
    const copies = await page.evaluate(() => (window as any).__copyCalls as any[]);
    ok('неизменённое локальное окно можно закрыть', allowed === true);
    ok('чистое закрытие не вызывает native IO', calls.length === 0, calls);
    ok('чистое закрытие не создаёт копию', copies.length === 0, copies);
  } finally { await browser.close(); await vite?.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
