/** Проверяет подключение к MariaDB через mock Electron IPC без живой базы. */
import { readDatabaseConnection } from '../src/lib/connection';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DATABASE_URL = 'mysql://synthetic_user:synthetic-secret@db.example.test:3306/Flux';

let failures = 0;
const ok = (name: string, condition: boolean, details?: unknown) =>
  condition ? console.log('  ✓', name) : (failures++, console.error('  ✗', name, details === undefined ? '' : String(details).slice(0, 240)));

(async () => {
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core не установлен.'); process.exit(2); }
  try {
    const response = await fetch(BASE + '/api/health');
    if (!response.ok) throw new Error(`health ${response.status}`);
  } catch (error: any) {
    console.error(`Сервер на ${BASE} не отвечает (${error?.message || error}).`);
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error: any) => errors.push(String(error.message).slice(0, 140)));
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(message.text().slice(0, 140)); });
  page.on('request', (request: any) => requests.push(request.url()));
  await page.addInitScript(`(() => {
    const state = { calls: [], failProbe: false, configured: false };
    window.__mockDatabaseIpc = state;
    Object.defineProperty(window, 'electron', { configurable: true, writable: true, value: { ipcRenderer: { invoke: async (channel, uri) => {
      state.calls.push({ channel, uri });
      if (channel === 'app:get-database') return state.configured
        ? { configured: true, provider: 'mysql', host: 'db.example.test', database: 'Flux' }
        : { configured: false, provider: null, host: '', database: '' };
      if (channel === 'app:probe-database') return state.failProbe
        ? { success: false, error: 'Не удалось подключиться к базе. Проверьте доступ пользователя.' }
        : { success: true, provider: 'mysql', database: 'Flux' };
      if (channel === 'app:set-database') { state.configured = true; return { success: true, restart: true }; }
      if (channel === 'app:relaunch') return true;
      return undefined;
    } } } });
  })();`);

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    ok('mock Electron IPC доступен странице', await page.evaluate(() => typeof (window as any).electron?.ipcRenderer?.invoke === 'function'));
    const panel = page.getByRole('button', { name: 'Подключение к общей базе', exact: true });
    ok('панель общей базы показана на форме входа', await panel.isVisible().catch(() => false));
    await panel.click();
    const input = page.getByLabel('URI базы MariaDB/MySQL');
    ok('открывается поле URI MariaDB/MySQL', await input.isVisible().catch(() => false));
    ok('секрет URI скрыт полем ввода', await input.getAttribute('type') === 'password');

    console.log('1. Отклоняется неподдерживаемый URI без IPC-вызова');
    const initialCalls = await page.evaluate(() => (window as any).__mockDatabaseIpc.calls.length);
    await input.fill('postgresql://synthetic_user:synthetic-secret@db.example.test:5432/Flux');
    await page.getByRole('button', { name: 'Проверить и подключить' }).click();
    const invalidMessage = await page.getByRole('alert').innerText();
    ok('ошибка предлагает MariaDB/MySQL', /MariaDB\/MySQL/i.test(invalidMessage), invalidMessage);
    ok('некорректная строка не передана в IPC', await page.evaluate((before: number) => (window as any).__mockDatabaseIpc.calls.length === before, initialCalls));

    console.log('2. Ошибка пробы не сохраняет URI и не раскрывает пароль');
    await page.evaluate(() => { (window as any).__mockDatabaseIpc.failProbe = true; });
    await input.fill(DATABASE_URL);
    const beforeProbe = requests.length;
    await page.getByRole('button', { name: 'Проверить и подключить' }).click();
    await page.getByRole('alert').waitFor({ state: 'visible' });
    const probeError = await page.getByRole('alert').innerText();
    ok('показана безопасная ошибка подключения', /не удалось подключиться к базе/i.test(probeError), probeError);
    ok('ошибка не содержит пароль или URI', !probeError.includes('synthetic-secret') && !probeError.includes(DATABASE_URL));
    ok('ошибка пробы не вызывает apply', await page.evaluate(() => !(window as any).__mockDatabaseIpc.calls.some((call: any) => call.channel === 'app:set-database')));
    ok('браузер не отправляет URI сетевым запросом', requests.slice(beforeProbe).every(url => !/synthetic_user|synthetic-secret|db\.example\.test/i.test(url)));

    console.log('3. Успешная проверка применяет URI и показывает только сведения без секрета');
    await page.evaluate(() => { (window as any).__mockDatabaseIpc.failProbe = false; });
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await panel.click();
    await input.fill(DATABASE_URL);
    await page.getByRole('button', { name: 'Проверить и подключить' }).click();
    await page.getByRole('status').waitFor({ state: 'visible' });
    const body = await page.locator('body').innerText();
    ok('сохранённые реквизиты показаны без имени пользователя и пароля', body.includes('db.example.test/Flux') && !body.includes('synthetic_user') && !body.includes('synthetic-secret'));
    ok('URI отсутствует в localStorage', await page.evaluate(() => !Object.values(localStorage).some(value => /synthetic-secret|synthetic_user/.test(value))));
    const calls = await page.evaluate(() => (window as any).__mockDatabaseIpc.calls);
    ok('сначала вызвана probe, затем apply', calls.findIndex((call: any) => call.channel === 'app:probe-database') < calls.findIndex((call: any) => call.channel === 'app:set-database'));
    ok('оба вызова получили URI только через Electron IPC', calls.some((call: any) => call.channel === 'app:probe-database' && call.uri === DATABASE_URL) && calls.some((call: any) => call.channel === 'app:set-database' && call.uri === DATABASE_URL));
    ok('кнопка перезапуска появилась после успешного применения', await page.getByRole('button', { name: 'Перезапустить Flux' }).isVisible());

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 950 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((dark: boolean) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        await page.waitForTimeout(150);
        const sizing = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
        ok(`${theme} тема при ${width}px не прокручивается по горизонтали`, sizing.document <= sizing.viewport, sizing);
        await page.screenshot({ path: `/tmp/login-database-${theme}-${width}.png` });
      }
    }
    const appErrors = errors.filter(message => !/^\[vite\] failed to connect to websocket|^WebSocket connection to 'ws:\/\/localhost:24678|^WebSocket closed without opened\./.test(message));
    ok('в консоли нет ошибок приложения', appErrors.length === 0, appErrors.slice(0, 3));
  } finally { await browser.close(); }

  console.log(failures ? `\nПровалено проверок: ${failures}` : '\nПроверка подключения к общей базе пройдена');
  process.exit(failures ? 1 : 0);
})();
