/**
 * Экран входа: одно поле подключения, которое само понимает, что в него вставили.
 *
 * История. Сначала поле было одно — «сервер компании», — и в него вписали
 * строку подключения к базе: программа перестала работать целиком. Тогда
 * вопросы развели на две кнопки с отдельными окнами, и подключение стало
 * требовать лишних действий каждый раз. Теперь поле снова одно, но строка
 * распознаётся (src/lib/connection.ts): база — подключается как база, адрес
 * сервера — как сервер, негодное — объясняется и не сохраняется.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-login-db.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Порт 1 на своей машине — база, которая гарантированно не ответит, и быстро
const DSN = 'mysql://Flux:се@крет]1@127.0.0.1:1/Flux';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

(async () => {
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core не установлен.'); process.exit(2); }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errs: string[] = [];
  page.on('pageerror', (e: any) => errs.push('исключение: ' + String(e.message).slice(0, 140)));
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);

    console.log('1. Одна строка подключения под формой');
    const btn = page.locator('button[title="Где программа берёт данные"]');
    ok('строка подключения одна', (await btn.count()) === 1, await btn.count());
    ok('в ней сказано, где данные', /Подключение:/.test(await btn.innerText().catch(() => '')), await btn.innerText().catch(() => ''));
    ok('старых кнопок «сервер» и «база» нет',
      (await page.locator('button[title="Настроить подключение к серверу"], button[title^="Где лежат данные"]').count()) === 0);

    console.log('2. Строка базы распознаётся без показа пароля');
    await btn.click();
    await page.waitForTimeout(500);
    const input = page.locator('input[placeholder^="mysql://"]');
    ok('поле открылось', await input.isVisible().catch(() => false));
    ok('строка вводится скрытой', (await input.getAttribute('type')) === 'password');
    await input.fill(DSN);
    await page.waitForTimeout(300);
    const hint = await page.evaluate(() => document.body.innerText);
    ok('распознано как база MariaDB/MySQL', hint.includes('База MariaDB / MySQL · 127.0.0.1:1 · Flux'), hint.slice(-400));
    ok('пароля в подсказке нет', !hint.includes('се@крет'));

    console.log('3. Адрес сервера распознаётся как сервер');
    await input.fill('192.168.1.100:3000');
    await page.waitForTimeout(300);
    ok('распознано как сервер компании', (await page.evaluate(() => document.body.innerText)).includes('Сервер компании · http://192.168.1.100:3000'));

    console.log('4. Недоступная база — объяснение, а не поломка');
    await input.fill(DSN);
    await page.getByRole('button', { name: 'Подключиться' }).click();
    await page.waitForSelector('.fx-error', { timeout: 60000 }).catch(() => null);
    const err = await page.locator('.fx-error').innerText().catch(() => '');
    ok('ошибка показана прямо в панели', !!err, err);
    ok('адрес сервера не сохранён',
      await page.evaluate(() => localStorage.getItem('flux_server_url') || '') === '',
      await page.evaluate(() => localStorage.getItem('flux_server_url')));
    const cfg = await (await fetch(BASE + '/api/db/config')).json().catch(() => ({}));
    ok('база не переключена на недоступную', !String(cfg.database_url || '').includes('127.0.0.1:1'), cfg.database_url);
    ok('страница жива', await btn.isVisible().catch(() => false));

    console.log('5. Негодное — объясняется');
    await input.fill('sqlite:///C:/x.sqlite');
    await page.getByRole('button', { name: 'Подключиться' }).click();
    await page.waitForTimeout(300);
    // На локальной базе кнопки «Этот компьютер» нет — и отсылать к ней нельзя
    ok('про файл базы сказано честно', /этом компьютере/.test(await page.locator('.fx-error').innerText().catch(() => '')));
    ok('в консоли пусто', errs.length === 0, errs.slice(0, 3));

    await page.screenshot({ path: '/tmp/login-connection-light.png' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/login-connection-dark.png' });
  } finally {
    await browser.close();
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка экрана входа пройдена');
  process.exit(f ? 1 : 0);
})();
