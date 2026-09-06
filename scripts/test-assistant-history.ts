/**
 * История разговоров помощника — вживую, в окне.
 *
 * Правила имени, поиска и разбивки по дням проверены отдельно
 * (scripts/test-assistant-chats.ts), доступ — вдвоём (test-assistant-privacy).
 * Здесь проверяется то, чего ни та ни другая не видит: разговор сохраняется
 * САМ, без кнопки. Это и есть главное обещание: человек закрывает помощника не
 * задумываясь, и всё, что он не нажал, для него пропало бы.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-assistant-history.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

(async () => {
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core не установлен. Поставьте: npm i --no-save playwright-core'); process.exit(2); }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const token = (await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LOGIN),
  })).json()).token;
  if (!token) { console.error('Не удалось войти.'); process.exit(2); }
  const chatsOf = async () => (await (await fetch(BASE + '/api/assistant/chats', {
    headers: { Authorization: `Bearer ${token}` },
  })).json()).chats || [];

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errs: string[] = [];
  page.on('pageerror', (e: any) => errs.push('исключение: ' + String(e.message).slice(0, 160)));
  page.on('console', (m: any) => { if (m.type() === 'error') errs.push('консоль: ' + m.text().slice(0, 160)); });
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));
  
  const QUESTION = `покажи дубли ${Date.now().toString(36).slice(-4)}`;
  let savedId = '';
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const sym = page.locator('input').first();
    if (await sym.isVisible().catch(() => false)) {
      await sym.fill(LOGIN.symbol);
      await page.locator('input[type="password"]').first().fill(LOGIN.password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4500);
    }
    await page.goto(BASE + '/#/assistant', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('1. Окно помощника с историей');
    ok('список разговоров на месте', await page.getByPlaceholder('Найти в разговорах').isVisible());
    ok('про личное сказано прямо',
      await page.getByText('Разговоры видите только вы', { exact: false }).isVisible());

    console.log('2. Разговор сохраняется сам');
    await page.locator('input[placeholder^="Спросите"]').first().click();
    await page.keyboard.type(QUESTION, { delay: 40 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    const saved = (await chatsOf()).find((c: any) => c.title === QUESTION);
    savedId = saved?.id || '';
    ok('разговор оказался в базе без единого нажатия «сохранить»', !!saved);
    ok('именем разговора стала фраза человека', saved?.title === QUESTION, saved?.title);
    ok('в списке слева видно имя разговора',
      await page.locator('.overflow-y-auto').getByText(QUESTION, { exact: false }).first()
        .isVisible().catch(() => false));

    console.log('3. Поиск находит слово из середины разговора');
    // Второй вопрос — то самое слово, которого нет в названии разговора
    await page.locator('input[placeholder^="Спросите"]').first().click();
    await page.keyboard.type('что не заказано', { delay: 40 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await page.getByPlaceholder('Найти в разговорах').fill('заказано');
    await page.waitForTimeout(2500);
    ok('разговор найден по слову не из названия',
      await page.locator('.overflow-y-auto').getByText(QUESTION, { exact: false }).first()
        .isVisible().catch(() => false));
    await page.getByPlaceholder('Найти в разговорах').fill('');
    await page.waitForTimeout(1200);

    console.log('4. Ctrl+N и возврат');
    const before = await page.evaluate((q: string) => document.body.innerText.split(q).length - 1, QUESTION);
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(1500);
    const after = await page.evaluate((q: string) => document.body.innerText.split(q).length - 1, QUESTION);
    ok('Ctrl+N очищает переписку', after < before, { до: before, после: after });
    ok('но разговор из истории не пропал', (await chatsOf()).some((c: any) => c.id === savedId));

    await page.locator('.overflow-y-auto').getByText(QUESTION, { exact: false }).first().click();
    await page.waitForTimeout(2500);
    const back = await page.evaluate((q: string) => document.body.innerText.split(q).length - 1, QUESTION);
    ok('старый разговор открывается обратно', back >= before - 1, { было: before, стало: back });

    ok('в консоли пусто', errs.length === 0, errs.slice(0, 3));
  } finally {
    await browser.close();
    // Сначала закрываем браузер, потом убираем данные: разговор досохраняется
    // с задержкой, и удалённый при живой странице появился бы снова
    if (savedId) {
      await fetch(`${BASE}/api/assistant/chats/${savedId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка истории разговоров в окне пройдена');
  process.exit(f ? 1 : 0);
})();
