/**
 * Правая колонка на живом экране: не лезет на панель задач и держит обоих.
 *
 * Правила раскладки проверяет scripts/test-right-panels.ts, но правила можно
 * посчитать верно и всё равно нарисовать панель поверх часов — если разметка
 * не спросит правила. Поэтому здесь измеряется настоящий экран.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-panels-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  // Лицензия — не предмет этой пробы: без подмены экран активации закрывает
  // собой всё, и мерить нечего (так же сделано в остальных живых пробах)
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    // Вход тем же способом, что и в остальных живых пробах: поля ищутся по
    // порядку, а не по имени — экран входа рисуется не сразу
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    const box = async (sel: string) => page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    }, sel);

    console.log('1. Панель задач на месте и её видно');
    const bar = await box('[data-taskbar]');
    ok('панель задач найдена', !!bar, bar);

    console.log('2. Уведомления открываются и не накрывают панель задач');
    await page.click('[data-tour="notif-btn"]');
    await page.waitForTimeout(500);
    const dock1 = await box('[data-right-dock]');
    ok('колонка появилась', !!dock1, dock1);
    if (dock1 && bar) {
      ok('колонка кончается над панелью задач', dock1.bottom <= bar.top + 1, { колонка: dock1.bottom, панель: bar.top });
    }

    console.log('3. Помощник открывается, не закрывая уведомления');
    await page.click('[data-tour="assistant-btn"]');
    await page.waitForTimeout(500);
    const both = await page.evaluate(() => ({
      dock: !!document.querySelector('[data-right-dock]'),
      parts: document.querySelectorAll('[data-dock-part]').length,
    }));
    ok('в колонке две панели, а не одна', both.parts === 2, both);
    const dock2 = await box('[data-right-dock]');
    if (dock2 && bar) {
      ok('и вдвоём они не лезут на панель задач', dock2.bottom <= bar.top + 1, { колонка: dock2.bottom, панель: bar.top });
    }
    ok('между ними есть разделитель', await page.locator('[data-dock-divider]').count() === 1);

    console.log('4. На узком экране — вкладки, а не две панели впритык');
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(500);
    const narrow = await page.evaluate(() => ({
      parts: document.querySelectorAll('[data-dock-part]').length,
      tabs: document.querySelectorAll('[data-dock-tab]').length,
    }));
    ok('показана одна панель', narrow.parts === 1, narrow);
    ok('и две вкладки для переключения', narrow.tabs === 2, narrow);
  } catch (e: any) {
    f++;
    console.error('  ✗ проба не дошла до конца:', e?.message || e);
  } finally {
    await browser.close();
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка правой колонки на экране пройдена');
  process.exit(f ? 1 : 0);
})();
