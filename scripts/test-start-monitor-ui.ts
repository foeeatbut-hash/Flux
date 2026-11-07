/**
 * «Пуск» открывается на том мониторе, где нажали его кнопку. Стенд —
 * scripts/fixtures/start-monitor.html (настоящий WindowsLayer, два монитора
 * разной ширины и высоты). Меряется видимая рамка меню, а не разметка.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5391 FLUX_CHROME=… npx tsx scripts/test-start-monitor-ui.ts
 */
import assert from 'node:assert/strict';
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 700 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/scripts/fixtures/start-monitor.html`);
    await page.waitForSelector('[data-display-taskbar="2"]');
    const menu = page.locator('[role="dialog"][aria-label="Пуск"]');
    const box = async () => { await page.waitForTimeout(350); return menu.boundingBox(); }; // fx-rise-in сдвигает меню при появлении
    const btn = (id: number) => page.locator(`[data-display-taskbar="${id}"] button[aria-label="Пуск"]`);

    await btn(1).click();
    const first = await box();
    const bar1 = await btn(1).boundingBox();
    assert.ok(first && first.x >= 0 && first.x + first.width <= 700, `меню первого монитора внутри него (x=${first?.x})`);
    assert.ok(first && bar1 && first.y + first.height <= bar1.y, 'меню над панелью первого монитора');
    await btn(1).click();
    await page.waitForTimeout(150);
    assert.equal(await menu.count(), 0, 'повторный щелчок по «Пуску» закрывает меню, а не открывает заново');
    await btn(1).click();
    await box();
    await btn(2).click();
    const moved = await box();
    assert.equal(await menu.count(), 1, 'меню одно');
    assert.ok(moved && moved.x >= 700, `щелчок по «Пуску» другого монитора переносит меню туда (x=${moved?.x})`);
    await btn(1).click();
    await box();
    assert.ok((await menu.boundingBox())!.x < 700, 'и обратно');
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0, 'Escape закрывает');

    await btn(2).click();
    const second = await box();
    const bar2 = await btn(2).boundingBox();
    assert.ok(second && second.x >= 700 && second.x + second.width <= 1600, `меню второго монитора внутри него (x=${second?.x})`);
    assert.ok(second && bar2 && second.y + second.height <= bar2.y && bar2.y - (second.y + second.height) < 20, `меню прижато к панели второго монитора (низ ${second && second.y + second.height}, панель ${bar2?.y})`);
    assert.ok(second && bar2 && Math.abs(second.x - bar2.x) < 12, 'левый край меню у кнопки «Пуск» второго монитора');

    // Центр уведомлений и помощник: открываются на мониторе, где нажали их кнопку
    const dock = page.locator('[data-right-dock]');
    const tray = (id: number, which: 'assist' | 'notif') => page.locator(`[data-display-taskbar="${id}"] [data-tray-toggle]`).nth(which === 'assist' ? 0 : -1);
    for (const which of ['notif', 'assist'] as const) {
      for (const id of [2, 1]) {
        await page.evaluate(() => { (window as any).__fx.closePanels(); });
        await page.waitForTimeout(300);
        await tray(id, which).click();
        await dock.waitFor();
        await page.waitForTimeout(350);
        const d = await dock.boundingBox();
        const t = await tray(id, which).boundingBox();
        const [lo, hi] = id === 2 ? [700, 1600] : [0, 700];
        assert.ok(d && t && d.x >= lo - 1 && d.x + d.width <= hi + 1 && d.y + d.height <= t.y + 1, `${which}: на мониторе ${id}, над его панелью (x=${d?.x}, ширина ${d?.width})`);
      }
    }
    await page.evaluate(() => { (window as any).__fx.closePanels(); });

    // Обычное окно (один монитор) — как раньше: у левого края, над панелью
    const solo = await browser.newPage({ viewport: { width: 1600, height: 700 } });
    await solo.goto(`${BASE}/scripts/fixtures/start-monitor.html?single=1`);
    await solo.waitForSelector('[data-taskbar]');
    await solo.locator('button[aria-label="Пуск"]').click();
    await solo.waitForTimeout(350);
    const one = await solo.locator('[role="dialog"][aria-label="Пуск"]').boundingBox();
    const oneBar = await solo.locator('[data-taskbar]').boundingBox();
    assert.ok(one && oneBar && Math.abs(one.x - 8) < 1 && Math.abs(oneBar.y - (one.y + one.height) - 6) < 1.5, `в обычном окне как прежде (x=${one?.x}, зазор ${oneBar && one && oneBar.y - one.y - one.height})`);
    await solo.locator('[data-tray-toggle]').last().click();
    await solo.locator('[data-right-dock]').waitFor();
    await solo.waitForTimeout(350);
    const sd = await solo.locator('[data-right-dock]').boundingBox();
    assert.ok(sd && sd.x + sd.width >= 1590 && sd.y + sd.height <= oneBar!.y + 1, `один монитор: панели у правого края над панелью задач (правый край ${sd && sd.x + sd.width})`);
    assert.deepEqual(errors, []);
    console.log('start-monitor-ui: ok');
  } finally { await browser.close(); }
})().catch((e) => { console.error('✗', e); process.exit(1); });
