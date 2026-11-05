import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const chrome = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
let completed = false;
process.on('exit', () => { if (!completed) process.exitCode = 1; });
(async () => {
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/scripts/fixtures/drafts-panel.html`);
    const left = page.locator('[data-drafts-button="1"]');
    const right = page.locator('[data-drafts-button="2"]');
    const panel = page.locator('[data-drafts-panel]');
    await left.getByText('2', { exact: true }).waitFor();
    assert.equal(await right.getByText('2', { exact: true }).count(), 1, 'счётчик только вне проекта на обоих мониторах');
    await right.click();
    await panel.waitFor();
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 640 && bounds.x + bounds.width <= 1280 && bounds.y >= 0, 'панель внутри правого монитора');
    assert.equal(await right.getAttribute('aria-expanded'), 'true');
    assert.equal(await left.getAttribute('aria-expanded'), 'false');
    await right.click();
    assert.equal(await panel.count(), 0, 'повторное нажатие закрывает панель');
    await left.click();
    await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 0, 'Escape закрывает панель');
    await left.click();
    await page.mouse.click(500, 100);
    assert.equal(await panel.count(), 0, 'щелчок снаружи закрывает панель');
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'в', code: 'KeyD', ctrlKey: true, altKey: true, bubbles: true })));
    await panel.waitFor();
    assert.equal(await left.getAttribute('aria-expanded'), 'true', 'сочетание работает при русской раскладке');
    await page.evaluate(() => { const f = (window as any).__drafts; f.setEntries([f.draft('новый')]); });
    await panel.getByText('Черновик новый').waitFor();
    await left.getByText('1', { exact: true }).waitFor();
    assert.equal(await panel.getByText('Черновик 1', { exact: true }).count(), 0, 'изменение источника обновляет список');
    // Обычное окно (один монитор): панель задач стоит под столом, и низ
    // панели — в 4 px над ней, а не ещё на высоту панели задач выше.
    await page.evaluate(() => { const f = (window as any).__drafts; f.store.getState().close(); f.windows.setState({ displays: [], area: { w: 1280, h: 752 }, activeDisplayId: null }); });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', ctrlKey: true, altKey: true, bubbles: true })));
    await panel.waitFor();
    const single = await panel.boundingBox();
    assert.ok(single && Math.abs(single.y + single.height - 748) <= 1, `в обычном окне панель стоит в 4 px над панелью задач (низ ${single && single.y + single.height})`);
    assert.deepEqual(errors, [], 'нет ошибок страницы');
    completed = true;
    console.log('Проверки панели черновиков пройдены');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
