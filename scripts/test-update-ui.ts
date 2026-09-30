/**
 * Обновление в интерфейсе: значок у часов и кнопка в настройках.
 *
 * Само скачивание и подмену exe в контейнере не проверить — это Windows и
 * портативная сборка. Но всё, что до них, проверить можно и нужно: узнаёт ли
 * оболочка о новой версии без захода в настройки, светится ли значок у часов,
 * ведёт ли он в раздел обновлений и одна ли там кнопка вместо двух шагов.
 *
 * Именно эта часть и не работала: о новой версии узнавал только тот, кто сам
 * заходил в настройки и нажимал «Проверить».
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-update-ui.ts
 */
import { testSignature } from './fixtures/updateTestSign';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

const api = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
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

  const token = (await api('', 'POST', '/api/login', LOGIN)).json?.token || '';
  if (!token) { console.error('Не удалось войти.'); process.exit(2); }

  // Публикуем заведомо более новую версию: прямой ссылкой, файла на сервере
  // нет — так проверяется и то, что отказ объясняется словами
  const VERSION = '999.0.0';
  const published = await api(token, 'POST', '/api/updates', {
    version: VERSION,
    changelog: 'Проверочный релиз. Его нужно удалить после прогона.',
    fileUrl: 'https://example.invalid/Flux.exe',
    // Подпись обязательна; проверочная — годится только серверу из исходников
    signature: testSignature(Buffer.from('MZ'), VERSION),
  });
  if (published.status !== 200) { console.error('Релиз не опубликовался', published.status, published.json); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errs: string[] = [];
  page.on('pageerror', (e: any) => errs.push('исключение: ' + String(e.message).slice(0, 160)));
  page.on('console', (m: any) => { if (m.type() === 'error') errs.push('консоль: ' + m.text().slice(0, 160)); });
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const sym = page.locator('input').first();
    if (await sym.isVisible().catch(() => false)) {
      await sym.fill(LOGIN.symbol);
      await page.locator('input[type="password"]').first().fill(LOGIN.password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    }

    console.log('1. Значок обновления у часов');
    // Оболочка проверяет обновления сама, через несколько секунд после входа
    const badge = page.locator('button[title^="Доступно обновление"]').first();
    await badge.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
    ok('значок появился сам, без захода в настройки', await badge.isVisible().catch(() => false));
    ok('в подсказке названа версия',
      String(await badge.getAttribute('title') || '').includes(VERSION),
      await badge.getAttribute('title'));

    console.log('2. Нажатие ведёт в раздел обновлений');
    await badge.click();
    await page.waitForTimeout(3000);
    ok('открылся раздел обновлений',
      await page.getByText('Автообновления', { exact: false }).first().isVisible().catch(() => false));
    ok('видна доступная версия',
      await page.getByText(`v${VERSION}`, { exact: false }).first().isVisible().catch(() => false));

    console.log('3. Одна кнопка вместо двух шагов');
    const one = page.getByRole('button', { name: /Скачать/ });
    ok('кнопка скачивания одна', (await one.count()) >= 1, await one.count());
    ok('кнопки «Установить & Перезапустить» больше нет',
      (await page.getByRole('button', { name: /Установить & Перезапустить/ }).count()) === 0);
    ok('в консоли пусто', errs.length === 0, errs.slice(0, 3));

    await page.screenshot({ path: '/tmp/update-ui.png' });
  } finally {
    await browser.close();
    // Проверочный релиз отзываем: оставить 999.0.0 в списке значило бы
    // зажечь значок обновления у всех сотрудников
    const gone = await api(token, 'DELETE', `/api/updates/${VERSION}`);
    if (gone.status !== 200) console.error('  ! проверочный релиз не отозвался:', gone.status, gone.json);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка обновления в интерфейсе пройдена');
  process.exit(f ? 1 : 0);
})();
