import { chromium } from 'playwright-core';

async function main() {
const url = process.env.FLUX_UI_URL;
const executablePath = process.env.FLUX_CHROME;
if (!url || !executablePath) throw new Error('Нужны FLUX_UI_URL и FLUX_CHROME');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  for (const theme of ['light', 'dark']) {
    for (const solid of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
      await page.addInitScript(({ theme, solid }) => { try { localStorage.setItem('theme', theme); localStorage.setItem('flux_glass', solid ? '0' : '1'); } catch {} }, { theme, solid });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/WebSocket connection to .* failed|\[vite\] failed to connect to websocket/.test(message.text())) errors.push(message.text()); });
      await page.route('**/restart-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}" data-glass="${solid ? 'off' : 'on'}"><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root" style="height:650px"></div><script type="module" src="/scripts/module-restart-fixture.tsx"></script></body></html>` }));
      await page.goto(`${url}/restart-fixture`);
      await page.locator('iframe').waitFor({ timeout: 10000 });
      await page.evaluate(() => { (window as any).frameBefore = document.querySelector('iframe'); (window as any).frameBefore.dataset.calculation = 'kept'; (window as any).install('2.0.0'); });
      const button = page.getByRole('button', { name: 'Вышла версия 2.0.0 — Перезапустить' });
      await button.waitFor({ timeout: 5000 });
      const before = await page.evaluate(() => ({ same: (window as any).frameBefore === document.querySelector('iframe'), calculation: document.querySelector('iframe')?.dataset.calculation, version: document.querySelector('.fx-head-count')?.textContent }));
      if (!before.same || before.calculation !== 'kept' || before.version !== '1.0.0') throw new Error(`Расчёт изменился до перезапуска: ${JSON.stringify(before)}`);
      const geometry = await button.evaluate(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { width: r.width, height: r.height, fontSize: s.fontSize, color: s.color, background: s.backgroundColor }; });
      if (geometry.width <= 0 || geometry.height <= 0 || await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Кнопка скрыта или есть горизонтальная прокрутка');
      console.log(theme, solid ? 'solid' : 'glass', JSON.stringify(geometry));
      await page.screenshot({ path: `/tmp/flux-restart-${theme}-${solid ? 'solid' : 'glass'}.png` });
      await button.click();
      await page.waitForFunction(() => (window as any).frameBefore !== document.querySelector('iframe'));
      if (await page.locator('.fx-head-count').textContent() !== '2.0.0' || await button.count()) throw new Error('Новая версия не запущена по кнопке');
      // Каждый сценарий начинает новое окно с версией 1.0.0.
      await page.reload();
      await page.locator('iframe').waitFor();
      await page.evaluate(() => { (window as any).frameBefore = document.querySelector('iframe'); (window as any).install('2.0.0'); });
      await button.waitFor();
      await page.evaluate(() => (window as any).update('2.0.0', { releases: ['restart-test@1.0.0'], keys: [] }));
      await page.waitForFunction(() => (window as any).frameBefore !== document.querySelector('iframe') && document.querySelector('.fx-head-count')?.textContent === '2.0.0');
      if (await button.count()) throw new Error('Отзыв выпуска не применён сразу');
      await page.evaluate(() => (window as any).update('2.0.0', { releases: [], keys: ['key-a'] }));
      await page.getByText('Модуль недоступен').waitFor();
      if (await page.locator('iframe').count()) throw new Error('Отозванный автор продолжает работать');

      await page.reload();
      await page.locator('iframe').waitFor();
      await page.evaluate(() => (window as any).install('2.0.0'));
      await button.click();
      await page.waitForFunction(() => document.querySelector('.fx-head-count')?.textContent === '2.0.0');
      await page.evaluate(() => { (window as any).frameBefore = document.querySelector('iframe'); (window as any).update('1.0.0', { releases: [], keys: [] }, { 'restart-test:production': '1.0.0' }); });
      await page.waitForFunction(() => (window as any).frameBefore !== document.querySelector('iframe') && document.querySelector('.fx-head-count')?.textContent === '1.0.0');
      if (await page.getByRole('button', { name: /Перезапустить/ }).count()) throw new Error('Откат канала не применён сразу');
      await page.evaluate(() => (window as any).update(null));
      await page.getByText('Модуль недоступен').waitFor();
      if (await page.locator('iframe').count()) throw new Error('Удалённый модуль продолжает работать');
      if (errors.length) throw new Error(`Ошибки браузера: ${errors.join('; ')}`);
      await page.close();
    }
  }
} finally { await browser.close(); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
