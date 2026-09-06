/**
 * Живая проба закрепления программ из Пуска.
 *
 * Владелец сказал прямо: «закрепление и добавление программы из пуска на
 * рабочий стол и панель задач не работает корректно». Поломок оказалось две, и
 * обе не видны в коде по отдельности.
 *
 * Первая: значок, однажды убранный в папку, из списка закреплённых не исчезает
 * — прячет его отдельный состав папок. Закрепление выходило сразу («уже
 * закреплено»), папка продолжала прятать значок, и на столе не появлялось
 * ничего. Вторая: нажатие вообще ничем не отвечало — стол закрыт открытым
 * Пуском, и человек, ничего не увидев, нажимал ещё раз.
 *
 * Проверить это можно только на живой программе: обе поломки живут в связке
 * «хранилище — состав папок — разметка», а не в одной функции.
 *
 * Запуск: сначала `npx tsx server.ts`, потом `npx tsx scripts/test-pin-live.ts`
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

/** Раздел, который заведомо не закреплён у нового сотрудника */
const PATH = '/calendar';
const TITLE = 'Календарь';

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => /Проводник|Корзина/.test(document.body.innerText)));

    console.log('1. Значок спрятан в папке — закрепление обязано его вернуть');
    // Ставим то самое состояние, в котором кнопка молчала: путь уже в списке
    // закреплённых, но папка его прячет
    await page.evaluate((p: string) => {
      const apps = JSON.parse(localStorage.getItem('flux_desk_apps') || '[]');
      if (!apps.includes(p)) apps.push(p);
      localStorage.setItem('flux_desk_apps', JSON.stringify(apps));
      localStorage.setItem('flux_desk_groups', JSON.stringify([
        { id: 'g-test', name: 'Проба', items: [`app:${p}`, 'app:/registry', 'app:/equipment'] },
      ]));
    }, PATH);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    // Значок стола — единственный, у кого подсказка равна названию раздела и
    // кто лежит вне панели задач: у плитки Пуска подсказка длиннее
    const onDeskBefore = async () => page.evaluate((t: string) =>
      Array.from(document.querySelectorAll(`[title="${t}"]`))
        .some((el) => !el.closest('[data-taskbar]') && el.className.includes('absolute')), TITLE);
    ok('пока значок в папке, на столе его нет', !(await onDeskBefore()));

    // Пуск → правая кнопка по плитке → «Закрепить на рабочем столе»
    await page.click('[data-taskbar] button');
    await page.waitForTimeout(800);
    await page.click(`[role="dialog"][aria-label="Пуск"] [data-tour="nav-${PATH}"]`, { button: 'right' });
    await page.waitForTimeout(500);
    const item = await page.$('text=Закрепить на рабочем столе');
    ok('пункт «Закрепить на рабочем столе» предложен', !!item);
    if (item) await item.click();
    await page.waitForTimeout(1200);

    ok('Пуск закрылся, чтобы результат было видно',
      await page.evaluate(() => !document.body.innerText.includes('Найти раздел')));
    ok('о закреплении сказано словами',
      await page.evaluate((t: string) => document.body.innerText.includes(`«${t}» на рабочем столе`), TITLE));
    ok('значок вернулся из папки на стол', await onDeskBefore());
    ok('в составе папки его больше нет', await page.evaluate((p: string) => {
      const raw = JSON.parse(localStorage.getItem('flux_desk_groups') || '[]');
      return !raw.some((g: any) => (g.items || []).includes(`app:${p}`));
    }, PATH));

    console.log('2. Закрепление на панели задач ставит кнопку');
    await page.evaluate(() => {
      const bar = JSON.parse(localStorage.getItem('flux_bar_apps') || '[]');
      localStorage.setItem('flux_bar_apps', JSON.stringify(bar.filter((p: string) => p !== '/calendar')));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    // По названию искать нельзя: на тесной панели подписи прячутся, и кнопка
    // остаётся только значком. Метка раздела на кнопке есть всегда
    const onBar = async () => page.evaluate((p: string) =>
      !!document.querySelector(`[data-taskbar] [data-tour="nav-${p}"]`), PATH);
    ok('кнопки на панели пока нет', !(await onBar()));

    await page.click('[data-taskbar] button');
    await page.waitForTimeout(800);
    await page.click(`[role="dialog"][aria-label="Пуск"] [data-tour="nav-${PATH}"]`, { button: 'right' });
    await page.waitForTimeout(500);
    const barItem = await page.$('text=Закрепить на панели задач');
    ok('пункт «Закрепить на панели задач» предложен', !!barItem);
    if (barItem) await barItem.click();
    await page.waitForTimeout(1000);
    ok('кнопка появилась на панели', await onBar());
    ok('о закреплении на панели тоже сказано словами',
      await page.evaluate((t: string) => document.body.innerText.includes(`«${t}» на панели задач`), TITLE));
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    await browser.close();
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nЗакрепление программ на живой программе: все проверки пройдены');
})();
