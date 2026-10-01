/** Значок обновления ведёт сотрудника к скачиванию; публиковать может только владелец. */
import { ownerTestLogin } from './fixtures/ownerTestLogin';
import { testSignature } from './fixtures/updateTestSign';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const VERSION = `999.8.${Date.now() % 1_000_000}`;
const EMPLOYEE_PASSWORD = 'update-ui-test-only';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

const api = async (token: string, method: string, url: string, body?: any, raw?: Buffer) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, json: null as any, text }; }
};

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

  const adminLogin = await api('', 'POST', '/api/login', ADMIN);
  const adminToken = adminLogin.json?.token || '';
  if (!adminToken) { console.error('Не удалось войти тестовым администратором.'); process.exit(2); }

  const suffix = Date.now().toString(36);
  const employeeSymbol = `upd-ui-${suffix}`;
  const created = await api(adminToken, 'POST', '/api/users', {
    symbol: employeeSymbol, lastName: 'Проверкин', firstName: 'Обновление',
    role: 'ENGINEER_VENT', password: EMPLOYEE_PASSWORD,
  });
  const employeeId = created.json?.id || created.json?.user?.id || '';
  if (created.status !== 200 && created.status !== 201 || !employeeId) {
    console.error('Не удалось создать тестового сотрудника.', created.status, created.json);
    process.exit(2);
  }

  let ownerToken = '';
  let browser: any;
  try {
    ownerToken = (await ownerTestLogin(BASE)).token;
    const employeeLogin = await api('', 'POST', '/api/login', { symbol: employeeSymbol, password: EMPLOYEE_PASSWORD });
    const employeeToken = employeeLogin.json?.token || '';
    if (!employeeToken) throw new Error('Не удалось войти тестовым сотрудником.');

    console.log('1. Сотрудник не может загрузить или опубликовать выпуск');
    const deniedUpload = await api(employeeToken, 'POST', `/api/updates/upload?version=${VERSION}`, undefined, Buffer.alloc(1024, 1));
    ok('загрузка файла сотрудником запрещена', deniedUpload.status === 403, deniedUpload.status);
    const deniedPublish = await api(employeeToken, 'POST', '/api/updates', {
      version: VERSION, changelog: 'Проверочный релиз', signature: 'неподписанный выпуск',
    });
    ok('публикация сотрудником запрещена', deniedPublish.status === 403, deniedPublish.status);

    console.log('2. Владелец загружает и публикует подписанный файл из общей базы');
    const size = 6 * 1024 * 1024;
    const executable = Buffer.alloc(size, 7);
    executable[0] = 0x4d;
    executable[1] = 0x5a;
    executable.write('UPDATE-UI-TEST', size - 32, 'utf8');
    const uploaded = await api(ownerToken, 'POST', `/api/updates/upload?version=${VERSION}`, undefined, executable);
    ok('файл с заголовком MZ записан в общую базу', uploaded.status === 200 && uploaded.json?.shared === true, uploaded.json || uploaded.status);
    const published = await api(ownerToken, 'POST', '/api/updates', {
      version: VERSION,
      changelog: 'Проверочный выпуск для интерфейса обновлений.',
      signature: testSignature(executable, VERSION),
    });
    ok('владелец опубликовал выпуск с подписью', published.status === 200, published.json || published.status);

    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
    const errors: string[] = [];
    page.on('pageerror', (e: any) => errors.push('исключение: ' + String(e.message).slice(0, 160)));
    page.on('console', (m: any) => { if (m.type() === 'error') errors.push('консоль: ' + m.text().slice(0, 160)); });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const symbolInput = page.locator('input').first();
    if (await symbolInput.isVisible().catch(() => false)) {
      await symbolInput.fill(employeeSymbol);
      await page.locator('input[type="password"]').first().fill(EMPLOYEE_PASSWORD);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    }

    console.log('3. Значок ведёт сотрудника к доступному выпуску');
    const badge = page.locator('button[title^="Доступно обновление"]').first();
    await badge.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
    ok('значок обновления появился', await badge.isVisible().catch(() => false));
    ok('в подсказке указана опубликованная версия',
      String(await badge.getAttribute('title') || '').includes(VERSION), await badge.getAttribute('title'));
    await badge.click();
    await page.waitForTimeout(2000);
    ok('значок открыл настройки обновлений',
      await page.getByText('Автообновления', { exact: false }).first().isVisible().catch(() => false));
    ok('в настройках показана новая версия',
      await page.getByText(`v${VERSION}`, { exact: false }).first().isVisible().catch(() => false));
    ok('сотруднику доступно скачивание файла',
      await page.getByRole('button', { name: 'Скачать файл', exact: true }).isVisible().catch(() => false));

    console.log('4. Интерфейс не предлагает сотруднику публикацию');
    ok('кнопок публикации нет',
      (await page.getByRole('button', { name: /Опубликовать|Загрузить выпуск|Выбрать exe/i }).count()) === 0);
    ok('полей выбора файла для публикации нет', (await page.locator('input[type="file"]:visible').count()) === 0);
    ok('в консоли нет ошибок', errors.length === 0, errors.slice(0, 3));
    await page.screenshot({ path: '/tmp/update-ui.png' });
  } catch (e: any) {
    f++;
    console.error('  ✗ ошибка сценария обновлений:', String(e?.message || e).slice(0, 300));
  } finally {
    await browser?.close().catch(() => {});
    if (ownerToken) {
      const gone = await api(ownerToken, 'DELETE', `/api/updates/${VERSION}`).catch(() => ({ status: 0 } as any));
      if (gone.status !== 200) console.error('  ! тестовый выпуск не отозван:', gone.status);
    }
    const removed = await api(adminToken, 'DELETE', `/api/users/${employeeId}`).catch(() => ({ status: 0 } as any));
    if (removed.status !== 200) console.error('  ! тестовый сотрудник не удалён:', removed.status);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка интерфейса обновлений пройдена');
  process.exit(f ? 1 : 0);
})();
