/** Exercises the mounted DOCX iframe bridge against an in-memory disk CAS. */
import { createServer } from 'vite';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const ok = (name: string, value: boolean) => { if (!value) throw new Error(`✗ ${name}`); console.log(`✓ ${name}`); };

(async () => {
  const vite = process.env.FLUX_UI_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
  await vite?.listen();
  const address = vite?.httpServer?.address();
  const BASE = process.env.FLUX_UI_URL || (address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '');
  if (!BASE) throw new Error('Не получен адрес тестового сервера');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 600, height: 800 });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.route('**/api/projects/local-project/tags', route => route.fulfill({ json: { tags: [{ id: 'tag-42', identifier: 'P-42' }] } }));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/genoffice/docs/index.html', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><script>
        window.__hostMessages = [];
        window.addEventListener('message', function hostMessage(event) {
          if (event.source !== window.parent || event.data?.flux !== 'office') return;
          const data = event.data; window.__hostMessages.push(data);
          if (data.event === 'closeCheck') window.parent.postMessage({ flux: 'office', op: 'closeCheck', payload: { dirty: true } }, location.origin);
          if (data.event === 'closeSave') window.parent.postMessage({ flux: 'office', op: 'closeSaveResult', payload: false }, location.origin);
        });
        window.parent.postMessage({ flux: 'office', op: 'hello' }, location.origin);
      </script></body></html>`,
    }));
    await page.goto(`${BASE}/scripts/fixtures/windows-file-docx.html`);
    const frameElement = page.locator('iframe[title="Flux Office — Документ"]');
    await frameElement.waitFor();
    await page.waitForFunction(() => (window as any).__disk?.calls.some((call: any) => call.action === 'read'));
    const frame = page.frames().find((item) => item.url().includes('/genoffice/docs/index.html'));
    if (!frame) throw new Error('DOCX iframe failed to load');
    await frame.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    await page.getByRole('complementary', { name: 'Flux' }).waitFor();
    const panelBounds = await page.getByRole('complementary', { name: 'Flux' }).boundingBox();
    ok('Flux ribbon opens an in-window panel at narrow viewport', !!panelBounds && panelBounds.x + panelBounds.width <= 600);
    await frame.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:tag-click', payload: { tagId: 'tag-42', identifier: 'P-42' } }, location.origin));
    await page.waitForFunction(() => (window as any).__tagNavigation()?.tagId === 'tag-42');
    const navigation = await page.evaluate(() => (window as any).__tagNavigation());
    ok('Word tag click resolves against the active project and opens its tag', navigation.projectId === 'local-project' && navigation.identifier === 'P-42');
    ok('local Flux panel never requests the private file id from cloud APIs', !requests.some(url => url.includes('mock-docx')));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { const pane = document.getElementById('mount')!; pane.style.width = '600px'; pane.style.height = '600px'; pane.style.marginLeft = '200px'; });
    const separator = page.getByRole('separator', { name: 'Изменить ширину панели Flux' });
    const bounds = await separator.boundingBox();
    if (!bounds) throw new Error('Flux resize handle is missing');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30); await page.mouse.down();
    await page.mouse.move(500, bounds.y + 30, { steps: 5 }); await page.mouse.up();
    const resized = await page.getByRole('complementary', { name: 'Flux' }).boundingBox();
    ok('Flux resize uses the moved editor edge instead of the desktop viewport', !!resized && Math.abs(resized.width - 300) < 4 && resized.x + resized.width <= 802);
    await separator.focus(); await separator.press('ArrowLeft');
    const keyboardWidth = await page.getByRole('complementary', { name: 'Flux' }).boundingBox();
    ok('keyboard resize also respects the editor bounds', !!keyboardWidth && Math.abs(keyboardWidth.width - 320) < 4);
    await page.evaluate(() => { document.getElementById('mount')!.style.width = '320px'; document.documentElement.classList.add('dark'); });
    await page.waitForFunction(() => document.querySelector('[aria-label="Flux"]')!.getBoundingClientRect().right <= 520);
    const compact = await page.getByRole('complementary', { name: 'Flux' }).boundingBox();
    const editorWidth = await frameElement.evaluate(element => element.getBoundingClientRect().width);
    ok('a narrow editor keeps its canvas and panel within the window in dark theme', !!compact && compact.width <= 308 && compact.x + compact.width <= 520 && editorWidth >= 316);
    await frame.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'open', id: 201, payload: {} }, location.origin));
    await page.waitForFunction(() => (window as any).__disk.content.fileId === 'mock-docx');
    ok('iframe open request reads the local file bridge', await page.evaluate(() => (window as any).__disk.calls[0].action === 'read'));

    const saved = [0x50, 0x4b, 1, 2, 3, 4, 5];
    await frame.evaluate((data) => window.parent.postMessage({ flux: 'office', op: 'save', id: 202, payload: { bytes: data } }, location.origin), saved);
    await page.waitForFunction((expected) => (window as any).__disk.content.base64 === btoa(String.fromCharCode(...expected)), saved);
    ok('Ctrl+S save writes bytes through the Windows CAS bridge', await page.evaluate(() => (window as any).__disk.calls.some((call: any) => call.action === 'write' && call.baseSha256 === 'sha-0')));

    const sourceBeforeCopy = await page.evaluate(() => (window as any).__disk.content.base64);
    const copyBytes = [0x50, 0x4b, 9, 8, 7];
    await frame.evaluate((data) => window.parent.postMessage({ flux: 'office', op: 'saveCopy', id: 203, payload: { bytes: data, name: 'Проект (копия).docx' } }, location.origin), copyBytes);
    await page.waitForFunction(() => (window as any).__disk.calls.some((call: any) => call.action === 'publish'));
    const copied = await page.evaluate(() => (window as any).__disk.calls.find((call: any) => call.action === 'publish'));
    const expectedCopy = Buffer.from(copyBytes).toString('base64');
    ok('Save As publishes the iframe DOCX bytes and preserves the source', copied.base64 === expectedCopy && await page.evaluate(() => (window as any).__disk.content.base64) === sourceBeforeCopy);

    await page.evaluate(() => { (window as any).__disk.rejectWrites = true; });
    await frame.evaluate((data) => window.parent.postMessage({ flux: 'office', op: 'save', id: 204, payload: { bytes: data } }, location.origin), saved);
    await page.getByRole('alert').filter({ hasText: 'Test write rejected' }).first().waitFor();
    await page.evaluate(() => { (window as any).__disk.rejectWrites = false; });
    await frame.evaluate((data) => window.parent.postMessage({ flux: 'office', op: 'save', id: 205, payload: { bytes: data } }, location.origin), saved);
    await page.waitForFunction(() => !(document.querySelector('[role="alert"]')?.textContent || '').includes('Test write rejected'));
    ok('a successful retry clears the previous save failure in both host and editor', await page.getByRole('alert').count() === 0);

    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 45_000 });
    await page.waitForFunction(() => (window as any).__hasCloseGuard());
    const closeResult = await page.evaluate(() => (window as any).__tryCloseAfterIframeCheck());
    const closeMessages = await frame.evaluate(() => (window as any).__hostMessages);
    const closeSaveSent = closeMessages.some((message: any) => message?.event === 'closeSave');
    ok('close asks the DOCX iframe to save and keeps it open after its negative answer', closeResult === false && closeSaveSent);
    ok('the local editor raised no browser errors', errors.length === 0);
  } finally { await browser.close(); await vite?.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
