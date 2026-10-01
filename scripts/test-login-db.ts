/** Панель подключения принимает адрес Flux и не отправляет реквизиты базы из браузера. */
import { readConnection } from '../src/lib/connection';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DATABASE_URL = 'mysql://synthetic_user:synthetic-secret@127.0.0.1:1/Flux';

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
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (e: any) => errors.push('исключение: ' + String(e.message).slice(0, 140)));
  page.on('request', (request: any) => requests.push(request.url()));

  // Компания отвечает HTML вместо контракта API Flux. Перехват исключает
  // внешний запрос и проверяет реальный отказ от неподходящего сервера.
  await page.route('**/api/health', (route: any) => {
    if (route.request().url().startsWith('https://not-flux.example.test/api/health')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Другой сайт</html>' });
    }
    return route.continue();
  });

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    console.log('1. Клиент принимает только адрес сервера Flux');
    const connectionButton = page.getByRole('button', { name: 'Подключение · Этот компьютер', exact: true });
    ok('панель подключения видна под формой входа', await connectionButton.isVisible().catch(() => false));
    await connectionButton.click();
    const input = page.getByLabel('Адрес сервера Flux');
    ok('поле адреса сервера открылось', await input.isVisible().catch(() => false));
    ok('поле не скрывает адрес сервера', (await input.getAttribute('type')) !== 'password');
    ok('подсказка объясняет, что базу настраивает владелец',
      await page.getByText(/сама база данных не предоставляет интерфейс программы/i).isVisible().catch(() => false));

    console.log('2. Адрес базы отклоняется без сетевого запроса и утечки пароля');
    const beforeDbProbe = requests.length;
    await input.fill(DATABASE_URL);
    await page.getByRole('button', { name: 'Проверить и подключиться', exact: true }).click();
    await page.waitForTimeout(300);
    const databaseError = await page.getByRole('alert').innerText().catch(() => '');
    ok('показано безопасное объяснение', /адрес базы данных/i.test(databaseError), databaseError);
    ok('пароль и строка подключения не показаны в ошибке',
      !databaseError.includes('synthetic-secret') && !databaseError.includes(DATABASE_URL));
    ok('проверка базы не отправляла браузерный запрос',
      requests.slice(beforeDbProbe).every((url) => !/127\.0\.0\.1:1|synthetic_user|synthetic-secret/i.test(url)));
    ok('адрес сервера не сохранился',
      await page.evaluate(() => localStorage.getItem('flux_server_url') || '') === '');

    console.log('3. Отмена оставляет человека на форме входа');
    const beforeCancel = page.url();
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    ok('панель закрылась без перехода', await input.isVisible().catch(() => false) === false && page.url() === beforeCancel);
    ok('форма входа осталась на месте', await page.getByRole('button', { name: 'Войти', exact: true }).isVisible().catch(() => false));
    ok('выбранный сервер не изменился', await connectionButton.innerText() === 'Подключение · Этот компьютер');

    console.log('4. Без схемы для компании предполагается HTTPS, локальный адрес остаётся HTTP');
    ok('адрес компании по умолчанию получает HTTPS',
      JSON.stringify(readConnection('flux.company.test:3000')) === JSON.stringify({ kind: 'server', url: 'https://flux.company.test:3000' }));
    ok('localhost разрешает HTTP',
      JSON.stringify(readConnection('localhost:3000')) === JSON.stringify({ kind: 'server', url: 'http://localhost:3000' }));
    ok('127.0.0.1 разрешает HTTP', readConnection('http://127.0.0.1:3000').kind === 'server');
    ok('обычный адрес компании с HTTP отклоняется', readConnection('http://flux.company.test:3000').kind === 'error');

    console.log('5. Адрес без API Flux не сохраняется');
    await connectionButton.click();
    await input.fill('https://not-flux.example.test');
    const beforeCompanyProbe = requests.length;
    await page.getByRole('button', { name: 'Проверить и подключиться', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const serverError = await page.getByRole('alert').innerText().catch(() => '');
    ok('проверка объясняет, что на адресе нет API Flux', /нет API Flux/i.test(serverError), serverError);
    ok('единственный запрос проверки ушёл на заданный адрес',
      requests.slice(beforeCompanyProbe).some((url) => url === 'https://not-flux.example.test/api/health'));
    ok('неподходящий адрес не сохранился',
      await page.evaluate(() => localStorage.getItem('flux_server_url') || '') === '');
    ok('страница входа остаётся доступна', await page.getByRole('button', { name: 'Войти', exact: true }).isVisible().catch(() => false));

    ok('в консоли нет ошибок', errors.length === 0, errors.slice(0, 3));
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
