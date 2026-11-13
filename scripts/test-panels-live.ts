import { testCredentials } from './testCredentials';
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
const LOGIN = testCredentials();
import { findChrome } from './chromePath';
const CHROME = findChrome();

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

    console.log('3. Помощник открывается, не закрывая уведомления, и не перекрывает их');
    await page.click('[data-tour="guide-btn"]');
    await page.waitForTimeout(500);
    const both = await page.evaluate(() => ({
      columns: document.querySelectorAll('[data-dock-column]').length,
      notif: !!document.querySelector('[data-dock-notifications]'),
      calendar: !!document.querySelector('[data-dock-calendar]'),
      assistant: !!document.querySelector('[data-dock-assistant]'),
    }));
    ok('в колонке две панели, а не одна', both.columns === 2 && both.notif && both.assistant, both);
    ok('под уведомлениями стоит календарь', both.calendar, both);
    const cols = await page.evaluate(() => [...document.querySelectorAll('[data-dock-column]')]
      .map((c) => { const r = c.getBoundingClientRect(); return { id: c.getAttribute('data-dock-column'), left: r.left, right: r.right, bottom: r.bottom }; })
      .sort((x, y) => x.left - y.left));
    ok('колонки рядом и не перекрываются', cols.length === 2 && cols[0].right <= cols[1].left + 0.5, cols);
    ok('помощник левее уведомлений', cols[0]?.id === 'assistant', cols);
    ok('и вдвоём они не лезут на панель задач', !!bar && cols.every((c) => c.bottom <= bar.top + 1), { cols, панель: bar?.top });

    console.log('4. На узком экране остаётся одна панель');
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(500);
    const narrow = await page.evaluate(() => document.querySelectorAll('[data-dock-column]').length);
    ok('показана одна панель', narrow === 1, narrow);
  } catch (e: any) {
    f++;
    console.error('  ✗ проба не дошла до конца:', e?.message || e);
  } finally {
    await browser.close();
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка правой колонки на экране пройдена');
  process.exit(f ? 1 : 0);
})();
