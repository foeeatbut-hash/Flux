import { testCredentials } from './testCredentials';
/**
 * Календарь не выбрасывает из программы.
 *
 * Проверка написана по поломке, которую владелец описал так: «проваливаемся в
 * календарь, программа выходит, и появляется окно входа». Причина оказалась в
 * одной строке: окно события подставляло токен руками и брало его из неверного
 * ключа хранилища. Заголовок уходил пустым, сервер отвечал «требуется вход», а
 * общая обёртка считала это концом сессии и вела человека на экран входа —
 * ровно в тот момент, когда он открывал встречу.
 *
 * Поэтому проверяется не «открылось ли окно», а два следствия: человек остался
 * в программе и в списке гостей есть живые люди.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-calendar-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const unauthorized: string[] = [];
  page.on('response', (r: any) => {
    if (r.status() === 401 && /\/api\//.test(r.url())) unauthorized.push(new URL(r.url()).pathname);
  });

  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.locator('input').first().fill(LOGIN.symbol);
    await page.locator('input[type="password"]').first().fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);

    console.log('1. Календарь открывается');
    await page.goto(BASE + '/#/calendar', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    ok('раздел открылся', await page.getByText('Календарь', { exact: false }).first().isVisible().catch(() => false));

    console.log('2. Окно события не выбрасывает из программы');
    // Заводим событие: именно здесь запрашивается список людей для гостей
    const add = page.getByRole('button', { name: /Событие|Создать|Добавить/ }).first();
    if (await add.isVisible().catch(() => false)) await add.click();
    else await page.locator('canvas, [role="gridcell"], button').filter({ hasText: /^\d+$/ }).first()
      .dblclick().catch(() => {});
    await page.waitForTimeout(3000);

    const onLogin = await page.getByPlaceholder('Введите логин').isVisible().catch(() => false);
    ok('человек остался в программе, а не на экране входа', !onLogin);
    ok('ни один запрос не получил «требуется вход»', unauthorized.length === 0, unauthorized);

    console.log('3. Список людей для приглашения пришёл');
    const users = await page.evaluate(async () => {
      const r = await fetch('/api/users');
      const d = await r.json().catch(() => ({}));
      return { status: r.status, count: (d.users || d || []).length || 0 };
    });
    ok('список сотрудников отдаётся с токеном', users.status === 200, users);
    ok('в списке есть люди', users.count > 0, users);

    await page.screenshot({ path: '/tmp/calendar-live.png' });
  } finally {
    await browser.close();
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка календаря пройдена');
  process.exit(f ? 1 : 0);
})();
