/** Exercises the mounted DOCX iframe bridge against an in-memory disk CAS. */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const ok = (name: string, value: boolean) => { if (!value) throw new Error(`✗ ${name}`); console.log(`✓ ${name}`); };

(async () => {
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

    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 45_000 });
    await page.waitForFunction(() => (window as any).__hasCloseGuard());
    const closeResult = await page.evaluate(() => (window as any).__tryCloseAfterIframeCheck());
    const closeMessages = await frame.evaluate(() => (window as any).__hostMessages);
    const closeSaveSent = closeMessages.some((message: any) => message?.event === 'closeSave');
    ok('close asks the DOCX iframe to save and keeps it open after its negative answer', closeResult === false && closeSaveSent);
    ok('the local editor raised no browser errors', errors.length === 0);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
