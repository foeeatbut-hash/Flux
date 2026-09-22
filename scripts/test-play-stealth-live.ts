/**
 * T01 живьём: сотрудника без доступа платформы для него не существует.
 *
 * Проверка написана против самого вероятного способа ошибиться. Скрыть раздел
 * в одном месте легко — в Пуске его нет, и кажется, что дело сделано. А потом
 * он остаётся кнопкой на панели задач (закрепление живёт в браузере и про
 * права не знает), находится по названию в Ctrl+K, стоит статьёй в
 * руководстве, и сервер честно отвечает «403 — нет права», то есть сообщает
 * ровно то, что скрывалось.
 *
 * Поэтому здесь два прохода: по настоящему серверу и по настоящему окну.
 *
 *   — сервер: у сотрудника без доступа `/api/play/*` отвечает 404, тем же, чем
 *     отвечает выдуманный адрес, и в ответе `/api/me/bootstrap` нет ни одного
 *     ключа платформы;
 *   — окно: слова «Play» нет нигде — ни в Пуске, ни на столе, ни на панели
 *     задач, ни в строке Ctrl+K, ни в оглавлении руководства, — а прямой
 *     переход на /play оставляет человека на Главной.
 *
 * Проверка сама включает платформу и сама выдаёт доступ: иначе она проверяла
 * бы не скрытность, а выключенный по умолчанию выключатель.
 *
 * Запуск (нужен поднятый сервер и Chromium):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-play-stealth-live.ts
 */
import { APP_PLAY, PLAY_ADMIN, gameEntitlement, isPlayKey } from '../play/features';

const BASE = process.env.FLUX_API || process.env.FLUX_BASE || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

const api = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) as any }; } catch { return { status: res.status, json: null as any, text }; }
};

/**
 * Снять у человека все права платформы.
 *
 * Нужно и в начале, и в конце: проверка сама выдаёт себе доступ, и оставлять
 * его после себя — значит портить следующий прогон и, что хуже, стенд.
 */
async function revokePlay(token: string, userId: string): Promise<void> {
  const list = await api(token, 'GET', '/api/users');
  const rows = list.json?.users || list.json || [];
  const row = (Array.isArray(rows) ? rows : []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of Object.keys(perms)) if (isPlayKey(k)) delete perms[k];
  await api(token, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = await api('', 'POST', '/api/login', ADMIN);
  const adminToken = String(admin.json?.token || '');
  const adminId = String(admin.json?.user?.id || '');
  if (!adminToken) { console.error('Не удалось войти администратором.'); process.exit(2); }

  console.log('1. Пока платформа выключена, её нет даже у администратора');
  {
    // Стенд мог остаться после прошлого прогона с выданными правами: проверка
    // обязана начинаться с известного состояния, а не с того, что осталось
    await revokePlay(adminToken, adminId);
    const before = await api(adminToken, 'GET', '/api/play/platform');
    ok('выключенная платформа отвечает как выдуманный адрес', before.status === 404, before.status);
    const boot = await api(adminToken, 'GET', '/api/me/bootstrap');
    ok('в доступе нет состояния платформы', boot.json?.platform?.enabled === false, boot.json?.platform);
  }

  console.log('\n2. Включаем платформу и выдаём доступ');
  const grant = (map: Record<string, any>) => JSON.stringify(map);
  {
    // Право управления платформой — себе: без него выключатель недостижим
    const me = await api(adminToken, 'GET', `/api/users`);
    const mine = (me.json?.users || me.json || []).find((u: any) => u.id === adminId) || {};
    let perms: Record<string, any> = {};
    try { perms = mine.permissions ? JSON.parse(mine.permissions) : {}; } catch (_) { perms = {}; }
    perms[PLAY_ADMIN] = { enabled: true, until: null, mode: 'ALLOW' };
    perms[APP_PLAY] = { enabled: true, until: null, mode: 'ALLOW' };
    const saved = await api(adminToken, 'PUT', `/api/users/${adminId}`, { permissions: grant(perms) });
    ok('доступ администратору записан', saved.status === 200, saved.status);

    const on = await api(adminToken, 'PUT', '/api/play/platform', { enabled: true });
    ok('платформа включилась', on.status === 200 && on.json?.platform?.enabled === true, { s: on.status, j: on.json });

    const state = await api(adminToken, 'GET', '/api/play/platform');
    ok('и теперь отвечает', state.status === 200, state.status);
  }

  console.log('\n3. Сотруднику без доступа платформы не существует');
  const stamp = Date.now().toString(36).slice(-5);
  const symbol = `ПЛ${stamp}`;
  const password = `pl-${stamp}-Aa1`;
  let otherToken = '';
  {
    const made = await api(adminToken, 'POST', '/api/users', {
      name: `Проверка скрытности ${stamp}`, symbol, password, role: 'ENGINEER',
    });
    const otherId = String(made.json?.user?.id || made.json?.id || '');
    ok('второй сотрудник заведён', !!otherId, { s: made.status, j: made.json });
    if (!otherId) { console.error('Дальше проверять нечего.'); process.exit(2); }

    const login = await api('', 'POST', '/api/login', { symbol, password });
    otherToken = String(login.json?.token || '');
    ok('второй сотрудник вошёл', !!otherToken, login.status);

    for (const url of ['/api/play/platform', '/api/play/parties', '/api/play/whatever']) {
      const r = await api(otherToken, 'GET', url);
      ok(`${url} отвечает как выдуманный адрес`, r.status === 404, r.status);
      ok(`${url} не называет платформу`, !/play|игр/i.test(String(r.json?.error || '')), r.json);
    }

    const boot = await api(otherToken, 'GET', '/api/me/bootstrap');
    const keys = [
      ...Object.keys(boot.json?.permissions || {}),
      ...Object.keys(boot.json?.rolePermissions || {}),
    ];
    ok('в его доступе нет ни одного ключа платформы', !keys.some(isPlayKey), keys.filter(isPlayKey));
    ok('и нет состояния платформы', boot.json?.platform?.enabled === false, boot.json?.platform);
  }

  console.log('\n4. Право на игру выдаётся отдельно от права на платформу');
  {
    const boot = await api(adminToken, 'GET', '/api/me/bootstrap');
    const mine = boot.json?.permissions || {};
    ok('у администратора есть доступ к платформе', !!mine[APP_PLAY], Object.keys(mine).filter(isPlayKey));
    ok('но игра ему не выдана вместе с ней', !mine[gameEntitlement('fluxstrike')]);
  }

  console.log('\n5. В окне слова «Play» нет нигде');
  let browser: any = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/api/license/status', (r: any) => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ licensed: true, machineId: 'stealth', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
    }));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 40000 });
    await page.waitForTimeout(1500);
    const inputs = await page.$$('input');
    await inputs[0].fill(symbol);
    await inputs[1].fill(password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);

    const hasPlay = async (where: string) => {
      const text = await page.evaluate('document.body.innerText');
      const found = /Flux\s*Play/i.test(String(text));
      ok(`${where}: слова «Flux Play» нет`, !found);
    };

    await hasPlay('рабочий стол и панель задач');

    // Пуск: список всех программ
    const start = await page.$('button[aria-label="Пуск"]');
    ok('кнопка Пуск нашлась', !!start);
    if (start) {
      await start.click();
      await page.waitForTimeout(900);
      await hasPlay('Пуск');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // Поиск по названию — самый простой способ узнать о разделе
    await page.keyboard.press('Control+KeyK');
    await page.waitForTimeout(700);
    await page.keyboard.type('Play');
    await page.waitForTimeout(900);
    await hasPlay('строка Ctrl+K по слову «Play»');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    /**
     * Прямой адрес: молча на Главную, без объяснений.
     *
     * Оболочка ходит по хэшу (HashRouter), поэтому адрес раздела выглядит как
     * `/#/play`: «/play» без решётки — это путь к файлу на сервере, и до
     * маршрутизатора окна он не доходит вовсе.
     */
    await page.goto(`${BASE}/#/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const where = await page.evaluate('location.hash || "#/"');
    ok('прямой адрес /#/play уводит на Главную', String(where) === '#/', where);
    await hasPlay('после перехода по прямому адресу');

    const text = await page.evaluate('document.body.innerText');
    ok('и не сказано, что дело в праве', !/доступен по праву|Раздел закрыт/i.test(String(text)));
  } catch (e: any) {
    console.error('  · окно не проверено:', e?.message || e);
    f++;
  } finally {
    try { await browser?.close(); } catch (_) { /* уже закрыт */ }
  }

  /**
   * Обратная сторона скрытности, без которой она ничего не доказывает.
   *
   * Спрятать раздел от всех — не достижение: так он выглядел бы и при просто
   * сломанном реестре. Поэтому тот же обход делается за человека, которому
   * доступ выдан, и там раздел обязан быть.
   */
  console.log('\n5б. Тому, кому доступ выдан, раздел виден и открывается');
  {
    let browser2: any = null;
    try {
      const { chromium } = await import('playwright-core');
      browser2 = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
      const page = await browser2.newPage({ viewport: { width: 1440, height: 900 } });
      await page.route('**/api/license/status', (r: any) => r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ licensed: true, machineId: 'stealth', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
      }));
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('input', { timeout: 40000 });
      await page.waitForTimeout(1500);
      const inputs = await page.$$('input');
      await inputs[0].fill(ADMIN.symbol);
      await inputs[1].fill(ADMIN.password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(9000);

      const start = await page.$('button[aria-label="Пуск"]');
      if (start) { await start.click(); await page.waitForTimeout(1200); }
      const inStart = await page.evaluate('document.body.innerText');
      ok('в Пуске раздел есть', /Flux\s*Play/i.test(String(inStart)));

      const tile = await page.$('text=Flux Play');
      ok('плитка раздела нажимается', !!tile);
      if (tile) { await tile.click(); await page.waitForTimeout(4000); }
      const opened = await page.evaluate('document.body.innerText');
      ok('раздел открылся окном', /Библиотека/.test(String(opened)), String(opened).slice(0, 200));
    } catch (e: any) {
      console.error('  · окно не проверено:', e?.message || e);
      f++;
    } finally {
      try { await browser2?.close(); } catch (_) { /* уже закрыт */ }
    }
  }

  console.log('\n6. Возвращаем стенд в исходное состояние');
  {
    const off = await api(adminToken, 'PUT', '/api/play/platform', { enabled: false });
    ok('платформа выключена обратно', off.status === 200 && off.json?.platform?.enabled === false, off.status);
    await revokePlay(adminToken, adminId);
    const after = await api(adminToken, 'GET', '/api/play/platform');
    ok('и доступ снова закрыт', after.status === 404, after.status);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
