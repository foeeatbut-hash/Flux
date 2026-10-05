import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

type Box = { x: number; y: number; width: number; height: number; bottom: number };
type Geometry = { taskbar: Box; desk: Box; root: Box };

async function main() {
  process.env.DISABLE_HMR = 'true';
  const vite = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not expose its isolated port');
    browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/remaining-shell/windows-layer-geometry.html`);
    await page.locator('[data-display-taskbar="1"]').waitFor();
    assert.equal(await page.locator('[data-desk] .absolute[title="Почта"]').count(), 0, 'a persisted pre-change Flux app pin is absent from the desktop');
    console.log('✓ persisted old Flux app pins do not produce desktop shortcuts');
    const geometry = () => page.evaluate<Geometry>(`(() => {
      const taskbar = document.querySelector('[data-display-taskbar="1"]');
      const desk = document.querySelector('[data-desk]');
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
      return { taskbar: rect(taskbar), desk: rect(desk), root: rect(document.querySelector('#root')) };
    })()`);
    const visible = await geometry();
    assert.deepEqual(visible.taskbar, { x: 0, y: 720, width: 1280, height: 40, bottom: 760 }, 'Flux taskbar reaches the Windows work-area edge');
    assert.equal(visible.desk.height, 800, 'renderer fills the BrowserWindow; the native HWND shape clips the reserved Windows area');
    assert.equal(visible.root.height, 800, 'no CSS bottom padding is inserted for the Windows taskbar');
    console.log(`✓ visible Windows taskbar: ${JSON.stringify(visible)}`);

    await page.evaluate('window.__setWindowsTaskbar(false)');
    await page.waitForTimeout(50);
    const legacyPreference = await geometry();
    assert.deepEqual(legacyPreference.taskbar, visible.taskbar, 'an old preference cannot move Flux into the Windows taskbar area');
    assert.equal(legacyPreference.root.height, 800, 'legacy preference does not add a white placeholder strip');
    console.log(`✓ legacy hide preference is ignored: ${JSON.stringify(legacyPreference)}`);

    const frame = await page.evaluate<{ windowed: string; maximized: string; coverage: string; darkTheme: boolean; lightCornerBackgroundMatches: boolean; darkCornerBackgroundMatches: { app: string; body: string } }>(`(() => {
      const root = document.documentElement;
      const app = document.querySelector('.flux-app-window');
      root.dataset.fluxElectronWindow = 'true';
      root.dataset.fluxWindowMaximized = 'false';
      root.dataset.fluxAllMonitors = 'false';
      const windowed = getComputedStyle(app).borderRadius;
      root.dataset.fluxWindowMaximized = 'true';
      const maximized = getComputedStyle(app).borderRadius;
      root.dataset.fluxWindowMaximized = 'false';
      root.dataset.fluxAllMonitors = 'true';
      const coverage = getComputedStyle(app).borderRadius;
      root.dataset.fluxAllMonitors = 'false';
      root.classList.add('dark');
      const darkTheme = getComputedStyle(app).boxShadow.includes('rgba(0, 0, 0');
      const darkCornerBackgroundMatches = { app: getComputedStyle(app).backgroundColor, body: getComputedStyle(document.body).backgroundColor };
      root.classList.remove('dark');
      const lightCornerBackgroundMatches = getComputedStyle(app).backgroundColor === getComputedStyle(document.body).backgroundColor;
      return { windowed, maximized, coverage, darkTheme, lightCornerBackgroundMatches, darkCornerBackgroundMatches };
    })()`);
    assert.equal(frame.darkCornerBackgroundMatches.app, frame.darkCornerBackgroundMatches.body, `dark rounded window corner background mismatch: ${JSON.stringify(frame.darkCornerBackgroundMatches)}`);
    assert.deepEqual({ ...frame, darkCornerBackgroundMatches: true }, { windowed: '10px', maximized: '0px', coverage: '0px', darkTheme: true, lightCornerBackgroundMatches: true, darkCornerBackgroundMatches: true });
    console.log(`✓ conditional native frame CSS: ${JSON.stringify(frame)}`);

    await page.waitForFunction('typeof window.__navigate === "function"');
    await page.evaluate('window.__navigate("/settings")');
    await page.waitForFunction('window.__windowStore.getState().windows.some(w => w.path === "/settings")');
    await page.evaluate(`(() => { const st = window.__windowStore.getState(); const w = st.windows.find(w => w.path === '/settings'); st.minimize(w.id); window.__refreshPolicy(); })()`);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate('window.__windowStore.getState().windows.find(w => w.path === "/settings").minimized'), true, 'policy refresh must not restore minimized windows');
    console.log('✓ rights refresh does not restore a minimized window');
    await page.evaluate(`(() => { const st = window.__windowStore.getState(); st.close(st.windows.find(w => w.path === '/settings').id); window.__refreshPolicy(); })()`);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate('window.__windowStore.getState().windows.some(w => w.path === "/settings")'), false, 'policy refresh must not reopen closed windows');
    console.log('✓ rights refresh does not reopen a closed window');
    await page.evaluate('window.__navigate("/settings?section=general")');
    await page.waitForFunction('window.__windowStore.getState().windows.some(w => w.path === "/settings")');
    console.log('✓ explicit navigation opens the program again');
  } finally {
    await browser?.close();
    await vite.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
