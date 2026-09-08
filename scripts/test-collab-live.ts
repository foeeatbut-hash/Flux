/**
 * Совместная работа вживую: два окна в одном документе, включая обрыв связи.
 *
 * Правила обрыва и возвращения проверяются без браузера (scripts/test-collab.ts),
 * но самое дорогое здесь — не правило, а связка: комната, движок и
 * автосохранение. Её нельзя проверить рассуждением, потому что ломается она
 * незаметно. Так и нашлось, что окно, получившее правку коллеги операциями,
 * тут же получало отказ на собственное автосохранение: «документ изменился» —
 * хотя изменился он ровно на то, что это окно и показало.
 *
 * Проверяется три вещи:
 *   1. присутствие — каждое окно видит второго участника;
 *   2. живая правка — напечатанное в одном окне появляется во втором;
 *   3. обрыв и возвращение — окно без связи не теряет чужую работу и не
 *      кладёт свою страницу поверх неё.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-collab-live.ts
 *
 * За собой убираем: заведённый документ уходит в корзину в конце, даже при сбое.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

let token = '';
const api = async (method: string, url: string, body?: any) => {
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
  catch { console.error('playwright-core не установлен. Поставьте: npm i --no-save playwright-core'); process.exit(2); }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  token = (await api('POST', '/api/login', LOGIN)).json?.token || '';
  const projectId = (await api('GET', '/api/projects')).json?.projects?.[0]?.id;
  if (!token || !projectId) { console.error('Не удалось войти или в базе нет проекта.'); process.exit(2); }

  const made = await api('POST', '/api/constructor/docs', {
    projectId, name: `Проверка совместной работы ${Date.now().toString(36)}`, kind: 'TEXT', scope: 'SHARED',
  });
  const docId: string = made.json?.doc?.id || '';
  if (!docId) { console.error('Документ для проверки не завёлся.', made.json || made.status); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  /** Открыть документ в отдельном окне (свой контекст = свой сеанс браузера) */
  const open = async (label: string) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on('pageerror', (e: any) => errs.push('исключение: ' + String(e.message).slice(0, 140)));
    page.on('console', (m: any) => { if (m.type() === 'error') errs.push('консоль: ' + m.text().slice(0, 140)); });
    // Лицензия проверяется подписью, приватного ключа в репозитории нет —
    // подменяем только ответ проверки, код программы не трогаем
    await page.route('**/api/license/status', (r: any) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
    }));
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const sym = page.locator('input').first();
    if (await sym.isVisible().catch(() => false)) {
      await sym.fill(LOGIN.symbol);
      await page.locator('input[type="password"]').first().fill(LOGIN.password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
    }
    await page.goto(`${BASE}/#/sheet?doc=${docId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);
    if (errs.length) console.log(`  [${label}] в консоли:`, errs.slice(0, 3));
    return { ctx, page, errs };
  };

  /** Счётчик знаков в строке состояния: это содержимое ИМЕННО ЭТОГО окна */
  const charsOf = async (page: any): Promise<number> => {
    const t = await page.locator('text=знаков').first().innerText().catch(() => '');
    const m = String(t).match(/(\d+)\s+знаков/);
    return m ? Number(m[1]) : -1;
  };
  const conflictShown = (page: any) =>
    page.getByText('Документ изменился', { exact: false }).first().isVisible().catch(() => false);

  try {
    const a = await open('A');
    const b = await open('B');

    console.log('1. Присутствие');
    await a.page.waitForTimeout(2500);
    const sees = async (p: any) => p.locator('[title^="В документе:"]').first().isVisible().catch(() => false);
    ok('окно A видит второго участника', await sees(a.page));
    ok('окно B видит второго участника', await sees(b.page));

    console.log('2. Живая правка');
    const MARK = `ЖИВАЯ-${Date.now().toString(36).toUpperCase().slice(-4)}`;
    await a.page.locator('canvas').first().click({ position: { x: 260, y: 160 } }).catch(() => {});
    await a.page.keyboard.type(MARK, { delay: 60 });
    await a.page.waitForTimeout(4500);
    ok('текст появился во втором окне', (await charsOf(b.page)) === MARK.length, {
      вОкнеB: await charsOf(b.page), ждали: MARK.length,
    });
    const saved = await api('GET', `/api/constructor/docs/${docId}`);
    ok('правка дошла до сервера', String(saved.json?.doc?.workbook || '').includes(MARK));
    ok('окно A не показывает столкновение', !(await conflictShown(a.page)));
    ok('окно B, принявшее чужую правку, не показывает столкновение', !(await conflictShown(b.page)));

    console.log('3. Обрыв связи и возвращение');
    await b.ctx.setOffline(true);
    await b.page.waitForTimeout(2500);
    ok('окно без связи говорит об этом', await b.page.getByText('связь потеряна', { exact: false })
      .first().isVisible().catch(() => false));

    const MARK2 = ` ПОКА-ОФФЛАЙН`;
    await a.page.keyboard.type(MARK2, { delay: 60 });
    await a.page.waitForTimeout(4000);

    await b.ctx.setOffline(false);
    await b.page.waitForTimeout(14000);
    // Сверяем окна между собой, а не с длиной строки: счётчик знаков считает
    // по своим правилам (пробел на стыке абзаца в счёт не идёт), и важно
    // именно то, что оба окна показывают одно и то же
    const inA = await charsOf(a.page);
    const inB = await charsOf(b.page);
    ok('вернувшееся окно догнало чужую работу', inB === inA && inA > MARK.length, { вОкнеA: inA, вОкнеB: inB });
    if (await conflictShown(b.page)) {
      await b.page.screenshot({ path: '/tmp/collab-b-conflict.png' });
      console.log('    [B] окно столкновения:', (await b.page.locator('[role="dialog"]').first().innerText().catch(() => '')).slice(0, 300));
    }
    ok('вернувшееся окно не показывает столкновение', !(await conflictShown(b.page)));

    const after = await api('GET', `/api/constructor/docs/${docId}`);
    const body = String(after.json?.doc?.workbook || '');
    ok('работа, сделанная при потерянной связи, не затёрта', body.includes(MARK.trim()) && body.includes(MARK2.trim()),
      body.slice(0, 200));

    await browser.close();
  } finally {
    await api('PUT', `/api/constructor/docs/${docId}`, { deleted: true, force: true });
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nЖивая проверка совместной работы пройдена');
  process.exit(f ? 1 : 0);
})();
